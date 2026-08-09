/**
 * Операции над почтовым ящиком поверх открытого IMAP-соединения.
 */
import type { ImapFlow, FetchMessageObject, MessageStructureObject, SearchObject } from 'imapflow';
import {
  ftsSafeText,
  parseSearch,
  type Folder,
  type MailAddress,
  type MessageFilter,
  type MessageListPage,
  type MessageSummary,
  type ThreadSummary,
} from '@mail-true/shared';
import { NotFoundError, BadRequestError, UpstreamUnavailableError } from '../errors.js';
import { mapFolders, findFolderById, type RawFolderInfo } from '../mail/folders.js';
import { isUserLabelKey } from '../mail/labels.js';
import { buildSummary, labelsFromSet, mapAddress } from '../mail/summary.js';
import { collectAttachments, hasRealAttachments, pickTextPart } from '../mail/structure.js';
import { decodeBuffer, htmlToText, makeSnippet } from '../mail/text.js';
import {
  THREAD_ALGORITHM,
  THREAD_CAPABILITY,
  buildThreadRows,
  parseThreadGroups,
  threadingAllowed,
} from '../mail/threads.js';

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
        status = await client.status(item.path, {
          messages: true,
          unseen: true,
          uidValidity: true,
        });
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
  // «Отложенные» заводятся при первом же отложенном письме и только тогда:
  // папка, которой человек не пользуется, не должна висеть в дереве.
  // Английское имя, как и у остальных служебных папок, — так ящик остаётся
  // понятным в любой почтовой программе; по-русски её называет интерфейс.
  snoozed: 'Snoozed',
  // «Заглушённые» заводятся при первой же заглушённой переписке — как и
  // «Отложенные», и по той же причине: папка, которой человек не
  // пользуется, не должна висеть в дереве. Имя английское: его пишет
  // в правило доставки Sieve (settings/sieve-muted.ts), и оно обязано
  // совпадать здесь и там.
  muted: 'Muted',
};

/**
 * Как requireFolder, но недостающую системную папку (например, «Архив»)
 * создаёт автоматически — так ведут себя привычные почтовые интерфейсы.
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

/**
 * Границы дат для IMAP: строкой, а не объектом Date, и «до» — включительно.
 *
 * Здесь два разных подвоха, и оба видны только на живом сервере.
 *
 * ПЕРВЫЙ. imapflow, если сервер объявил расширение WITHIN (Dovecot его
 * объявляет), НЕ отправляет `BEFORE`/`SINCE` вовсе: он переводит дату в
 * «столько-то секунд назад» и шлёт `OLDER`/`YOUNGER`
 * (search-compiler.js, ветка WITHIN). Граница из дневной становится
 * посекундной, и `до:2026-08-01` превращается в «старше момента 1 августа
 * 00:00» — весь первый день августа пропадает, хотя подсказка и чип
 * обещают «не позже этой даты». Хуже того, на сегодняшней дате счёт
 * секунд даёт ноль, уходит `UID SEARCH OLDER 0`, и Dovecot отвечает
 * `BAD Invalid search interval parameter` — поиск не сужается, а
 * ОТКАЗЫВАЕТ целиком. Проверено на стенде: `до:<сегодня>` — 503.
 *
 * Строка эту ветку обходит (`isDate` для неё ложно), и к серверу уходит
 * настоящее `BEFORE 02-Aug-2026`, которое Dovecot сравнивает по дню.
 *
 * ВТОРОЙ. `BEFORE` у IMAP значит «строго раньше этого дня». Поэтому
 * серверу называется СЛЕДУЮЩИЙ день: «раньше 2 августа» и есть «не позже
 * 1-го». `SINCE` день уже включает, ему сдвиг не нужен.
 */
function imapDate(value: Date, plusDay = false): string {
  const day = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  if (plusDay) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString();
}

