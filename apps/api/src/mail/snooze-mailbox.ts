/**
 * Перенос отложенного письма туда и обратно — операции над ящиком.
 *
 * ==================================================================
 * ПОРЯДОК ДЕЙСТВИЙ ПРИ ОТКЛАДЫВАНИИ: КОПИЯ -> ЗАПИСЬ -> УДАЛЕНИЕ
 * ==================================================================
 * Самая дорогая ошибка здесь — письмо, потерянное между папками. Оно
 * теряется молча: человек нажал «отложить», список обновился, письма нет
 * ни во «Входящих», ни в «Отложенных», и узнает он об этом через неделю.
 *
 * Поэтому переезд разбит на три шага, и порядок у них ровно такой:
 *
 *   1. КОПИЯ в «Отложенные» (IMAP COPY). Письмо теперь в ДВУХ местах.
 *      Сервер подтверждает копию расширением UIDPLUS: отвечает, какой
 *      номер получила копия и какой у папки UIDVALIDITY. Без подтверждения
 *      мы не знаем, что именно скопировалось, и дальше не идём вовсе.
 *   2. ЗАПИСЬ в базу: срок, исходная папка, номер копии. Только теперь,
 *      после подтверждения сервером, — записывать раньше значило бы
 *      завести срок для письма, которого в «Отложенных» может и не быть.
 *   3. УДАЛЕНИЕ оригинала из исходной папки (IMAP STORE \Deleted + EXPUNGE).
 *
 * Разберём все три обрыва — питание, перезапуск контейнера, обрыв связи:
 *
 *   обрыв после 1 (до записи): письмо и во «Входящих», и в «Отложенных»,
 *     срока нет. Ничего не потеряно, человек видит письмо на месте.
 *     Копию-сироту мы тут же и убираем сами (см. discardCopies): оригинал
 *     цел, поэтому удаление копии не может ничего потерять.
 *   обрыв после 2 (до удаления): письмо в обеих папках, срок есть. В срок
 *     вернётся копия, оригинал останется во «Входящих» — человек увидит
 *     ДВА письма. Неприятно, но видно и поправимо; потери нет.
 *   обрыв после 3: всё сделано.
 *
 * Ни в одном из них письма не исчезает. Обратный порядок (удалить, потом
 * записать) давал бы четвёртый случай — письмо только в «Отложенных» и
 * БЕЗ срока, то есть письмо, которое не вернётся никогда и о котором никто
 * не узнает. Ради этого шаги и расставлены именно так.
 *
 * ==================================================================
 * ВОЗВРАТ: ПИСЬМА МОГЛО УЖЕ НЕ БЫТЬ
 * ==================================================================
 * «Отложенные» — обычная папка IMAP, и человек имеет полное право утащить
 * из неё письмо мышью, удалить его или разобрать почту телефоном. База об
 * этом не узнает. Поэтому возврат НИКОГДА не считает, что письмо на месте:
 * сперва он его ищет (по номеру, при несовпадении UIDVALIDITY — по
 * Message-ID), и не найдя, молча закрывает запись состоянием 'gone'.
 * Именно молча: письмо уже там, куда его дел человек, а исключение
 * остановило бы возврат всех остальных писем этого ящика.
 */
import type { ImapFlow } from 'imapflow';
import type { Folder } from '@mail-true/shared';
import { existingUids, listFolders, searchUids } from '../imap/service.js';
import type { SnoozedRow } from './snooze-db.js';

/** Идентификатор роли служебной папки (см. DEFAULT_ROLE_PATHS в imap/service.ts). */
export const SNOOZE_FOLDER_ID = 'snoozed';

/**
 * Ключевые слова, которые ставятся вернувшемуся письму.
 *
 * `$Snoozed` — им письмо и опознаётся как вернувшееся: список показывает
 * такие письма вверху со значком времени (так делает Яндекс), а обычные
 * пользовательские метки его не видят — слово в SYSTEM_KEYWORDS (summary.ts).
 * `$Pinned` — уже существующее в модели поле `pinned`: закрепление вверху
 * не заводится вторым механизмом ради одного случая.
 *
 * Оба снимаются, как только письмо прочитано (см. routes/messages.ts):
 * пометка «вернулось» существует ровно до того момента, как её увидели.
 */
export const SNOOZE_RETURNED_KEYWORD = '$Snoozed';
export const SNOOZE_PINNED_KEYWORD = '$Pinned';

/** Сведения о письме, которые нужны строке списка «Отложенных». */
export interface SnoozeSourceInfo {
  uid: number;
  subject: string;
  fromAddress: string;
  messageId: string | null;
}

