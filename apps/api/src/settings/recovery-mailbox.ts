/**
 * Операции над ящиком для «восстановления после очистки корзины».
 *
 * ==================================================================
 * ПОРЯДОК ДЕЙСТВИЙ ПРИ ОЧИСТКЕ: ПЕРЕНОС -> ЗАПИСЬ
 * ==================================================================
 * Самая дорогая ошибка здесь — письмо, о котором некому вспомнить. Оно
 * теряется молча: лежит в служебной папке, записи о нём нет, срока нет,
 * удалить его некому, и оно вечно ест квоту человека.
 *
 * Поэтому шаги ровно такие:
 *
 *   1. ПЕРЕНОС в «Recovery» (IMAP MOVE). Сервер подтверждает перенос
 *      расширением UIDPLUS: отвечает, какие номера получили письма.
 *      Без подтверждения дальше не идём вовсе.
 *   2. ЗАПИСЬ в базу: срок, откуда пришло, новый номер.
 *
 * Разберём обрывы — питание, перезапуск контейнера, разрыв связи:
 *
 *   обрыв после 1 (до записи): письма в «Recovery», записей нет. Ничего
 *     не потеряно — письма целы, но сами не удалятся. Их подбирает
 *     сверка: письмо в «Recovery» без записи считается «сиротой», и
 *     раздел настроек показывает его отдельной строкой со сроком от
 *     момента, когда его заметили. Молча копить их нельзя.
 *   обрыв после 2: всё сделано.
 *
 * Обратный порядок (записать, потом перенести) дал бы запись о письме,
 * которого в «Recovery» нет: работник в срок искал бы его и не находил.
 * Это дешевле разобрать, чем потерянное письмо, но лишний шум в журнале
 * при каждом обрыве связи нам не нужен.
 *
 * ==================================================================
 * ПОЧЕМУ MOVE, А НЕ COPY + DELETE
 * ==================================================================
 * Потому что письмо УЖЕ в корзине: человек его выбросил и нажал
 * «Очистить». Двойника здесь бояться нечего — терять нечего, если
 * перенос сорвётся на середине: письмо просто останется в корзине.
 * А MOVE у Dovecot атомарен и вдвое дешевле по вводу-выводу.
 */
import type { ImapFlow } from 'imapflow';
import type { Folder } from '@mail-true/shared';
import { encodePathId, RECOVERY_FOLDER_PATH } from '../mail/folders.js';
import { chunkUidSets, listFolders, searchUids } from '../imap/service.js';
import { UpstreamUnavailableError } from '../errors.js';

export { RECOVERY_FOLDER_PATH };

/**
 * Служебная папка как объект Folder — заводя её, если ещё нет.
 *
 * Отдельная функция, а не `requireOrCreateFolder`, ровно потому, что папка
 * СПРЯТАНА: общий список папок (listFolders) её не отдаёт вовсе, и найти
 * её там нельзя по определению. Спрашиваем сервер напрямую — STATUS по
 * известному пути.
 */
export async function ensureRecoveryFolder(client: ImapFlow): Promise<Folder> {
  let status: { messages?: number; uidValidity?: bigint | number } | null = null;
  try {
    status = await client.status(RECOVERY_FOLDER_PATH, { messages: true, uidValidity: true });
  } catch {
    // Папки нет — заводим. Подписка нужна, чтобы почтовая программа
    // человека её увидела: спрятана она только в НАШЕМ дереве.
    await client.mailboxCreate(RECOVERY_FOLDER_PATH).catch(() => undefined);
    await client.mailboxSubscribe(RECOVERY_FOLDER_PATH).catch(() => undefined);
    status = await client.status(RECOVERY_FOLDER_PATH, { messages: true, uidValidity: true });
  }
  return {
    id: encodePathId(RECOVERY_FOLDER_PATH),
    path: RECOVERY_FOLDER_PATH,
    name: RECOVERY_FOLDER_PATH,
    role: 'custom',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: status?.messages ?? 0,
    system: true,
    uidValidity: Number(status?.uidValidity ?? 0),
  };
}

/** Сведения о письме, которые нужны строке списка и записи в базе. */
export interface RecoverySourceInfo {
  uid: number;
  subject: string;
  fromAddress: string;
  messageId: string | null;
  sentAt: Date | null;
  sizeBytes: number;
}

/** Ответ сервера на MOVE с расширением UIDPLUS. */
interface UidMapResult {
  uidMap?: Map<number, number>;
  uidValidity?: bigint | number;
}