export function buildSearchQuery(
  filter: MessageFilter,
  search: string | undefined,
  label?: string | undefined,
): SearchObject {
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
  if (parsed.subject) query.subject = ftsSafeText(parsed.subject);
  if (parsed.since) query.since = imapDate(parsed.since);
  if (parsed.before) query.before = imapDate(parsed.before, true);
  if (parsed.seen !== null) query.seen = parsed.seen;
  if (parsed.flagged !== null) query.flagged = parsed.flagged;
  /*
   * Размер письма считает сам почтовый сервер (`LARGER` / `SMALLER`), а не
   * мы после выборки: размер лежит в индексе, и отбор по нему не стоит ни
   * одного лишнего FETCH.
   *
   * Речь о размере ПИСЬМА, а не вложения: в письме вложение едет в base64
   * и весит примерно на треть больше файла. Обещать здесь «вложения больше
   * 5 МБ» было бы неправдой, поэтому и подсказка говорит «письма тяжелее».
   */
  if (parsed.larger !== null) query.larger = parsed.larger;
  if (parsed.smaller !== null) query.smaller = parsed.smaller;
  /*
   * `папка:` здесь намеренно НЕ применяется. У IMAP папка — не условие
   * поиска, а то, что открыто до поиска; выбирает её вызывающий
   * (`folderId` в маршруте, область поиска в браузере). Разбирается
   * оператор ради одного: чтобы `папка:Рассылки` не ушло в полнотекстовый
   * поиск обычными словами и не отдало пустоту.
   */
  if (parsed.text) {
    /*
     * TEXT ищет и по заголовкам, и по телу.
     *
     * Строка проходит через `ftsSafeText`: слово вида «452/26» полнотекстовый
     * движок делит на «452» и «26» и требует обе части, а части короче трёх
     * букв в индексе не существует — условие невыполнимо, и письмо со своей
     * же темой в теме не находится (см. шапку ftsSafeText). Адресные условия
     * (`от:`, `кому:`, `копия:`) через это НЕ пропускаются: там значение
     * ищется целиком одной строкой, и дробить его нельзя.
     */
    query.text = ftsSafeText(parsed.text);
  }
  /*
   * Отбор по своей метке — командой IMAP `KEYWORD`, а не перебором
   * загруженных строк.
   *
   * Почему именно здесь: метка живёт в письме ключевым словом, и Dovecot
   * ищет по ключевым словам своим индексом — тем же, которым отвечает на
   * весь остальной поиск. Отбор по уже загруженной странице отвечал бы
   * «три письма» там, где помечено сто: в папке на двадцать тысяч писем
   * загруженного всегда меньше, чем есть.
   *
   * Условие складывается с остальными (IMAP соединяет их логическим И),
   * поэтому «непрочитанные с меткой» работает без единой оговорки.
   *
   * ЗАМОК. Отбирать можно ТОЛЬКО пользовательскую метку. Пусти сюда любую
   * строку — и `label=$Snoozed` стал бы отбором по служебной пометке
   * продукта, то есть показал бы список, которого в интерфейсе нет и
   * значения которого человек знать не может. `isUserLabelKey` проверяет
   * и приставку `mt-`, и набор символов, и отсутствие в служебном списке;
   * проверка стоит в сборке запроса, а не в разборе строки запроса, чтобы
   * её нельзя было обойти ни одним вызывающим.
   */
  if (label !== undefined && label !== '') {
    if (!isUserLabelKey(label)) {
      throw new BadRequestError(`Это не пользовательская метка: ${label}`);
    }
    query.keyword = label;
  }
  return query;
}

/**
 * Отбор по вложениям после поиска: нужен ли и с каким именем файла.
 *
 * Разбор BODYSTRUCTURE — единственный работающий способ (см.
 * keepUidsWithAttachments), а имени файла в индексе Dovecot нет вовсе:
 * `filename:` у Gmail — это отдельное поле их собственного индекса, у IMAP
 * такого условия поиска не существует. Поэтому имя сверяется здесь, по той
 * же самой BODYSTRUCTURE, которой уже отбирается «с вложениями», — лишней
 * команды к серверу это не стоит.
 */
export interface AttachmentFilter {
  /** Нужен ли отбор вообще. */
  required: boolean;
  /** Кусок имени файла или расширение; пусто — любое вложение. */
  filename: string | null;
}

export function attachmentFilter(
  filter: MessageFilter,
  search: string | undefined,
): AttachmentFilter {
  const parsed = parseSearch(search);
  return {
    required: filter === 'with-attachments' || parsed.hasAttachment,
    filename: parsed.filename,
  };
}

/**
 * Подходит ли имя файла под кусок из запроса.
 *
 * Сравнение по подстроке и без регистра: человек пишет `файл:.pdf`, `файл:pdf`
 * и `файл:договор` с одним и тем же намерением — «где-то в имени это есть».
 * Требовать точного имени значило бы, что оператором нельзя пользоваться,
 * не помня имя файла целиком, — а помнят его почти никогда.
 */
