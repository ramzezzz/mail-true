/**
 * Применение правила к уже полученным письмам.
 *
 * Sieve работает только при доставке: новое правило на старую почту не
 * действует. Интерфейс mail.ru это учитывает отдельным действием
 * «Применить к письмам, которые уже находятся в папках», и оно нужно нам
 * ровно по той же причине — иначе смысл правила теряется, пока не придёт
 * следующее письмо.
 *
 * Условия здесь проверяются в API, а не в Dovecot: прогнать Sieve по уже
 * лежащим письмам нечем. Поэтому сравнение реализовано отдельно и
 * покрыто тестами — расхождение с Sieve означало бы правило, которое
 * «на новых письмах работает не так, как на старых».
 *
 * Что применяется: папка, «прочитано», «флажок», метки и удаление.
 * Пересылка копии и автоответ намеренно НЕ применяются к старой почте:
 * разослать письма задним числом нельзя отменить.
 */
import type { ImapFlow } from 'imapflow';
import type { Folder } from '@mail-true/shared';
import { listFolders } from '../imap/service.js';
import { hasRealAttachments, pickTextPart } from '../mail/structure.js';
import { decodeBuffer, htmlToText } from '../mail/text.js';
import type { FilterCondition, FilterRule } from './types.js';

/**
 * Сколько байтов текстовой части читать ради условия по тексту письма.
 *
 * Sieve при доставке смотрит текст целиком, здесь же за каждым письмом
 * нужен отдельный поход в IMAP, и прогон по папке из тысячи писем должен
 * заканчиваться в этой жизни. Ста килобайт хватает на текст любого
 * письма, какой человек читает глазами; вложения не читаются вовсе —
 * скачивается ровно одна текстовая часть (pickTextPart).
 */
export const BODY_SCAN_LIMIT = 100 * 1024;

/** Поля письма, участвующие в сравнении. */
export interface MatchableMessage {
  from: string;
  to: string;
  cc: string;
  subject: string;
  resentFrom: string;
  resentTo: string;
  /** Размер письма в байтах. */
  size: number;
  /** Текст письма без разметки. Пусто — не читали или его нет. */
  body: string;
  /** Есть ли настоящее (не встроенное в вёрстку) вложение. */
  hasAttachment: boolean;
}

function fieldValue(msg: MatchableMessage, field: FilterCondition['field']): string {
  switch (field) {
    case 'from':
      return msg.from;
    case 'to':
      return msg.to;
    case 'cc':
      return msg.cc;
    case 'subject':
      return msg.subject;
    case 'resent-from':
      return msg.resentFrom;
    case 'resent-to':
      return msg.resentTo;
    case 'body':
      return msg.body;
    case 'size':
      return String(msg.size);
    case 'attachment':
      return '';
  }
}

/**
 * Шаблон Sieve :matches в регулярное выражение.
 * Спецсимволы Sieve ровно два: '*' (любая последовательность) и
 * '?' (один символ); остальное — литералы.
 */
function matchesPattern(value: string, pattern: string): boolean {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(value);
}

/** Проверяет одно условие правила. Регистр не учитывается — как в Sieve по умолчанию. */
export function matchesCondition(msg: MatchableMessage, condition: FilterCondition): boolean {
  if (condition.field === 'size') {
    const kb = Number(condition.value) || 0;
    const limit = kb * 1024;
    return condition.op === 'less' ? msg.size < limit : msg.size > limit;
  }
  if (condition.field === 'attachment') {
    return condition.op === 'has-not' ? !msg.hasAttachment : msg.hasAttachment;
  }
  const value = fieldValue(msg, condition.field).toLowerCase();
  const needle = condition.value.replace(/\s+/g, ' ').trim().toLowerCase();
  switch (condition.op) {
    case 'contains':
      return value.includes(needle);
    case 'not-contains':
      return !value.includes(needle);
    case 'is':
      return value === needle;
    case 'not-is':
      return value !== needle;
    case 'matches':
      return matchesPattern(value, needle);
    case 'not-matches':
      return !matchesPattern(value, needle);
    default:
      return false;
  }
}