/** Ответ сервера на COPY/MOVE с расширением UIDPLUS. */
interface CopyResult {
  uidValidity?: bigint | number | undefined;
  uidMap?: Map<number, number> | undefined;
}

function uidValidityOf(result: CopyResult | undefined | boolean): number {
  if (!result || typeof result === 'boolean') return 0;
  const raw = result.uidValidity;
  return raw === undefined ? 0 : Number(raw);
}

function uidMapOf(result: CopyResult | undefined | boolean): Map<number, number> {
  if (!result || typeof result === 'boolean') return new Map();
  return result.uidMap ?? new Map();
}

/** Message-ID без угловых скобок — в таком виде его и ищут через HEADER. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/^<|>$/g, '').trim();
  return value === '' ? null : value;
}

/**
 * Читает у писем то, что понадобится строке списка и поиску при возврате.
 *
 * Обязательно ДО копирования: после удаления оригинала спросить будет уже
 * не у кого, а Message-ID — единственный ключ, переживающий пересоздание
 * папки.
 */
export async function readSourceInfo(
  client: ImapFlow,
  uids: number[],
): Promise<Map<number, SnoozeSourceInfo>> {
  const out = new Map<number, SnoozeSourceInfo>();
  if (uids.length === 0) return out;
  const fetched = (await client.fetchAll(uids, { uid: true, envelope: true }, { uid: true })) as
    | Array<{ uid: number; envelope?: { subject?: string; messageId?: string; from?: Array<{ address?: string }> } }>
    | undefined;
  for (const msg of fetched ?? []) {
    out.set(msg.uid, {
      uid: msg.uid,
      subject: msg.envelope?.subject ?? '',
      fromAddress: msg.envelope?.from?.[0]?.address ?? '',
      messageId: normalizeMessageId(msg.envelope?.messageId),
    });
  }
  return out;
}

/**
 * Убирает только что сделанные копии.
 *
 * Зовётся, когда записать срок не удалось. Безопасно по построению:
 * оригинал в этот момент ЕЩЁ НА МЕСТЕ (удаление — третий шаг и до него
 * не дошло), поэтому здесь нечего терять. Отказ проглатывается: копия-сирота
 * в «Отложенных» — беда меньшая, чем исключение поверх и без того
 * неудавшегося откладывания.
 */
export async function discardCopies(
  client: ImapFlow,
  snoozePath: string,
  uids: number[],
): Promise<void> {
  if (uids.length === 0) return;
  const lock = await client.getMailboxLock(snoozePath).catch(() => null);
  if (!lock) return;
  try {
    await client.messageDelete(uids, { uid: true });
  } catch {
    /* см. пояснение выше */
  } finally {
    lock.release();
  }
}

/** Куда возвращать письмо: исходная папка, а если её больше нет — «Входящие». */
export async function resolveReturnPath(
  client: ImapFlow,
  originPath: string,
): Promise<{ path: string; fellBack: boolean }> {
  const folders = await listFolders(client);
  if (folders.some((f) => f.path === originPath)) return { path: originPath, fellBack: false };
  const inbox = folders.find((f) => f.role === 'inbox');
  // «Входящие» есть в любом ящике IMAP — но если сервер вдруг их не отдал,
  // берём стандартное имя: вернуть письмо важнее, чем красиво отказать.
  return { path: inbox?.path ?? 'INBOX', fellBack: true };
}

/**
 * Ищет отложенное письмо в служебной папке. Папка уже должна быть открыта.
 *
 * Два ключа, и порядок между ними не «на всякий случай»:
 *   - номер (UID) — точный и дешёвый, но действителен, только пока
 *     совпадает UIDVALIDITY папки;
 *   - Message-ID — к папке не привязан вовсе и переживает её пересоздание,
 *     но требует поиска по всей папке.
 * Сначала дешёвый, потом дорогой. null — письма в папке больше нет.
 */
export async function locateSnoozed(
  client: ImapFlow,
  row: Pick<SnoozedRow, 'snoozeUid' | 'snoozeUidValidity' | 'messageId'>,
  currentUidValidity: number,
): Promise<number | null> {
  const sameFolderGeneration =
    row.snoozeUidValidity === 0 || currentUidValidity === 0 || row.snoozeUidValidity === currentUidValidity;

  if (sameFolderGeneration) {
    const present = await existingUids(client, [row.snoozeUid]);
    if (present.length > 0) return present[0] ?? null;
  }

  const needle = normalizeMessageId(row.messageId);
  if (!needle) return null;
  const found = await searchUids(client, { header: { 'message-id': needle } });
  return found[0] ?? null;
}