export function attachmentNameMatches(names: readonly string[], needle: string): boolean {
  const wanted = needle
    .trim()
    .toLowerCase()
    .replace(/^\*+|\*+$/gu, '');
  if (wanted === '') return true;
  return names.some((name) => name.toLowerCase().includes(wanted));
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
      'Почтовый сервер не смог выполнить поиск. Повторите попытку позже.',
    );
  }
  return found;
}

/**
 * IMAP STORE, который не выдаёт отказ за успех.
 *
 * Та же ловушка, что и у SEARCH выше, и ровно тот же исход: imapflow при
 * неудаче команды STORE ошибку НЕ бросает, а возвращает `false`
 * (node_modules/imapflow/lib/commands/store.js, `catch { … return false; }`).
 * Отличие от APPEND, который в том же пакете заканчивается `throw err`, — и
 * вся разница цены: маршруты массовых действий писали `updated +=
 * present.length` сразу после вызова и отвечали «сделано N» о письмах, у
 * которых не изменилось ничего.
 *
 * Дороже всего это стоило снятию метки: справочник метку терял, а ключевое
 * слово `mt-…` оставалось на письмах навсегда — снять его больше нечем
 * (метки уже нет), а освободившийся ключ достаётся следующей метке с
 * созвучным именем, и она мгновенно оказывается на чужих письмах.
 *
 * Нарезка обязательна по той же причине, что и у поиска с вложениями:
 * весь список номеров одной строкой Dovecot отвергает как «Too long
 * argument» примерно с двенадцати тысяч писем — то есть ровно на тех
 * ящиках, ради которых массовые действия и нужны.
 */
export async function storeFlags(
  client: ImapFlow,
  uids: number[],
  flags: string[],
  action: 'add' | 'remove',
): Promise<void> {
  for (const range of chunkUidSets(uids)) {
    const ok =
      action === 'add'
        ? await client.messageFlagsAdd(range, flags, { uid: true })
        : await client.messageFlagsRemove(range, flags, { uid: true });
    if (ok === false) {
      throw new UpstreamUnavailableError(
        'Почтовый сервер не изменил пометки писем. Повторите попытку позже.',
      );
    }
  }
}

/**
 * IMAP MOVE с честным числом перенесённых писем.
 *
 * `messageMove` возвращает либо описание переноса, либо `false` — и второе
 * маршруты принимали за успех: `moved += present.length`. Отказать MOVE
 * может буднично: ящик у квоты (`NO [OVERQUOTA]`) или папку-получатель
 * удалили из соседней вкладки между её созданием и переносом
 * (`NO [TRYCREATE]`). Ответ при этом был «перенесено 25» с кодом 200,
 * браузер убирал строки из списка, и человек уходил в полной уверенности,
 * что письма убраны. В журнале не оставалось ничего: свой журнал imapflow
 * у нас выключен.
 *
 * Возвращаем число писем, о которых сервер подтвердил перенос: `uidMap`
 * есть там, где поддержан UIDPLUS, иначе считаем по размеру порции —
 * команда выполнена, и это уже не догадка, а ответ сервера.
 */
export async function moveUids(client: ImapFlow, uids: number[], path: string): Promise<number> {
  let moved = 0;
  for (const range of chunkUidSets(uids)) {
    const result = await client.messageMove(range, path, { uid: true });
    if (result === false) {
      throw new UpstreamUnavailableError(
        'Почтовый сервер не перенёс письма. Возможно, кончилось место в ящике. ' +
          'Повторите попытку позже.',
      );
    }
    const mapped = typeof result === 'object' ? result.uidMap?.size : undefined;
    moved += mapped ?? countUids(range);
  }
  return moved;
}