/** Проверяет правило целиком (без учёта спам-защиты — она задаётся выбором папок). */
export function matchesRule(msg: MatchableMessage, rule: FilterRule): boolean {
  if (rule.conditions.length === 0) return true;
  return rule.matchMode === 'any'
    ? rule.conditions.some((c) => matchesCondition(msg, c))
    : rule.conditions.every((c) => matchesCondition(msg, c));
}

/* ------------------------------------------------------------------ */
/* Применение по IMAP                                                   */
/* ------------------------------------------------------------------ */

/** Склеивает список адресов в строку «Имя <адрес>, …» для сравнения. */
function joinAddresses(list: Array<{ name?: string; address?: string }> | undefined): string {
  if (!list) return '';
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .join(', ');
}

function headerLine(headers: Map<string, string[]> | undefined, name: string): string {
  const value = headers?.get(name);
  return value ? value.join(', ') : '';
}

export interface ApplyResult {
  /** Сколько писем просмотрено. */
  scanned: number;
  /** Сколько подошло под условия. */
  matched: number;
  /** Сколько переложено в папку. */
  moved: number;
  /** Сколько помечено прочитанными, флажком или меткой. */
  flagged: number;
  /** Сколько удалено (в корзину или безвозвратно). */
  deleted: number;
  /** Папки, по которым прошлись (полные пути). */
  folders: string[];
  /** Достигнут ли предел просмотра писем. */
  limitReached: boolean;
}

export interface ApplyOptions {
  rule: FilterRule;
  /** Полные пути папок, по которым прогонять правило. */
  folderPaths: string[];
  /** Максимум писем к просмотру (защита от многочасовой операции). */
  maxMessages: number;
}

/**
 * Текст письма для условия по телу.
 *
 * Читается ровно одна текстовая часть — та же, из которой берётся начало
 * письма в списке (imap/service.ts, fetchSnippet). Sieve при доставке
 * смотрит все текстовые части сразу; расхождение возможно только у писем,
 * где текст разложен по нескольким частям, и оно в пользу осторожности:
 * лучше не найти, чем найти в куске письма, которого человек не видит.
 *
 * Ошибка чтения — не повод ронять весь прогон: письмо просто не подойдёт
 * под условие по тексту, как если бы текста в нём не было.
 */
