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
 * Что применяется: папка, «прочитано», «флажок». Пересылка копии и
 * автоответ намеренно НЕ применяются к старой почте: разослать письма
 * задним числом нельзя отменить.
 */
import type { ImapFlow } from 'imapflow';
import type { Folder } from '@mail-true/shared';
import { listFolders } from '../imap/service.js';
import type { FilterCondition, FilterRule } from './types.js';

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
    case 'size':
      return String(msg.size);
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
  /** Сколько помечено прочитанными или флажком. */
  flagged: number;
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
    folders: [],
    limitReached: false,
  };

  const targetPath = rule.actions.folder;

  for (const path of folderPaths) {
    if (!byPath.has(path)) continue;
    if (targetPath && path === targetPath) continue; // перекладывать в себя нечего
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
        };
        if (matchesRule(candidate, rule)) matchedUids.push(msg.uid);
      }

      if (matchedUids.length === 0) continue;
      result.matched += matchedUids.length;

      const addFlags: string[] = [];
      if (rule.actions.markRead) addFlags.push('\\Seen');
      if (rule.actions.flag) addFlags.push('\\Flagged');
      if (addFlags.length > 0) {
        await client.messageFlagsAdd(matchedUids, addFlags, { uid: true });
        result.flagged += matchedUids.length;
      }
      if (targetPath) {
        await client.messageMove(matchedUids, targetPath, { uid: true });
        result.moved += matchedUids.length;
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