/** Сколько писем в наборе вида `1,4:6,9` — для честного счёта перенесённых. */
export function countUids(range: string): number {
  let total = 0;
  for (const part of range.split(',')) {
    const [from, to] = part.split(':');
    const start = Number(from);
    const end = to === undefined ? start : Number(to);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    total += Math.abs(end - start) + 1;
  }
  return total;
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
export function keepUidsWithAttachments(
  fetched: UidWithStructure[],
  filename: string | null = null,
): Set<number> {
  const kept = new Set<number>();
  for (const msg of fetched) {
    if (!hasRealAttachments(msg.bodyStructure)) continue;
    if (filename !== null) {
      // Встроенные картинки именем файла не отбираются: человек, спросивший
      // `файл:.png`, ищет приложенный файл, а не подпись из письма.
      const names = collectAttachments(msg.bodyStructure)
        .filter((a) => !a.inline)
        .map((a) => a.filename);
      if (!attachmentNameMatches(names, filename)) continue;
    }
    kept.add(msg.uid);
  }
  return kept;
}

/**
 * Запрашивает BODYSTRUCTURE по частям и оставляет письма с вложениями.
 * Разбиение по командам — обязательное: см. chunkUidSets.
 */
async function selectUidsWithAttachments(
  client: ImapFlow,
  uids: number[],
  filename: string | null,
): Promise<Set<number>> {
  const kept = new Set<number>();
  for (const range of chunkUidSets(uids)) {
    const structures = await client.fetchAll(
      range,
      { uid: true, bodyStructure: true },
      { uid: true },
    );
    for (const uid of keepUidsWithAttachments(structures, filename)) kept.add(uid);
  }
  return kept;
}

/** Пытается получить сниппет письма, скачав начало текстовой части. */
/*
 * Экспортируется ради уведомлений о новой почте (см. src/push/messages.ts):
 * «первые фразы письма» во всплывающем окне обязаны быть теми же самыми,
 * что человек видит в списке. Своя вторая реализация сниппета неизбежно
 * разошлась бы с этой — по обрезке, по разбору HTML или по кодировке.
 */
export async function fetchSnippet(client: ImapFlow, msg: FetchMessageObject): Promise<string> {
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

/**
 * То немногое, что нужно от соединения для команды THREAD.
 *
 * Своего метода для THREAD у imapflow нет (в lib/commands/ его просто не
 * существует), но есть `exec` — отправка произвольной команды с разбором
 * нетегированных ответов. В объявлениях типов библиотеки `exec` не описан,
 * поэтому здесь описано ровно то, чем мы пользуемся: узкий интерфейс вместо
 * `any` по всему файлу.
 */
interface ThreadCapableClient {
  capabilities: Map<string, boolean | number>;
  exec(
    command: string,
    attributes: Array<{ type: string; value: string }>,
    options: {
      untagged: Record<string, (untagged: { attributes?: unknown }) => Promise<void>>;
    },
  ): Promise<{ next(): void }>;
}

/**
 * Просит почтовый сервер собрать переписки во всей открытой папке.
 *
 * `null` — сервер не умеет THREAD=REFS. Это не ошибка и не повод отказать
 * в списке: письма никуда не делись, просто они не сгруппированы. Дефект
 * «список не открывается» был бы хуже дефекта «список не сгруппирован» на
 * порядок, а разница видна человеку сразу и без сообщений.
 *
 * А вот ОТКАЗ самой команды наружу выпускается: это неисправность сервера
 * (обычно испорченный индекс), и молча показывать вместо переписок плоский
 * список значило бы прятать поломку — ровно та ошибка, которую здесь уже
 * один раз допустили с поиском (см. searchUids).
 *
 * Почему `ALL`, а не наши условия поиска: ответ THREAD по всей папке
 * Dovecot считает по индексу и отдаёт быстро (замер: 478 писем — 9 мс),
 * а пересечение с найденным делается на нашей стороне за один проход
 * (buildThreadRows). Две команды с раздельно составленными условиями рано
 * или поздно разошлись бы между собой — и разошлись бы молча.
 */
export async function fetchThreadGroups(client: ImapFlow): Promise<number[][] | null> {
  const capable = client as unknown as ThreadCapableClient;
  if (!capable.capabilities?.has(THREAD_CAPABILITY)) return null;

  const groups: number[][] = [];
  try {
    const response = await capable.exec(
      'UID THREAD',
      [
        { type: 'ATOM', value: THREAD_ALGORITHM },
        // Кодировка запроса. У нас условие `ALL`, строк в нём нет, но
        // аргумент по RFC 5256 обязателен.
        { type: 'ATOM', value: 'UTF-8' },
        { type: 'ATOM', value: 'ALL' },
      ],
      {
        untagged: {
          THREAD: async (untagged) => {
            for (const group of parseThreadGroups(untagged.attributes)) groups.push(group);
          },
        },
      },
    );
    // Разбор ответа держит поток: пока не отпустили, сервер не читается
    // дальше. Ровно так же поступают собственные команды imapflow.
    response.next();
  } catch {
    throw new UpstreamUnavailableError(
      'Почтовый сервер не смог собрать переписки. Повторите попытку позже.',
    );
  }
  return groups;
}

/** Собирает сводку переписки по её письмам (старые первыми). */
export function summarizeThread(
  folderId: string,
  messages: readonly FetchMessageObject[],
): ThreadSummary {
  const participants: MailAddress[] = [];
  const seenAddresses = new Set<string>();
  let unreadCount = 0;
  let flagged = false;
  let hasAttachments = false;
  /*
   * Метки разговора. Ключ набора — слово в НИЖНЕМ регистре: ключевые слова
   * у Dovecot нечувствительны к регистру, и `MT-OPLATIT` на одном письме и
   * `mt-oplatit` на другом — это одна метка, а не две пилюли в строке.
   * Показываем при этом первое написание, а не приведённое: справочник
   * ищет метку по ключу без учёта регистра всё равно.
   */
  const labels: string[] = [];
  const seenLabels = new Set<string>();

  for (const msg of messages) {
    if (!msg.flags?.has('\\Seen')) unreadCount += 1;
    if (msg.flags?.has('\\Flagged')) flagged = true;
    if (hasRealAttachments(msg.bodyStructure)) hasAttachments = true;
    // Тот же отбор, что и у отдельного письма (buildSummary): системные
    // флаги и служебные слова продукта в метки не попадают ни здесь, ни там.
    for (const label of labelsFromSet(msg.flags)) {
      const key = label.toLowerCase();
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
      labels.push(label);
    }

    const from = mapAddress(msg.envelope?.from?.[0]);
    // Один и тот же человек в переписке пишет много раз — в колонке
    // отправителя он должен стоять один раз и на своём месте по времени.
    const key = from.address.toLowerCase();
    if (from.address && !seenAddresses.has(key)) {
      seenAddresses.add(key);
      participants.push(from);
    }
  }

  return {
    messageIds: messages.map((msg) => `${folderId}:${String(msg.uid)}`),
    count: messages.length,
    unreadCount,
    labels,
    flagged,
    hasAttachments,
    participants,
  };
}

export interface ListMessagesArgs {
  folder: Folder;
  offset: number;
  limit: number;
  filter: MessageFilter;
  search?: string | undefined;
  /**
   * Отбор по своей метке — ключевое слово IMAP (`mt-oplatit`).
   *
   * Уходит в поиск командой `KEYWORD`, то есть отбирает по ВСЕЙ папке,
   * а не по загруженной странице. С группировкой уживается сам собой:
   * строка-разговор собирается из писем, прошедших поиск, поэтому
   * разговор попадает в отбор, если метка стоит хоть на одном его письме.
   */
  label?: string | undefined;
  /** Загружать ли сниппеты (дороже на порядок). */
  withSnippets?: boolean;
  /**
   * Группировать письма в переписки: строка списка — одна на разговор.
   *
   * Просьба, а не приказ: в папках, где переписка мешает искать письмо
   * (черновики, корзина, спам, отложенные), сервер её не применит —
   * см. threadingAllowed. Решение принимается здесь намеренно, чтобы
   * недостижимого черновика нельзя было получить ни от какого клиента.
   */
  threaded?: boolean;
}

/**
 * Поля письма, которых хватает на строку списка.
 *
 * Один набор на оба пути — плоский список и список переписок: строка
 * переписки собирается из тех же данных, что и строка письма, и разойтись
 * этим двум наборам нельзя (иначе, например, скрепка у переписки считалась
 * бы иначе, чем у отдельного письма).
 */
const LIST_FETCH_FIELDS = {
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
  // Authentication-Results — результат проверки подлинности
  // отправителя, вписанный НАШИМ сервером при приёме. Нужен, чтобы
  // решить, можно ли показать в кружке логотип домена: логотип
  // читается как знак подлинности, и рядом с непроверенным письмом
  // он опаснее, чем его отсутствие (см. mail/sender-auth.ts).
  // Стоит ещё сотню байт на письмо и ни одного лишнего оборота
  // к серверу: заголовок едет тем же ответом, что и тема.
  headers: ['subject', 'authentication-results'],
};

/**
 * Забирает письма страницы по номерам.
 *
 * Номера разбиваются на несколько команд (chunkUidSets): страница переписок
 * — это не двадцать пять номеров, а все письма двадцати пяти разговоров,
 * и одной строкой они могут не поместиться в предел длины команды IMAP.
 */
async function fetchListMessages(
  client: ImapFlow,
  uids: readonly number[],
): Promise<Map<number, FetchMessageObject>> {
  const byUid = new Map<number, FetchMessageObject>();
  for (const range of chunkUidSets([...uids])) {
    const fetched = await client.fetchAll(range, LIST_FETCH_FIELDS, { uid: true });
    for (const msg of fetched) byUid.set(msg.uid, msg);
  }
  return byUid;
}

/** Постраничный список писем в папке (новые первыми). */
export async function listMessages(
  client: ImapFlow,
  args: ListMessagesArgs,
): Promise<MessageListPage> {
  const { folder, offset, limit, filter, search, label, withSnippets = true } = args;
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

    const query = buildSearchQuery(filter, search, label);
    // Отказ поиска — это ошибка, а не пустой ящик (см. searchUids)
    let uids = await searchUids(client, query);
    // Новые письма первыми: UID возрастает со временем
    uids.sort((a, b) => b - a);

    const attachments = attachmentFilter(filter, search);
    if (attachments.required && uids.length > 0) {
      const kept = await selectUidsWithAttachments(client, uids, attachments.filename);
      uids = uids.filter((uid) => kept.has(uid));
    }

    /*
     * Группировка спрашивается у почтового сервера ОДИН раз на запрос
     * списка и только когда её и просили, и разрешает папка. Пустой ответ
     * (`null`) означает «сервер не умеет» — дальше идёт обычный плоский
     * путь, тот же самый, что и раньше.
     */
    const groups =
      args.threaded === true && threadingAllowed(folder.role)
        ? await fetchThreadGroups(client)
        : null;

    if (groups) {
      /*
       * Отбор и группировка встречаются здесь, и правило у них одно на
       * всех: строка собирается из писем, ПРОШЕДШИХ поиск. Для отбора по
       * метке это ровно то, что нужно, — разговор попадает в список, если
       * метка стоит хоть на одном его письме, потому что это письмо
       * оказалось в `uids` и потянуло за собой свою строку.
       *
       * И строка при этом представляет помеченные письма, а не весь
       * разговор целиком — то же самое, что под отбором «непрочитанные»
       * (см. buildThreadRows). Иначе действие над строкой уходило бы на
       * письма, которых человек в отборе не выбирал.
       */
      const rows = buildThreadRows(groups, uids);
      const pageRows = rows.slice(offset, offset + limit);
      const fetched = await fetchListMessages(client, pageRows.flat());
      const items: MessageSummary[] = [];

      for (const row of pageRows) {
        const messages = row
          .map((uid) => fetched.get(uid))
          .filter((msg): msg is FetchMessageObject => msg !== undefined);
        // Письмо могли удалить между поиском и выборкой. Строка без единого
        // письма — это не пустая строка, это отсутствие строки.
        const latest = messages[messages.length - 1];
        if (!latest) continue;
        // Сниппет — только у письма, которое видно в строке. Остальные
        // письма переписки в строке не показаны, и качать их начало
        // означало бы платить за то, чего никто не увидит.
        const snippet = withSnippets ? await fetchSnippet(client, latest) : '';
        items.push({
          ...buildSummary({
            folderId: folder.id,
            msg: latest,
            snippet,
            rawHeaders: latest.headers,
          }),
          thread: summarizeThread(folder.id, messages),
        });
      }

      // `total` — число ПЕРЕПИСОК, а не писем: это то, сколько строк
      // покажет список. Иначе подгрузка следующих страниц считала бы
      // остаток по чужой единице измерения и не остановилась бы вовремя.
      return { items, total: rows.length, offset, limit };
    }

    const pageUids = uids.slice(offset, offset + limit);
    const items: MessageSummary[] = [];

    if (pageUids.length > 0) {
      const fetched = [...(await fetchListMessages(client, pageUids)).values()];
      fetched.sort((a, b) => b.uid - a.uid);
      for (const msg of fetched) {
        const snippet = withSnippets ? await fetchSnippet(client, msg) : '';
        items.push(
          buildSummary({
            folderId: folder.id,
            msg,
            snippet,
            rawHeaders: msg.headers,
          }),
        );
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
