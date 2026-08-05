/**
 * Операции над почтовым ящиком поверх открытого IMAP-соединения.
 */
import type {
  ImapFlow,
  FetchMessageObject,
  MessageStructureObject,
  SearchObject,
} from 'imapflow';
import type { Folder, MessageFilter, MessageListPage, MessageSummary } from '@mail-true/shared';
import { NotFoundError, BadRequestError, UpstreamUnavailableError } from '../errors.js';
import { mapFolders, findFolderById, type RawFolderInfo } from '../mail/folders.js';
import { buildSummary } from '../mail/summary.js';
import { hasRealAttachments, pickTextPart } from '../mail/structure.js';
import { decodeBuffer, htmlToText, makeSnippet } from '../mail/text.js';
import { parseSearch } from '../mail/search-query.js';

/** Загружает список папок с счётчиками. */
export async function listFolders(client: ImapFlow): Promise<Folder[]> {
  const listed = await client.list({
    statusQuery: { messages: true, unseen: true, uidValidity: true },
  });

  const raw: RawFolderInfo[] = [];
  for (const item of listed) {
    let status = item.status;
    if (!status && !item.flags.has('\\Noselect')) {
      // Сервер без LIST-STATUS: запрашиваем статус отдельно
      try {
        status = await client.status(item.path, { messages: true, unseen: true, uidValidity: true });
      } catch {
        /* папка может быть недоступна */
      }
    }
    raw.push({
      path: item.path,
      name: item.name,
      delimiter: item.delimiter,
      parentPath: item.parentPath,
      specialUse: item.specialUse,
      flags: item.flags,
      status: status
        ? {
            messages: status.messages,
            unseen: status.unseen,
            uidValidity: status.uidValidity,
          }
        : undefined,
    });
  }
  return mapFolders(raw);
}

/** Возвращает папку по публичному id или бросает 404. */
export async function requireFolder(client: ImapFlow, folderId: string): Promise<Folder> {
  const folders = await listFolders(client);
  const folder = findFolderById(folders, folderId);
  if (!folder) throw new NotFoundError(`Папка не найдена: ${folderId}`);
  return folder;
}

/** IMAP-имена системных папок по умолчанию (если их ещё нет в ящике). */
const DEFAULT_ROLE_PATHS: Record<string, string> = {
  sent: 'Sent',
  drafts: 'Drafts',
  spam: 'Spam',
  trash: 'Trash',
  archive: 'Archive',
};

/**
 * Как requireFolder, но недостающую системную папку (например, «Архив»)
 * создаёт автоматически — так ведёт себя и mail.ru.
 */
export async function requireOrCreateFolder(client: ImapFlow, folderId: string): Promise<Folder> {
  const folders = await listFolders(client);
  const folder = findFolderById(folders, folderId);
  if (folder) return folder;

  const defaultPath = DEFAULT_ROLE_PATHS[folderId];
  if (!defaultPath) throw new NotFoundError(`Папка не найдена: ${folderId}`);
  await client.mailboxCreate(defaultPath);
  await client.mailboxSubscribe(defaultPath).catch(() => undefined);
  const refreshed = await listFolders(client);
  const created = findFolderById(refreshed, folderId);
  if (!created) throw new NotFoundError(`Не удалось создать папку: ${folderId}`);
  return created;
}

/** Разбирает составной id письма `${folderId}:${uid}`. */
export function splitMessageId(id: string): { folderId: string; uid: number } {
  const idx = id.lastIndexOf(':');
  if (idx <= 0) throw new BadRequestError(`Некорректный идентификатор письма: ${id}`);
  const folderId = id.slice(0, idx);
  const uid = Number(id.slice(idx + 1));
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new BadRequestError(`Некорректный идентификатор письма: ${id}`);
  }
  return { folderId, uid };
}