/** Чем кончилась попытка вернуть одно письмо. */
export type ReturnOutcome =
  /** Письмо вернулось в папку. */
  | { kind: 'returned'; path: string; fellBack: boolean }
  /** Письма в «Отложенных» нет — его унесли или удалили. Это не ошибка. */
  | { kind: 'gone' };

/**
 * Возвращает одно письмо в исходную папку и помечает его непрочитанным.
 *
 * Порядок здесь обратный откладыванию и по той же причине: сперва письмо
 * переносится (одной командой MOVE — сервер делает копию и удаление сам,
 * атомарно), и только потом закрывается запись в базе. Обрыв между ними
 * оставляет письмо УЖЕ во «Входящих» и запись живой; следующий проход не
 * найдёт письма в «Отложенных» и закроет её как 'gone'. Лишнего возврата
 * при этом не происходит — возвращать уже нечего.
 */
export async function returnSnoozed(
  client: ImapFlow,
  row: SnoozedRow,
): Promise<ReturnOutcome> {
  const target = await resolveReturnPath(client, row.originPath);

  const lock = await client.getMailboxLock(row.snoozePath);
  let moved: CopyResult | boolean;
  let uid: number | null;
  try {
    const mailbox = client.mailbox;
    const currentUidValidity =
      typeof mailbox === 'object' && mailbox ? Number(mailbox.uidValidity ?? 0) : 0;
    uid = await locateSnoozed(client, row, currentUidValidity);
    if (uid === null) return { kind: 'gone' };
    moved = await client.messageMove([uid], target.path, { uid: true });
  } finally {
    lock.release();
  }

  /*
   * Пометки на вернувшемся письме.
   *
   * Непрочитанное — потому что человек его и откладывал, чтобы прочитать
   * позже; вернуть прочитанным значит вернуть незаметно.
   * `$Snoozed` и `$Pinned` — чтобы письмо было ВИДНО: список ставит такие
   * письма наверх со значком времени. Неудача здесь не отменяет возврата:
   * письмо уже в папке, а пометка — украшение поверх.
   */
  const newUid = uidMapOf(moved).get(uid);
  if (newUid !== undefined) {
    const destLock = await client.getMailboxLock(target.path).catch(() => null);
    if (destLock) {
      try {
        await client.messageFlagsRemove([newUid], ['\\Seen'], { uid: true });
        await client.messageFlagsAdd(
          [newUid],
          [SNOOZE_RETURNED_KEYWORD, SNOOZE_PINNED_KEYWORD],
          { uid: true },
        );
      } catch {
        /* см. пояснение выше */
      } finally {
        destLock.release();
      }
    }
  }

  return { kind: 'returned', path: target.path, fellBack: target.fellBack };
}

/** Что вышло из откладывания одного письма. */
export interface SnoozePlacement {
  sourceUid: number;
  snoozeUid: number;
  snoozeUidValidity: number;
  info: SnoozeSourceInfo;
}

/**
 * Шаг 1: копирует письма в «Отложенные» и возвращает подтверждения сервера.
 *
 * Ничего не удаляет и ничего не пишет в базу — этим занимается вызывающий
 * код, и именно поэтому шаги разделены: порядок «копия, запись, удаление»
 * должен быть виден одним куском, а не размазан по слоям.
 *
 * Возвращает пустой список, если сервер не подтвердил копию номерами
 * (UIDPLUS). Тогда удалять оригинал НЕЛЬЗЯ: мы не знаем, что именно легло
 * в «Отложенные», и вернуть это потом не сможем.
 */
export async function copyToSnooze(
  client: ImapFlow,
  snooze: Folder,
  uids: number[],
  info: Map<number, SnoozeSourceInfo>,
): Promise<SnoozePlacement[]> {
  if (uids.length === 0) return [];
  const result = (await client.messageCopy(uids, snooze.path, { uid: true })) as
    | CopyResult
    | boolean;
  const map = uidMapOf(result);
  const uidValidity = uidValidityOf(result);

  const placed: SnoozePlacement[] = [];
  for (const sourceUid of uids) {
    const snoozeUid = map.get(sourceUid);
    if (snoozeUid === undefined) continue;
    placed.push({
      sourceUid,
      snoozeUid,
      snoozeUidValidity: uidValidity,
      info: info.get(sourceUid) ?? {
        uid: sourceUid,
        subject: '',
        fromAddress: '',
        messageId: null,
      },
    });
  }
  return placed;
}
