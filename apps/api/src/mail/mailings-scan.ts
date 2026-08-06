/**
 * Осмотр ящика для разбора рассылок и уборки.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО НЕ ДЕЛАЕТСЯ ПОИСКОМ И ПОЧЕМУ ЭТО ВООБЩЕ ДОРОГО
 * ------------------------------------------------------------------
 * Вопросы разбора — «кто прислал больше всех» и «что занимает место» —
 * не сводятся к поиску: IMAP умеет отвечать «какие письма подходят под
 * условие», но не умеет группировать и суммировать. Значит, размеры и
 * заголовки приходится забрать самим.
 *
 * Забираем ровно четыре вещи и ни байтом больше: конверт (кто, когда,
 * тема), флаги (прочитано, флажок), размер и три заголовка списка
 * рассылки. Ни тела, ни структуры частей, ни сниппетов — они здесь ничего
 * не решают, а стоят на порядок дороже.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЕСТЬ ПРЕДЕЛ ОСМОТРА И ПОЧЕМУ О НЁМ ГОВОРЯТ ВСЛУХ
 * ------------------------------------------------------------------
 * Ящик на двадцать тысяч писем осматривается заметное время, а разбор —
 * действие, которое человек начинает сам и ждёт ответа. Поэтому осмотр
 * ограничен сверху (SCAN_LIMIT), берёт СВЕЖИЕ письма первыми и честно
 * сообщает, что дошёл не до конца (`truncated`). Молчаливое усечение
 * здесь недопустимо: числа разбора — это то, на что человек нажимает
 * «удалить», и «412 писем» обязано означать 412, а не «412 из тех, что
 * мы успели посмотреть».
 */
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import type { Folder, FolderRole } from '@mail-true/shared';
import { chunkUidSets, listFolders, searchUids } from '../imap/service.js';
import { errorInfo } from '../log.js';
import { rawHeaderValue } from './header-charset.js';
import { mapAddress } from './summary.js';
import { parseUnsubscribe } from './unsubscribe.js';
import { parseListId, type ScannedMessage } from './mailings.js';

/**
 * Сколько писем осматриваем за один раз.
 *
 * Пять тысяч — это примерно секунда на нашем стенде и десятки мегабайт
 * трафика к Dovecot. Больше делать смысла нет: разбор нужен, чтобы найти
 * главных виновников, а они всегда в верхушке — рассылка, которой у вас
 * тысяча писем, попадёт в осмотр при любом пределе.
 */
export const SCAN_LIMIT = 5000;

/**
 * Порядок обхода папок.
 *
 * Не алфавитный и не случайный: предел осмотра расходуется сверху вниз,
 * поэтому первыми должны идти папки, ради которых разбор и открывают.
 * «Входящие» — где рассылки копятся; «Архив» и свои папки — где они
 * лежат после разбора; «Спам» — где их больше всего по числу; и только
 * потом «Отправленные» и «Корзина», которые нужны лишь ради честного
 * ответа на вопрос «куда делось место».
 */
const FOLDER_ORDER: readonly FolderRole[] = [
  'inbox',
  'archive',
  'custom',
  'spam',
  'sent',
  'trash',
  'snoozed',
];

/**
 * Папки, которые не осматриваем вовсе.
 *
 * «Черновики» — это ненаписанные письма человека. Ни в одной группе
 * отправителей им делать нечего (отправитель там вы сами), а уборка их
 * не трогает по своему собственному правилу (см. mailings.ts). Платить
 * за их осмотр не за что.
 */
const SKIP_ROLES: ReadonlySet<FolderRole> = new Set<FolderRole>(['drafts']);

/** Что забираем у письма. Список закрытый — см. шапку. */
const SCAN_FETCH_FIELDS = {
  uid: true,
  envelope: true,
  flags: true,
  size: true,
  internalDate: true,
  headers: ['list-id', 'list-unsubscribe', 'list-unsubscribe-post'],
};

export interface ScanFolderStat {
  folderId: string;
  name: string;
  role: FolderRole;
  /** Писем в папке всего (по данным папки, а не по осмотру). */
  total: number;
  /** Сколько из них осмотрено. */
  scanned: number;
  /** Сколько байт занимают осмотренные. */
  bytes: number;
}

export interface ScanResult {
  messages: ScannedMessage[];
  /** Писем во всех осматриваемых папках. */
  total: number;
  scanned: number;
  /** Предел осмотра исчерпан — часть ящика осталась непросмотренной. */
  truncated: boolean;
  folders: ScanFolderStat[];
  /** Квота ящика по данным почтового сервера либо null, если её нет. */
  quota: { usedBytes: number; limitBytes: number } | null;
  /** Когда осмотр был сделан (ISO) — показывается человеку. */
  at: string;
}

/** Значение заголовка списка в виде строки (заголовки списка — ASCII). */
function headerText(block: Buffer | undefined, name: string): string {
  if (!block) return '';
  const raw = rawHeaderValue(block, name);
  return raw ? raw.toString('utf8') : '';
}

/**
 * Имя рассылки из `List-Id`, если его можно показать как есть.
 *
 * Закодированное по RFC 2047 имя (`=?UTF-8?B?...?=`) здесь не
 * разворачивается намеренно: разворачивать заголовки — работа разбора
 * письма, и тащить его сюда ради подписи, которая почти всегда пустая,
 * значило бы платить за осмотр вдвое. Вместо этого группа возьмёт имя
 * отправителя из конверта — оно уже разобрано почтовым сервером.
 */