/** Заголовок Message-ID без угловых скобок и пробелов. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^<|>$/g, '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Читает то, что понадобится после переноса.
 *
 * Читается ДО переноса и в той же блокировке: после MOVE письма в папке
 * уже нет, а тему и размер надо показать человеку в списке «что можно
 * вернуть». Открывать письмо второй раз в новой папке было бы вдвое
 * дороже ровно ради тех же данных.
 */
export async function readRecoverySource(
  client: ImapFlow,
  uids: number[],
): Promise<Map<number, RecoverySourceInfo>> {
  const found = new Map<number, RecoverySourceInfo>();
  if (uids.length === 0) return found;
  for await (const msg of client.fetch(
    uids,
    { uid: true, envelope: true, size: true },
    { uid: true },
  )) {
    found.set(msg.uid, {
      uid: msg.uid,
      subject: msg.envelope?.subject ?? '',
      fromAddress: msg.envelope?.from?.[0]?.address ?? '',
      messageId: normalizeMessageId(msg.envelope?.messageId),
      sentAt: msg.envelope?.date ?? null,
      sizeBytes: msg.size ?? 0,
    });
  }
  return found;
}

/** Куда письмо попало после переноса. */
export interface RecoveryPlacement {
  sourceUid: number;
  recoveryUid: number;
  recoveryUidValidity: number;
  info: RecoverySourceInfo;
}

/**
 * Переносит письма в «Recovery» и сообщает, какие номера они получили.
 *
 * Пустой ответ означает, что сервер не подтвердил перенос номерами
 * (нет UIDPLUS). Это не отказ — письма перенесены, — но записать о них
 * в базу нечего, и вызывающий обязан честно сказать об этом человеку,
 * а не делать вид, что всё сохранено.
 */
export async function moveToRecovery(
  client: ImapFlow,
  target: Folder,
  uids: number[],
  info: Map<number, RecoverySourceInfo>,
): Promise<RecoveryPlacement[] | { placements: RecoveryPlacement[]; failure: Error }> {
  if (uids.length === 0) return [];
  /*
   * ОТКАЗ переноса и «сервер не назвал номера» — разные вещи.
   *
   * imapflow при неудаче MOVE исключения не бросает: он возвращает
   * `false`. Раньше этот `false` молча превращался в пустой список, а
   * вызывающий трактовал пустоту как «письма перенесены, записывать
   * нечего». Итог: ответ «удалено N», строки уходят из списка, в журнал
   * пишется «Очищена корзина» — а письма на месте. Ровно тот случай, ради
   * которого заведены storeFlags и moveUids; сюда правку не донесли.
   *
   * Вторая половина: список номеров уходил одной командой. Корзину чистят
   * как раз тогда, когда она разрослась, а Dovecot отвергает слишком
   * длинный аргумент примерно с двенадцати тысяч писем — и это снова
   * `false`, снова «удалено N» и снова письма на месте.
   */
  /*
   * ОТКАЗ ПОСРЕДИ НАРЕЗКИ НЕ ИМЕЕТ ПРАВА УНОСИТЬ УЖЕ ПЕРЕНЕСЁННОЕ.
   *
   * Здесь стоял `throw` прямо в цикле — и он терял `map`, набранный
   * предыдущими порциями. А порции появляются как раз на разросшейся
   * корзине: примерно с тысячи несмежных номеров. Первая порция уезжает
   * в скрытую служебную папку, вторая упирается в обрыв связи или
   * таймаут — и несколько сотен писем остаются там БЕЗ единой строки в
   * базе. Такие письма не видно нигде: ни в почте, ни в разделе
   * «Восстановление писем», а работник удаления по сроку читает ту же
   * базу и не найдёт их никогда. Они лежат вечно и едят квоту.
   *
   * Поэтому отказ запоминается, цикл прекращается, а перенесённое
   * возвращается наверх: вызывающий сперва запишет его в базу (тогда
   * письма видны и возвращаемы), и только потом сообщит об отказе.
   */
  const map = new Map<number, number>();
  let uidValidityFromServer = 0;
  let failure: Error | null = null;
  for (const range of chunkUidSets(uids)) {
    let result: UidMapResult | boolean | undefined;
    try {
      result = (await client.messageMove(range, target.path, { uid: true })) as
        UidMapResult | boolean | undefined;
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      break;
    }
    if (result === false) {
      failure = new UpstreamUnavailableError(
        'Почтовый сервер не смог очистить корзину. Повторите попытку позже.',
      );
      break;
    }
    const chunkMap = typeof result === 'object' && result ? result.uidMap : undefined;
    if (chunkMap) {
      for (const [from, to] of chunkMap) map.set(from, to);
      const validity = Number((result as UidMapResult).uidValidity ?? 0);
      if (validity > 0) uidValidityFromServer = validity;
    }
  }
  if (map.size === 0) {
    if (failure) throw failure;
    return [];
  }
  const uidValidity = uidValidityFromServer || Number(target.uidValidity ?? 0);
  const placements: RecoveryPlacement[] = [];
  for (const [sourceUid, recoveryUid] of map) {
    const source = info.get(sourceUid);
    if (!source) continue;
    placements.push({ sourceUid, recoveryUid, recoveryUidValidity: uidValidity, info: source });
  }
  // Часть уехала, часть — нет. Отдаём перенесённое и говорим, что дальше
  // не пошло: записать эти письма в базу обязательно, иначе они пропадут
  // из виду навсегда.
  if (failure) return { placements, failure };
  return placements;
}

