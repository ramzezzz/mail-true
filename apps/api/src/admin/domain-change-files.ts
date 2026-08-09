/**
 * Письма и индексы при смене домена: измерить, проверить место, перенести.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПЕРЕИМЕНОВАНИЕ, А НЕ КОПИРОВАНИЕ
 * ------------------------------------------------------------------
 * Домен в хранилище — это имя каталога первого уровня:
 * `/var/mail/vhosts/<домен>/<логин>` (mail_location Dovecot). Обе стороны
 * переезда — `…/vhosts/старый` и `…/vhosts/новый` — лежат в одном и том же
 * томе, у одного и того же родителя. Значит перенос это ОДИН вызов
 * rename(2): атомарный, мгновенный при любом объёме и не требующий ни
 * байта свободного места.
 *
 * Копирование здесь было бы не «надёжнее», а строго хуже: на ящиках в
 * сотни гигабайт оно означает часы простоя вместо секунд, требует второй
 * такой же объём на диске и оставляет окно, в котором письма существуют в
 * двух местах и неизвестно, какое из них правильное.
 *
 * ------------------------------------------------------------------
 * А ЕСЛИ КАТАЛОГИ НА РАЗНЫХ УСТРОЙСТВАХ
 * ------------------------------------------------------------------
 * Такое бывает: каталог домена смонтирован отдельным томом. rename(2)
 * через границу файловых систем не работает — ядро отвечает EXDEV.
 *
 * Здесь было написано, что копирование «всё же предусмотрено», проверка
 * места честно требовала весь объём под него, план предупреждал «письма
 * придётся копировать», — а копирования в moveDomainDirectories не было
 * ни строки, только rename. То есть на таком сервере план проходил все
 * проверки, обещал перенос и падал EXDEV уже ПОСЛЕ отметки точки
 * невозврата (domain-change-runner.ts): домен нового имени заведён,
 * почта осталась под старым, а панель говорит «назад нельзя».
 *
 * Выбрано ЧЕСТНО ОТКАЗАТЬСЯ ЗАРАНЕЕ, а не дописать копирование. Причины:
 *
 *   * копирование сотен гигабайт внутри задания — это часы простоя, и
 *     всё это время почта не работает ни по старому имени, ни по новому.
 *     Такой переезд человек обязан планировать сам, а не узнавать о нём
 *     из полосы прогресса;
 *   * откат копирования — это удаление половины скопированного, то есть
 *     самая опасная операция из возможных, и делать её автоматически
 *     после точки невозврата нельзя;
 *   * перенести каталог между томами руками (rsync, mv) администратор
 *     умеет и сделает это в удобное окно, с проверкой. После этого смена
 *     домена снова становится мгновенным переименованием.
 *
 * Поэтому разные устройства — это ПРЕПЯТСТВИЕ в плане (crossDeviceBlocker),
 * которое видно до нажатия, и отказ в самом переносе (на случай, если
 * тома переставили между планом и запуском) — но всегда ДО того, как
 * что-либо тронуто.
 *
 * ------------------------------------------------------------------
 * ЧТО С ОТКРЫТЫМИ СЕАНСАМИ
 * ------------------------------------------------------------------
 * Переименование каталога не трогает уже открытые файлы: их описатели
 * ведут к тем же inode. А вот новое обращение ПО ПУТИ (доставка письма,
 * открытие папки) в момент переезда не найдёт каталога и получит ошибку.
 * Для Postfix это не потеря: недоставленное письмо остаётся в очереди и
 * приезжает следующей попыткой. Для человека в веб-почте — обрыв, который
 * лечится обновлением страницы. Это и есть тот самый простой, который
 * панель обещает в плане секундами.
 */