function displayableListName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('=?')) return null;
  return trimmed;
}

/** Превращает ответ FETCH в письмо для разбора. */
export function toScannedMessage(
  folder: { id: string; role: FolderRole },
  msg: FetchMessageObject,
): ScannedMessage {
  const headers = msg.headers;
  const listIdRaw = headerText(headers, 'List-Id');
  const listUnsubscribe = headerText(headers, 'List-Unsubscribe');
  const listUnsubscribePost = headerText(headers, 'List-Unsubscribe-Post');
  const info = parseUnsubscribe({
    'list-unsubscribe': listUnsubscribe,
    'list-unsubscribe-post': listUnsubscribePost,
  });

  const dateSource = msg.envelope?.date ?? msg.internalDate ?? new Date();
  const date = dateSource instanceof Date ? dateSource : new Date(dateSource);
  // Разбор `List-Id` живёт в mailings.ts рядом с группировкой: правило
  // «идентификатор из скобок, имя перед ними» одно на весь разбор, и
  // второй его копии здесь быть не должно.
  const list = parseListId(listIdRaw);

  return {
    id: `${folder.id}:${String(msg.uid)}`,
    folderId: folder.id,
    folderRole: folder.role,
    uid: msg.uid,
    size: msg.size ?? 0,
    date: (Number.isNaN(date.getTime()) ? new Date() : date).toISOString(),
    seen: msg.flags?.has('\\Seen') ?? false,
    flagged: msg.flags?.has('\\Flagged') ?? false,
    subject: msg.envelope?.subject ?? '',
    from: mapAddress(msg.envelope?.from?.[0]),
    listId: list?.id ?? null,
    listName: displayableListName(list?.name ?? ''),
    unsubscribe: Boolean(info.url ?? info.mailto),
    oneClick: info.oneClick,
  };
}

/** Порядковый вес папки при обходе — чем меньше, тем раньше. */
function folderWeight(folder: Folder): number {
  const index = FOLDER_ORDER.indexOf(folder.role);
  return index === -1 ? FOLDER_ORDER.length : index;
}

export interface ScanOptions {
  limit?: number | undefined;
  log?: { warn: (obj: unknown, msg: string) => void } | undefined;
}

/**
 * Осматривает ящик.
 *
 * Папка, которую не удалось открыть, пропускается с записью в журнал:
 * потерять разбор всего ящика из-за одной недоступной папки нельзя —
 * ровно то же правило, что при снятии метки со всех писем
 * (mail/labels-routes.ts).
 */
export async function scanMailbox(client: ImapFlow, opts: ScanOptions = {}): Promise<ScanResult> {
  const limit = opts.limit ?? SCAN_LIMIT;
  const folders = (await listFolders(client))
    .filter((f) => !SKIP_ROLES.has(f.role))
    .sort((a, b) => folderWeight(a) - folderWeight(b) || a.path.localeCompare(b.path));

  const messages: ScannedMessage[] = [];
  const stats: ScanFolderStat[] = [];
  let total = 0;
  let truncated = false;

  for (const folder of folders) {
    total += folder.totalCount;
    const stat: ScanFolderStat = {
      folderId: folder.id,
      name: folder.name,
      role: folder.role,
      total: folder.totalCount,
      scanned: 0,
      bytes: 0,
    };
    stats.push(stat);

    const budget = limit - messages.length;
    if (budget <= 0) {
      if (folder.totalCount > 0) truncated = true;
      continue;
    }

    let lock: { release(): void } | null = null;
    try {
      lock = await client.getMailboxLock(folder.path);
      const uids = await searchUids(client, { all: true });
      // Свежие письма первыми: UID растёт со временем, и если предела
      // осмотра не хватит, недосмотренным останется самое старое.
      uids.sort((a, b) => b - a);
      if (uids.length > budget) truncated = true;
      const wanted = uids.slice(0, budget);
      for (const range of chunkUidSets(wanted)) {
        for await (const msg of client.fetch(range, SCAN_FETCH_FIELDS, { uid: true })) {
          const scanned = toScannedMessage(folder, msg);
          messages.push(scanned);
          stat.scanned += 1;
          stat.bytes += scanned.size;
        }
      }
    } catch (err) {
      opts.log?.warn(errorInfo(err, { folder: folder.path }), 'Не удалось осмотреть папку');
    } finally {
      lock?.release();
    }
  }

  return {
    messages,
    total,
    scanned: messages.length,
    truncated,
    folders: stats,
    quota: await readQuota(client),
    at: new Date().toISOString(),
  };
}

/**
 * Настоящая квота ящика.
 *
 * Именно настоящая, а не оценка по сумме размеров писем: Dovecot считает
 * место сам, и его число отличается от нашей суммы (служебные индексы,
 * ещё не убранные удалённые письма). Обещание «освободится столько-то»
 * должно опираться на то же число, что человек видит в профиле, —
 * поэтому берём его тем же способом, что и routes/account.ts.
 */
async function readQuota(
  client: ImapFlow,
): Promise<{ usedBytes: number; limitBytes: number } | null> {
  try {
    const quota = await client.getQuota('INBOX');
    const storage = quota && quota.storage ? quota.storage : null;
    if (!storage) return null;
    // ImapFlow кладёт занятое место в usage, хотя в типах написано used —
    // та же оговорка, что и в routes/account.ts.
    const usedBytes = (storage as { usage?: number; used?: number }).usage ?? storage.used ?? 0;
    return { usedBytes, limitBytes: storage.limit ?? 0 };
  } catch {
    return null;
  }
}