/**
 * Находит письмо в «Recovery»: сперва по номеру, потом по Message-ID.
 *
 * Два способа, а не один, — по той же причине, что у отложенных писем:
 * пара (UIDVALIDITY, UID) точна, но обнуляется при пересоздании папки.
 * Не нашлось ни так, ни так — письма больше нет, и запись закрывается
 * состоянием 'gone'.
 */
export async function locateRecovered(
  client: ImapFlow,
  folder: Folder,
  row: { recoveryUid: number; recoveryUidValidity: number; messageId: string | null },
): Promise<number | null> {
  const sameGeneration =
    row.recoveryUidValidity === 0 || Number(folder.uidValidity) === row.recoveryUidValidity;
  if (sameGeneration) {
    const found = await searchUids(client, { uid: String(row.recoveryUid) });
    if (found.includes(row.recoveryUid)) return row.recoveryUid;
  }
  if (!row.messageId) return null;
  const byId = await searchUids(client, { header: { 'message-id': row.messageId } });
  return byId[0] ?? null;
}

/**
 * Куда возвращать письмо.
 *
 * Обычно это корзина, из которой его и очистили: человек, нажавший
 * «восстановить», ждёт письмо там, откуда оно исчезло, а не там, где оно
 * лежало год назад. Папки может уже не быть — тогда «Входящие»,
 * единственная папка, которая есть в любом ящике.
 */
export async function resolveRestorePath(client: ImapFlow, originPath: string): Promise<string> {
  const folders = await listFolders(client);
  if (folders.some((f) => f.path === originPath)) return originPath;
  const trash = folders.find((f) => f.role === 'trash');
  if (trash) return trash.path;
  return folders.find((f) => f.role === 'inbox')?.path ?? 'INBOX';
}

/**
 * Возврат писем из «Recovery» туда, откуда их взяли.
 *
 * Нужен ровно в одном случае: перенос удался, а записать о нём в базу не
 * вышло. Без возврата письма остаются в скрытой папке, где их не видит ни
 * почта, ни раздел «Восстановление писем», ни работник удаления по
 * сроку, — то есть они лежат вечно и едят квоту, считаясь удалёнными.
 *
 * Возврат по номерам в «Recovery», а не по Message-ID: номера мы только
 * что получили от самого сервера при переносе, и это самый точный
 * указатель, какой у нас есть.
 */
export async function returnFromRecovery(
  client: ImapFlow,
  recovery: Folder,
  originPath: string,
  recoveryUids: readonly number[],
): Promise<void> {
  if (recoveryUids.length === 0) return;
  const lock = await client.getMailboxLock(recovery.path);
  try {
    /*
     * Возврат — единственная защита от худшего исхода: письма лежат в
     * скрытой служебной папке, а записи о них в базе нет. Такие письма не
     * видны нигде — ни в почте, ни в разделе восстановления, ни работнику
     * удаления по сроку, — лежат вечно и занимают квоту. Поэтому отказ
     * здесь обязан быть громким: раньше `false` от messageMove не читался
     * вовсе, а вызывающий глушил и исключения.
     */
    for (const range of chunkUidSets([...recoveryUids])) {
      const result = await client.messageMove(range, originPath, { uid: true });
      if (result === false) {
        throw new UpstreamUnavailableError(
          'Не удалось вернуть письма из служебной папки восстановления.',
        );
      }
    }
  } finally {
    lock.release();
  }
}