export function buildSearchQuery(filter: MessageFilter, search: string | undefined): SearchObject {
  const query: SearchObject = {};
  switch (filter) {
    case 'unread':
      query.seen = false;
      break;
    case 'flagged':
      query.flagged = true;
      break;
    case 'with-attachments':
      // Отбор по вложениям делается после поиска, разбором BODYSTRUCTURE
      // (см. keepUidsWithAttachments). Здесь берём всё.
      query.all = true;
      break;
    case 'all':
      query.all = true;
      break;
  }
  /*
   * Поисковая строка разбирается на операторы. Раньше она целиком уходила
   * в IMAP как поиск по тексту, поэтому `от:волкова` не находило ничего:
   * сервер честно искал письмо, содержащее подстроку «от:волкова». То есть
   * попытка уточнить запрос делала поиск ХУЖЕ, чем его отсутствие.
   *
   * Операторы складываются с фильтром списка: выбранное «непрочитанные» и
   * написанное `от:иванов` работают вместе, а не спорят.
   */
  const parsed = parseSearch(search);
  if (parsed.from) query.from = parsed.from;
  if (parsed.to) query.to = parsed.to;
  if (parsed.cc) query.cc = parsed.cc;
  if (parsed.subject) query.subject = parsed.subject;
  if (parsed.since) query.since = parsed.since;
  if (parsed.before) query.before = parsed.before;
  if (parsed.seen !== null) query.seen = parsed.seen;
  if (parsed.flagged !== null) query.flagged = parsed.flagged;
  if (parsed.text) {
    // TEXT ищет и по заголовкам, и по телу
    query.text = parsed.text;
  }
  return query;
}

/** Нужен ли отбор по вложениям после поиска — по фильтру или по оператору. */
export function wantsAttachments(filter: MessageFilter, search: string | undefined): boolean {
  return filter === 'with-attachments' || parseSearch(search).hasAttachment;
}

/**
 * IMAP SEARCH, который не превращает отказ сервера в «ничего не найдено».
 *
 * imapflow при неудаче команды SEARCH ошибку НЕ бросает: он пишет её себе в
 * журнал и возвращает `false` (см. node_modules/imapflow/lib/commands/search.js,
 * `catch { ... return false; }`). Если мёртвого `false` не заметить, а просто
 * подставить пустой массив, то отказ сервера становится неотличим от честного
 * «писем нет»: API отвечает `{"items":[],"total":0}` с кодом 200.
 *
 * Воспроизведено на живом стенде: при повреждённом индексе Dovecot пишет
 * «Searching mailbox INBOX failed: Internal error», `doveadm search` возвращает
 * ошибку — а пользователь видел пустую папку и был уверен, что писем нет.
 * Это худший вид отказа: молчаливый и неотличимый от правды. Теперь любой
 * не-массив — это 503, то есть видимая ошибка, после которой можно повторить.
 */
export async function searchUids(client: ImapFlow, query: SearchObject): Promise<number[]> {
  const found = await client.search(query, { uid: true });
  if (!Array.isArray(found)) {
    throw new UpstreamUnavailableError(
      'Почтовый сервер не смог выполнить поиск. Повторите попытку позже.'
    );
  }
  return found;
}

/**
 * Предел длины перечня номеров в ОДНОЙ команде IMAP.
 *
 * Dovecot отвергает слишком длинную строку аргумента («Too long argument»),
 * а безопасный предел строки команды — 64 КБ. Держим запас на имя команды,
 * список полей и служебные символы: 8 КБ номеров хватает с избытком, а на
 * стороне сервера такая команда разбирается мгновенно.
 */
export const UID_SET_MAX_CHARS = 8192;

/**
 * Сворачивает список UID в наборы диапазонов ограниченной длины.
 *
 * Раньше фильтр «с вложениями» отдавал весь список номеров ОДНОЙ строкой:
 * `1,2,3,…,20000`. Замеры на живом стенде: 2000 писем — 86 мс, 10 271 — 391 мс,
 * а 20 000 — HTTP 500 за 33 мс, и в журнале Dovecot «Too long argument».
 * Порог был около 11–12 тысяч писем, то есть фильтр ломался ровно на тех
 * ящиках, ради которых он и нужен.
 *
 * Подряд идущие номера сворачиваются в диапазон `1:20000` (это же делает и
 * сам протокол), а всё, что не свернулось, режется на команды не длиннее
 * UID_SET_MAX_CHARS.
 */