async function fetchBodyText(
  client: ImapFlow,
  uid: number,
  structure: Parameters<typeof pickTextPart>[0],
): Promise<string> {
  const ref = pickTextPart(structure);
  if (!ref) return '';
  try {
    const dl = await client.download(String(uid), ref.part, {
      uid: true,
      maxBytes: BODY_SCAN_LIMIT,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of dl.content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const text = decodeBuffer(Buffer.concat(chunks), dl.meta.charset);
    return ref.kind === 'html' ? htmlToText(text) : text;
  } catch {
    return '';
  }
}

/**
 * Прогоняет правило по указанным папкам.
 *
 * Перекладывание идёт последним и пакетом: сначала выставляем флаги на
 * найденных письмах, потом переносим — иначе после переноса UID меняются
 * и флаги пришлось бы искать заново.
 */
export async function applyRuleToMailbox(
  client: ImapFlow,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const { rule, folderPaths, maxMessages } = options;
  const folders: Folder[] = await listFolders(client);
  const byPath = new Map(folders.map((f) => [f.path, f]));

  const result: ApplyResult = {
    scanned: 0,
    matched: 0,
    moved: 0,
    flagged: 0,
    deleted: 0,
    folders: [],
    limitReached: false,
  };

  /*
   * Строение письма и его текст запрашиваются ТОЛЬКО когда правило о них
   * спрашивает. Иначе прогон обычного правила «от кого» подорожал бы
   * втрое на пустом месте: за строением идёт отдельный BODYSTRUCTURE,
   * а за текстом — по походу в IMAP на каждое письмо.
   */
  const needsStructure = rule.conditions.some((c) => c.field === 'attachment');
  const needsBody = rule.conditions.some((c) => c.field === 'body');

  const deleteMode = rule.actions.deleteMessage;
  // Корзина ищется по РОЛИ, а не по имени: имя папки зависит от языка
  // клиента, которым ящик заводили, а роль ставит наш же listFolders.
  const trashPath = folders.find((f) => f.role === 'trash')?.path ?? null;
  const targetPath = deleteMode === 'trash' ? trashPath : deleteMode ? null : rule.actions.folder;

  for (const path of folderPaths) {
    if (!byPath.has(path)) continue;
    if (targetPath && path === targetPath) continue; // перекладывать в себя нечего
    /*
     * Безвозвратное удаление по корзине не гоняем никогда, даже если
     * человек её выбрал: правило «удалить» ставят ради входящих, а
     * корзина — это уже удалённое, и добить её насовсем одним нажатием
     * человек не просил. То же и для «в корзину»: перекладывать корзину
     * в корзину бессмысленно (случай выше).
     */
    if (deleteMode === 'purge' && trashPath !== null && path === trashPath) continue;
    result.folders.push(path);

    const lock = await client.getMailboxLock(path);
    try {
      // Соединение живёт в пуле и могло держать эту папку выбранной ещё
      // до прихода новых писем: тогда getMailboxLock не делает повторный
      // SELECT, и правило прогонится по устаревшему составу папки.
      // NOOP заставляет сервер досказать, что появилось.
      await client.noop().catch(() => undefined);
      const found = await client.search({ all: true }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
      const slice = uids.slice(0, Math.max(0, maxMessages - result.scanned));
      if (slice.length < uids.length) result.limitReached = true;
      if (slice.length === 0) continue;

      const matchedUids: number[] = [];
      const fetched = await client.fetchAll(
        slice,
        {
          uid: true,
          envelope: true,
          size: true,
          headers: ['resent-from', 'resent-to'],
          ...(needsStructure || needsBody ? { bodyStructure: true } : {}),
        },
        { uid: true },
      );
      for (const msg of fetched) {
        result.scanned += 1;
        const envelope = msg.envelope;
        const headers = msg.headers ? parseHeaderBlock(msg.headers) : undefined;
        const candidate: MatchableMessage = {
          from: joinAddresses(envelope?.from),
          to: joinAddresses(envelope?.to),
          cc: joinAddresses(envelope?.cc),
          subject: envelope?.subject ?? '',
          resentFrom: headerLine(headers, 'resent-from'),
          resentTo: headerLine(headers, 'resent-to'),
          size: msg.size ?? 0,
          body: needsBody ? await fetchBodyText(client, msg.uid, msg.bodyStructure) : '',
          // Та же проверка, по которой в списке рисуется скрепка
          // (mail/structure.ts): условие правила и значок должны говорить
          // об одном и том же письме одно и то же.
          hasAttachment: needsStructure ? hasRealAttachments(msg.bodyStructure) : false,
        };
        if (matchesRule(candidate, rule)) matchedUids.push(msg.uid);
      }

      if (matchedUids.length === 0) continue;
      result.matched += matchedUids.length;

      const addFlags: string[] = [];
      if (rule.actions.markRead) addFlags.push('\\Seen');
      if (rule.actions.flag) addFlags.push('\\Flagged');
      addFlags.push(...rule.actions.labels);
      if (addFlags.length > 0) {
        await client.messageFlagsAdd(matchedUids, addFlags, { uid: true });
        result.flagged += matchedUids.length;
      }
      if (deleteMode === 'purge') {
        // messageDelete без корзины: ставит \Deleted и делает EXPUNGE.
        // Вернуть после этого нечего — потому действие и требует явного
        // выбора в интерфейсе, с предупреждением.
        await client.messageDelete(matchedUids, { uid: true });
        result.deleted += matchedUids.length;
      } else if (targetPath) {
        await client.messageMove(matchedUids, targetPath, { uid: true });
        result.moved += matchedUids.length;
        if (deleteMode === 'trash') result.deleted += matchedUids.length;
      }
    } finally {
      lock.release();
    }
    if (result.scanned >= maxMessages) {
      result.limitReached = true;
      break;
    }
  }

  return result;
}

/** Разбирает блок заголовков из FETCH в карту «имя -> значения». */
export function parseHeaderBlock(raw: Buffer | string): Map<string, string[]> {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  const map = new Map<string, string[]>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const list = map.get(name);
    if (list) list.push(value);
    else map.set(name, [value]);
  }
  return map;
}
