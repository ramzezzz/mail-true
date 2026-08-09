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
 * Копирование всё же предусмотрено — на случай, если каталоги окажутся на
 * разных устройствах (кто-то смонтировал домен отдельным томом). Тогда
 * rename отвечает EXDEV, и мы честно требуем свободное место под весь
 * объём, а не делаем вид, что перенос бесплатен.
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
 * относится. Иначе требуется весь объём плюс запас.
 */
export async function checkSpace(
  mailRoot: string,
  mailBytes: number,
  renameOnly: boolean,
): Promise<SpaceVerdict> {
  const usage = await volumeUsage(mailRoot);
  const required = renameOnly ? RESERVE_BYTES : mailBytes + RESERVE_BYTES;
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
      : 'Каталоги на разных устройствах: письма придётся копировать, нужен запас под весь объём',
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

/** Один выполненный перенос каталога — то, что можно вернуть назад. */
export interface MovedDirectory {
  from: string;
  to: string;
}

export class DomainDirectoryConflict extends Error {}

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
): Promise<MovedDirectory[]> {
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
      throw err;
    }
  }

  return moved;
}

/** Возвращает перенесённые каталоги на место. Ошибки не бросает. */
export async function rollbackMoves(moved: readonly MovedDirectory[]): Promise<void> {
  for (const item of [...moved].reverse()) {
    await rename(item.to, item.from).catch(() => undefined);
  }
}