export function chunkUidSets(uids: number[], maxChars = UID_SET_MAX_CHARS): string[] {
  if (uids.length === 0) return [];
  const sorted = [...uids].sort((a, b) => a - b);
  const chunks: string[] = [];
  let current = '';

  const push = (token: string): void => {
    if (current === '') {
      current = token;
      return;
    }
    if (current.length + 1 + token.length > maxChars) {
      chunks.push(current);
      current = token;
      return;
    }
    current += `,${token}`;
  };

  let start = sorted[0] as number;
  let prev = start;
  for (let i = 1; i <= sorted.length; i += 1) {
    const uid = sorted[i];
    if (uid !== undefined && (uid === prev || uid === prev + 1)) {
      prev = uid;
      continue;
    }
    push(start === prev ? String(start) : `${String(start)}:${String(prev)}`);
    if (uid === undefined) break;
    start = uid;
    prev = uid;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/** Часть ответа FETCH, которой достаточно для отбора по вложениям. */
export interface UidWithStructure {
  uid: number;
  bodyStructure?: MessageStructureObject | undefined;
}

/**
 * Оставляет только письма с настоящими (не встроенными) вложениями.
 *
 * Раньше фильтр «с вложениями» искал по заголовку
 * `Content-Type: multipart/mixed` — и не находил НИЧЕГО и никогда. Проверено
 * напрямую на живом Dovecot: `doveadm search header content-type ...` не
 * возвращает ни одного письма, при том что `doveadm search header subject`
 * работает. В доках это называлось «приближением», по факту фильтр был мёртв.
 *
 * Работающий способ — разбирать BODYSTRUCTURE, ту же самую, по которой в
 * списке рисуется скрепка. Dovecot держит BODYSTRUCTURE в кэше индекса, так
 * что один FETCH по папке отдаётся без чтения самих писем. Заодно результат
 * фильтра теперь по определению совпадает с признаком `hasAttachments`
 * в строке списка — раньше они жили независимо друг от друга.
 */
export function keepUidsWithAttachments(fetched: UidWithStructure[]): Set<number> {
  const kept = new Set<number>();
  for (const msg of fetched) {
    if (hasRealAttachments(msg.bodyStructure)) kept.add(msg.uid);
  }
  return kept;
}

/**
 * Запрашивает BODYSTRUCTURE по частям и оставляет письма с вложениями.
 * Разбиение по командам — обязательное: см. chunkUidSets.
 */
async function selectUidsWithAttachments(client: ImapFlow, uids: number[]): Promise<Set<number>> {
  const kept = new Set<number>();
  for (const range of chunkUidSets(uids)) {
    const structures = await client.fetchAll(range, { uid: true, bodyStructure: true }, { uid: true });
    for (const uid of keepUidsWithAttachments(structures)) kept.add(uid);
  }
  return kept;
}

/** Пытается получить сниппет письма, скачав начало текстовой части. */
async function fetchSnippet(client: ImapFlow, msg: FetchMessageObject): Promise<string> {
  const ref = pickTextPart(msg.bodyStructure);
  if (!ref) return '';
  try {
    const dl = await client.download(String(msg.uid), ref.part, { uid: true, maxBytes: 4096 });
    const chunks: Buffer[] = [];
    for await (const chunk of dl.content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const text = decodeBuffer(Buffer.concat(chunks), dl.meta.charset);
    return makeSnippet(ref.kind === 'html' ? htmlToText(text) : text);
  } catch {
    return '';
  }
}

export interface ListMessagesArgs {
  folder: Folder;
  offset: number;
  limit: number;
  filter: MessageFilter;
  search?: string | undefined;
  /** Загружать ли сниппеты (дороже на порядок). */
  withSnippets?: boolean;
}

/** Постраничный список писем в папке (новые первыми). */
export async function listMessages(client: ImapFlow, args: ListMessagesArgs): Promise<MessageListPage> {
  const { folder, offset, limit, filter, search, withSnippets = true } = args;
  const lock = await client.getMailboxLock(folder.path);
  try {
    /*
     * NOOP перед поиском заставляет почтовый сервер пересмотреть папку.
     *
     * Соединение берётся из пула и живёт между запросами с уже выбранной
     * папкой. Поиск по такой папке идёт по индексу, а новые письма индекс
     * подхватывает не сразу — у Dovecot по своему расписанию. Из-за этого
     * список отставал ровно на одно письмо: самое свежее не показывалось
     * никогда, пока человек не перезагрузит страницу.
     *
     * Симптом был приметный: счётчик непрочитанных рос, а письма в списке не
     * было. Так и есть — счётчик считается отдельной командой, которая
     * открывает папку заново и потому всегда свежа, а список берётся поиском
     * по уже открытой.
     *
     * NOOP ровно для этого в протоколе и предусмотрен: он просит сервер
     * досказать всё, что накопилось. Стоит один оборот к серверу.
     */
    await client.noop();

    const query = buildSearchQuery(filter, search);
    // Отказ поиска — это ошибка, а не пустой ящик (см. searchUids)
    let uids = await searchUids(client, query);
    // Новые письма первыми: UID возрастает со временем
    uids.sort((a, b) => b - a);

    if (wantsAttachments(filter, search) && uids.length > 0) {
      const kept = await selectUidsWithAttachments(client, uids);
      uids = uids.filter((uid) => kept.has(uid));
    }

    const pageUids = uids.slice(offset, offset + limit);
    const items: MessageSummary[] = [];

    if (pageUids.length > 0) {
      const fetched = await client.fetchAll(pageUids, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        size: true,
        internalDate: true,
        // Сырой заголовок темы — чтобы восстановить её, если отправитель
        // прислал восьмибитные байты без кодирования по RFC 2047 (старые
        // почтовые программы так делают до сих пор). Стоит несколько
        // десятков байт на письмо; см. mail/header-charset.ts.
        headers: ['subject'],
      }, { uid: true });
      fetched.sort((a, b) => b.uid - a.uid);
      for (const msg of fetched) {
        const snippet = withSnippets ? await fetchSnippet(client, msg) : '';
        items.push(buildSummary({
          folderId: folder.id,
          msg,
          snippet,
          rawHeaders: msg.headers,
        }));
      }
    }

    return { items, total: uids.length, offset, limit };
  } finally {
    lock.release();
  }
}

/**
 * Отбирает из списка те UID, которые в папке действительно есть.
 *
 * Нужно, чтобы не врать в ответе: раньше `{updated}` и `{moved}` считались
 * по длине присланного списка, поэтому операция над несуществующим письмом
 * бодро отвечала `{"updated":1}`. Ящик при этом не менялся.
 */
export async function existingUids(client: ImapFlow, uids: number[]): Promise<number[]> {
  if (uids.length === 0) return [];
  const present = new Set<number>();
  // Тот же разбор по командам и тот же честный отказ, что и в списке писем:
  // «поиск не выполнен» не должно превращаться в «письма не найдены»,
  // иначе ответ `{"updated":0}` соврёт про нетронутый ящик.
  for (const range of chunkUidSets(uids)) {
    for (const uid of await searchUids(client, { uid: range })) present.add(uid);
  }
  return uids.filter((uid) => present.has(uid));
}

/**
 * Ставит флаг «отвечено» (`\Answered`) на письме с указанным Message-ID.
 *
 * Зачем в API, а не в интерфейсе: флаг живёт в ящике, а не в браузере —
 * стрелку «отвечено» должны видеть и другие клиенты (телефон, Thunderbird),
 * и она должна пережить перезагрузку страницы. Письмо ищется по заголовку
 * Message-ID, потому что именно он приходит в `inReplyTo` при ответе.
 *
 * Черновики и корзину не обходим: там ответа быть не может, а лишний
 * SELECT на каждую отправку стоит времени. Ошибки наружу не выпускаем —
 * письмо уже отправлено, и неудача с флагом не должна её отменять.
 */
export async function markAnswered(client: ImapFlow, messageId: string): Promise<boolean> {
  // Message-ID приходит и в угловых скобках, и без них; HEADER ищет
  // подстроку, поэтому надёжнее искать по содержимому без скобок.
  const needle = messageId.trim().replace(/^<|>$/g, '').trim();
  if (!needle) return false;

  const folders = await listFolders(client);
  const searchOrder = folders.filter((f) => f.role !== 'drafts' && f.role !== 'trash');
  // Отвечают чаще всего на письмо из «Входящих» — с них и начинаем
  searchOrder.sort((a, b) => (a.role === 'inbox' ? -1 : 0) - (b.role === 'inbox' ? -1 : 0));

  for (const folder of searchOrder) {
    const lock = await client.getMailboxLock(folder.path);
    try {
      const found = await searchUids(client, { header: { 'message-id': needle } });
      if (found.length === 0) continue;
      await client.messageFlagsAdd(found, ['\\Answered'], { uid: true });
      return true;
    } finally {
      lock.release();
    }
  }
  return false;
}

/** Группирует составные id писем по папкам: folderId -> uid[]. */
export function groupIdsByFolder(ids: string[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const id of ids) {
    const { folderId, uid } = splitMessageId(id);
    const list = map.get(folderId);
    if (list) {
      list.push(uid);
    } else {
      map.set(folderId, [uid]);
    }
  }
  return map;
}