import { readdir, readFile, rename, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { directorySize, parseMaildirsize, volumeUsage } from './metrics-disk.js';

/** Что нашлось в каталоге домена. */
export interface DomainStorage {
  /** Каталог существует и читается. */
  present: boolean;
  path: string;
  mailboxes: number;
  messages: number;
  bytes: number;
  /** Ящики без файла учёта Dovecot — их объём в сумму не попал. */
  withoutAccounting: number;
  indexPath: string;
  indexPresent: boolean;
  indexBytes: number;
}

/**
 * Объём домена по учёту Dovecot.
 *
 * Считаем по maildirsize, а не обходом: обход `/var/mail/vhosts/<домен>` —
 * это stat на каждое письмо, то есть на большом сервере минуты работы
 * ради двух чисел в плане. Dovecot же ведёт учёт сам, и это ровно те
 * байты, по которым он применяет квоту.
 */
export async function measureDomainStorage(
  mailRoot: string,
  indexRoot: string,
  domain: string,
): Promise<DomainStorage> {
  const path = join(mailRoot, domain);
  const indexPath = join(indexRoot, domain);
  const result: DomainStorage = {
    present: false,
    path,
    mailboxes: 0,
    messages: 0,
    bytes: 0,
    withoutAccounting: 0,
    indexPath,
    indexPresent: false,
    indexBytes: 0,
  };

  let boxes: string[];
  try {
    boxes = (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    result.present = true;
  } catch {
    return result;
  }

  for (const box of boxes) {
    // Каталог удалённого ящика в карантине живым ящиком не считается,
    // но переезжает вместе со всем каталогом домена — уборщик найдёт его
    // по новому пути (путь ему переписывается в той же транзакции).
    // Карантин удалённых ящиков называется «.deleted» БЕЗ дефиса
    // (QUARANTINE_DIR в mailbox-cleanup.ts) — с дефисом условие не
    // совпадало никогда, и каталог карантина шёл в обход как обычный
    // ящик: файла учёта в нём нет, поэтому он попадал в «ящики без
    // учёта Dovecot» и портил числа ровно перед сменой домена.
    if (box === '.deleted' || box.startsWith('.deleted.')) continue;
    result.mailboxes += 1;
    try {
      const usage = parseMaildirsize(await readFile(join(path, box, 'maildirsize'), 'utf8'));
      if (usage) {
        result.bytes += usage.bytes;
        result.messages += usage.messages;
      } else {
        result.withoutAccounting += 1;
      }
    } catch {
      result.withoutAccounting += 1;
    }
  }

  try {
    await stat(indexPath);
    result.indexPresent = true;
    // Индексы перестраиваемы и на порядки меньше писем — их можно обойти
    // честно, с обычным пределом по времени.
    result.indexBytes = (await directorySize(indexPath, 3000)).bytes;
  } catch {
    result.indexPresent = false;
  }

  return result;
}

/** Оценка свободного места перед началом. */
export interface SpaceVerdict {
  path: string;
  freeBytes: number;
  totalBytes: number;
  requiredBytes: number;
  renameOnly: boolean;
  ok: boolean;
  note: string;
}

/**
 * Запас, который нужен даже при переименовании.
 *
 * Смена домена — это ещё и резервная копия настроек на диск, и транзакция
 * на десятки тысяч строк (журнал предзаписи Postgres), и перевыпуск
 * сертификатов. Запускать всё это на полном диске — верный способ
 * получить операцию, оборвавшуюся посередине по причине, к домену
 * отношения не имеющей. Полгигабайта хватает с большим запасом и не
 * мешает работать на маленьких стендах.
 */
const RESERVE_BYTES = 512 * 1024 * 1024;

/**
 * Проверка места.
 *
 * `renameOnly` определяется не догадкой, а сравнением номеров устройств:
 * если корень хранилища и корень индексов на том же устройстве, что и их
 * родители, — перенос будет переименованием, и объём писем к делу не
 * относится.
 *
 * Разные устройства к этой проверке отношения не имеют: перенос между
 * ними мы не делаем вовсе (см. шапку файла и crossDeviceBlocker), поэтому
 * место под копию не требуется — требуется рабочий запас, как и всегда.
 * Раньше здесь считался весь объём писем, и это выглядело как обещание
 * скопировать их, которого никто не собирался выполнять.
 */
export async function checkSpace(mailRoot: string, renameOnly: boolean): Promise<SpaceVerdict> {
  const usage = await volumeUsage(mailRoot);
  // Объём писем здесь больше не при чём: место под копию не требуется ни в
  // одном случае — копирования нет, а перенос между устройствами отклоняется
  // заранее (crossDeviceBlocker). Раньше в этой ветке требовался весь объём
  // писем, и это выглядело обещанием их скопировать.
  const required = RESERVE_BYTES;
  if (!usage) {
    return {
      path: mailRoot,
      freeBytes: 0,
      totalBytes: 0,
      requiredBytes: required,
      renameOnly,
      ok: false,
      note: `Каталог писем ${mailRoot} не виден из контейнера api — проверить место нечем`,
    };
  }
  return {
    path: mailRoot,
    freeBytes: usage.freeBytes,
    totalBytes: usage.totalBytes,
    requiredBytes: required,
    renameOnly,
    ok: usage.freeBytes >= required,
    note: renameOnly
      ? 'Письма переезжают переименованием каталога в пределах тома — место под них не нужно, ' +
        'нужен только рабочий запас'
      : 'Каталоги на разных устройствах — так смена домена не выполняется вовсе (см. препятствие ' +
        'в плане), место здесь ни при чём',
  };
}

/**
 * Будет ли перенос переименованием.
 *
 * Проверяется по номеру устройства родительского каталога: rename(2)
 * работает только в пределах одной файловой системы. Оба каталога —
 * дети `mailRoot`, поэтому достаточно убедиться, что сам каталог домена
 * лежит на том же устройстве, что и корень.
 */
export async function isRenameOnly(mailRoot: string, domain: string): Promise<boolean> {
  try {
    const root = await stat(mailRoot);
    const dir = await stat(join(mailRoot, domain));
    return root.dev === dir.dev;
  } catch {
    // Каталога домена нет вовсе (сервер без единого письма) — переносить
    // нечего, и «переименование» здесь честнее «копирования».
    return true;
  }
}

/**
 * Препятствие «каталоги на разных устройствах».
 *
 * Отдельной функцией, потому что показывается оно в двух местах и обязано
 * звучать там одинаково: в плане (до нажатия) и в повторной проверке
 * условий перед запуском (тома могли переставить между планом и пуском).
 * Раньше на этом месте было ПРЕДУПРЕЖДЕНИЕ «письма придётся копировать» —
 * то есть обещание сделать то, чего код не умеет; смена домена начиналась
 * и падала уже за точкой невозврата.
 */
export function crossDeviceBlocker(
  renameOnly: boolean,
  mailRoot: string,
  domain: string,
): { id: string; message: string; fix: string } | null {
  if (renameOnly) return null;
  return {
    id: 'cross-device',
    message:
      `Каталог ${join(mailRoot, domain)} лежит на отдельном устройстве, а не в общем томе ` +
      'писем. Переименовать каталог через границу файловых систем нельзя, а копировать ' +
      'сотни гигабайт внутри смены домена мы не беремся: это часы простоя и откат, ' +
      'который означал бы удаление половины скопированного.',
    fix:
      'Перенесите каталог домена в общий том писем руками, в удобное окно (rsync -aHAX ' +
      'с последующим mv), проверьте, что почта работает, и повторите смену домена — ' +
      'тогда она снова станет мгновенным переименованием.',
  };
}

/** Один выполненный перенос каталога — то, что можно вернуть назад. */
export interface MovedDirectory {
  from: string;
  to: string;
}

export class DomainDirectoryConflict extends Error {}

/** Каталоги на разных устройствах: переносить нечем, и это не отказ диска. */
export class CrossDeviceMove extends Error {}

/**
 * Переносит каталоги домена (письма и индексы).
 *
 * Возвращает список переносов, чтобы вызывающий мог вернуть их назад,
 * если следом сорвётся запись в базу. Это и есть та часть операции,
 * которую ещё можно отыграть: пока адреса в базе прежние, каталог с
 * новым именем не значит ничего — Dovecot ходит по старому пути.
 */
export async function moveDomainDirectories(
  mailRoot: string,
  indexRoot: string,
  oldDomain: string,
  newDomain: string,
  options: {
    /**
     * Будет ли перенос переименованием (isRenameOnly, посчитан вызывающим
     * ещё на проверке условий). false — отказываемся, НЕ ТРОНУВ НИЧЕГО:
     * копирования между устройствами здесь нет, см. шапку файла.
     */
    renameOnly?: boolean;
  } = {},
): Promise<MovedDirectory[]> {
  if (options.renameOnly === false) {
    const blocker = crossDeviceBlocker(false, mailRoot, oldDomain);
    throw new CrossDeviceMove(`${blocker?.message ?? ''} ${blocker?.fix ?? ''}`.trim());
  }
  const moved: MovedDirectory[] = [];
  const pairs: Array<{ from: string; to: string }> = [
    { from: join(mailRoot, oldDomain), to: join(mailRoot, newDomain) },
    { from: join(indexRoot, oldDomain), to: join(indexRoot, newDomain) },
  ];

  for (const pair of pairs) {
    let exists = true;
    try {
      await stat(pair.from);
    } catch {
      exists = false;
    }
    // Нечего переносить — не ошибка: индексов может не быть вовсе, а на
    // сервере без единого письма не быть и каталога домена.
    if (!exists) continue;

    // Пустой каталог назначения убираем: он мог остаться от прерванной
    // попытки. Непустой — отказ, потому что слить два хранилища в одно
    // молча означает перемешать чужие письма.
    try {
      const entries = await readdir(pair.to);
      if (entries.length > 0) {
        throw new DomainDirectoryConflict(
          `Каталог ${pair.to} уже существует и не пуст — перенос отменён, чтобы не смешать ` +
            'письма разных доменов. Разберитесь с ним на сервере и повторите.',
        );
      }
      await rmdir(pair.to);
    } catch (err) {
      if (err instanceof DomainDirectoryConflict) {
        await rollbackMoves(moved);
        throw err;
      }
      // Каталога назначения нет — это нормальный случай.
    }

    try {
      await rename(pair.from, pair.to);
      moved.push({ from: pair.from, to: pair.to });
    } catch (err) {
      await rollbackMoves(moved);
      // EXDEV — это «разные файловые системы», а не отказ диска. Сказать
      // это словами обязательно: голое «EXDEV: cross-device link not
      // permitted» посреди смены домена не объясняет ни что случилось, ни
      // что делать, а случиться оно может и после проверки — тома
      // переставляют.
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        const blocker = crossDeviceBlocker(false, mailRoot, oldDomain);
        throw new CrossDeviceMove(`${blocker?.message ?? ''} ${blocker?.fix ?? ''}`.trim());
      }
      throw err;
    }
  }

  return moved;
}

/**
 * Возвращает перенесённые каталоги на место.
 *
 * Ошибки не бросает, но и НЕ ГЛОТАЕТ: список невозвращённых каталогов
 * уходит наружу. Раньше результат `rename` никто не смотрел, а текст шага
 * печатался безусловно — «Каталоги возвращены на место», «Ничего не
 * потеряно». Это могло быть неправдой: пока адреса в базе ещё старые,
 * Postfix продолжает доставлять почту на `логин@старый-домен` и заново
 * создаёт каталог по прежнему пути. Обратный `rename` в такой каталог
 * даёт ENOTEMPTY и молча гасился — почта всех ящиков оставалась под
 * новым доменом, база указывала на старый, ящики выглядели пустыми, а
 * панель уверяла, что всё на месте, и на диск идти незачем.
 */
export async function rollbackMoves(
  moved: readonly MovedDirectory[],
): Promise<{ restored: number; failed: MovedDirectory[] }> {
  let restored = 0;
  const failed: MovedDirectory[] = [];
  for (const item of [...moved].reverse()) {
    try {
      await rename(item.to, item.from);
      restored += 1;
    } catch {
      failed.push(item);
    }
  }
  return { restored, failed };
}
