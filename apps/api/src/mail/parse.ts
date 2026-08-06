/**
 * Разбор полного письма: mailparser для тела и заголовков,
 * BODYSTRUCTURE для списка вложений, санитизация HTML.
 */
import { simpleParser } from 'mailparser';
import type { AddressObject, ParsedMail } from 'mailparser';
import type { FetchMessageObject } from 'imapflow';
import type { AuthResult, MailAddress, Message } from '@mail-true/shared';
import { sanitizeEmailHtml } from './sanitize.js';
import { cidToPartMap, collectAttachments } from './structure.js';
import { buildSummary } from './summary.js';
import { htmlToText, makeSnippet } from './text.js';
import { parseAuthenticationResults, trustedAuthservId } from './sender-auth.js';

function mailparserAddresses(obj: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (!obj) return [];
  const list = Array.isArray(obj) ? obj : [obj];
  const result: MailAddress[] = [];
  for (const group of list) {
    for (const item of group.value) {
      if (item.address) {
        result.push({ name: item.name || null, address: item.address });
      }
    }
  }
  return result;
}

const AUTH_VALUES: ReadonlySet<string> = new Set([
  'pass',
  'fail',
  'softfail',
  'neutral',
  'none',
  'temperror',
  'permerror',
]);

/**
 * Разбирает заголовок Authentication-Results — но ТОЛЬКО НАШ.
 *
 * Заголовок с результатами проверки вписывает принимающий сервер. Точно
 * такой же заголовок может прийти и снаружи, внутри самого письма: писать
 * его волен кто угодно, это обычная строка текста. Раньше разбиралось
 * первое попавшееся значение, и письмо с самодельной строкой
 *
 *   Authentication-Results: mail.local; dkim=pass; dmarc=pass
 *
 * показывалось человеку как «Отправитель подтверждён». То есть подделка
 * получала ровно тот знак доверия, ради которого проверка и существует.
 * Поймано на стенде: в списке такое письмо честно оставалось с буквой
 * вместо логотипа (там проверка уже была строгой), а сведения о письме
 * говорили обратное — два места расходились в оценке одного письма.
 *
 * Теперь берётся первый заголовок, чей authserv-id совпадает с именем
 * нашего узла, а всё остальное игнорируется: чужим утверждениям о
 * подлинности верить нельзя. Если нашего заголовка нет вовсе — значит
 * проверок не было, и так и говорим («none»), а не выдаём чужие за свои.
 */
export function parseAuthResults(
  headers: string | readonly string[] | undefined,
  authservId: string = trustedAuthservId(),
): Message['authentication'] {
  const result: { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult } = {
    spf: 'none',
    dkim: 'none',
    dmarc: 'none',
  };
  if (!headers) return result;
  const list = typeof headers === 'string' ? [headers] : headers;
  const ours = list
    .map((value) => parseAuthenticationResults(value))
    .find((parsed) => parsed !== null && parsed.authservId === authservId.toLowerCase());
  if (!ours) return result;

  for (const { method, result: value } of ours.methods) {
    if (method !== 'spf' && method !== 'dkim' && method !== 'dmarc') continue;
    if (AUTH_VALUES.has(value)) result[method] = value as AuthResult;
  }
  return result;
}

/**
 * Заголовки, полезные интерфейсу. Имена — строго в нижнем регистре:
 * интерфейс ищет их именно так.
 */
const HEADER_WHITELIST = new Set([
  'return-path',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'list-help',
  'list-post',
  'list-owner',
  'list-archive',
  'x-mailer',
  'user-agent',
  'authentication-results',
  'content-language',
  'importance',
  'x-priority',
  'precedence',
  'auto-submitted',
  // Отправитель просит уведомить о прочтении (RFC 8098). Интерфейс по нему
  // рисует плашку с вопросом: молча отвечать за человека, кому и когда он
  // читал письмо, нельзя.
  'disposition-notification-to',
]);

/** Длиннее этого заголовок интерфейсу всё равно не нужен. */
const MAX_HEADER_LENGTH = 4096;

/** Склеивает свёрнутый заголовок в одну строку. */
function unfold(value: string): string {
  return value
    .replace(/\r?\n[ \t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Отбирает заголовки для ответа.
 *
 * Читается `headerLines`, а не `headers`. Причина: mailparser сводит ВСЮ
 * группу `list-*` в один разобранный объект под ключом `list`, поэтому
 * `headers.get('list-unsubscribe')` возвращает undefined, а проверка
 * `typeof === 'string'` отбрасывала и сам объект `list`, и `return-path`
 * (он разбирается в адресный объект). В итоге письмо рассылки приходило
 * с `headers: {}` — и кнопка «Отписаться» в интерфейсе была недостижима
 * в принципе, сколько её ни чини на стороне клиента.
 *
 * `headerLines` отдаёт исходные строки заголовков с уже приведёнными
 * к нижнему регистру именами — ровно то, что нужно интерфейсу.
 */
function pickHeaders(parsed: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of parsed.headerLines ?? []) {
    const name = item.key.toLowerCase();
    if (!HEADER_WHITELIST.has(name)) continue;
    const colon = item.line.indexOf(':');
    if (colon < 0) continue;
    const value = unfold(item.line.slice(colon + 1)).slice(0, MAX_HEADER_LENGTH);
    if (!value) continue;
    // Заголовок мог встретиться дважды — сохраняем оба значения
    out[name] = out[name] ? `${out[name]}, ${value}` : value;
  }
  return out;
}

/**
 * Все значения заголовка Authentication-Results из письма.
 *
 * Письмо проходит через несколько серверов, и каждый вправе добавить свой
 * заголовок; наш — среди них, и выбрать его можно только перебрав все.
 * Читаются `headerLines`, а не `headers`: последние схлопывают повторы.
 */
function authResultHeaders(parsed: ParsedMail): string[] {
  const out: string[] = [];
  for (const item of parsed.headerLines ?? []) {
    if (item.key.toLowerCase() !== 'authentication-results') continue;
    const colon = item.line.indexOf(':');
    if (colon < 0) continue;
    out.push(unfold(item.line.slice(colon + 1)));
  }
  return out;
}

/**
 * Разбирает только заголовки письма (для отписки от рассылки и т. п.).
 * Принимает как полный исходник, так и один блок заголовков.
 */
export async function parseMessageHeaders(source: Buffer): Promise<Record<string, string>> {
  const parsed = await simpleParser(source);
  return pickHeaders(parsed);
}

export interface ParseMessageArgs {
  folderId: string;
  msg: FetchMessageObject;
  source: Buffer;
  /** Разрешить внешние картинки (иначе блокируются). */
  allowRemote: boolean;
}

export interface ParsedMessageResult {
  message: Message;
  blockedRemote: number;
}

/** Собирает полное Message из исходника письма и данных FETCH. */
/**
 * Тело письма из исходника — всё после первой пустой строки.
 *
 * Кодировку здесь не разбираем: у письма, которое не разобралось, объявленной
 * кодировки могло и не быть. Читаем как UTF-8 — для латиницы и для писем в
 * UTF-8 это верно, а испорченные байты становятся видимыми, а не невидимыми.
 */
function rawBodyOf(source: Buffer): string {
  const crlf = source.indexOf('\r\n\r\n');
  if (crlf >= 0) return source.subarray(crlf + 4).toString('utf8');
  const lf = source.indexOf('\n\n');
  return lf >= 0 ? source.subarray(lf + 2).toString('utf8') : '';
}

/** Блок заголовков письма — всё до первой пустой строки. */
function headerBlockOf(source: Buffer): Buffer {
  const end = source.indexOf('\r\n\r\n');
  if (end >= 0) return source.subarray(0, end + 2);
  // Письма с одиночным переводом строки встречаются: так их сохраняют
  // некоторые почтовые программы и так их отдают некоторые серверы.
  const endLf = source.indexOf('\n\n');
  return endLf >= 0 ? source.subarray(0, endLf + 1) : source;
}

export async function parseFullMessage(args: ParseMessageArgs): Promise<ParsedMessageResult> {
  const { folderId, msg, source, allowRemote } = args;
  // skipImageLinks: cid-ссылки не заменяются на data:URI —
  // мы сами переписываем их на /api/messages/:id/parts/:partId
  const parsed = await simpleParser(source, { skipImageLinks: true });

  const cidMap = cidToPartMap(msg.bodyStructure);
  const messageId = `${folderId}:${msg.uid}`;
  const partUrl = (partId: string): string =>
    `/api/messages/${encodeURIComponent(messageId)}/parts/${encodeURIComponent(partId)}`;

  let bodyHtml: string | null = null;
  let blockedRemote = 0;
  const rawHtml = parsed.html || null;
  if (rawHtml) {
    const sanitized = sanitizeEmailHtml(rawHtml, {
      allowRemote,
      resolveCid: (cid) => {
        const part = cidMap.get(cid);
        return part ? partUrl(part) : null;
      },
    });
    bodyHtml = sanitized.html;
    blockedRemote = sanitized.blockedRemote;
  }

  let bodyText = parsed.text ?? (rawHtml ? htmlToText(rawHtml) : null);
  const attachments = collectAttachments(msg.bodyStructure);

  /*
   * Запасной путь к тексту, когда разбор не дал ни одной части.
   *
   * Так выглядит письмо с испорченным разделителем частей: в заголовке
   * объявлен один разделитель, а в теле стоит другой. Разбор в этом случае
   * не находит ничего, и письмо показывалось СОВЕРШЕННО пустым — тема и
   * отправитель есть, текста нет, и добраться до него нельзя ничем: ни
   * «показать исходник», ни скачиванием у нас нет.
   *
   * Такие письма ходят: разделитель портят самописные рассылки и пересылка
   * через старые шлюзы. Почтовые программы показывают такое письмо как есть
   * — берём тело исходника целиком, без заголовков.
   *
   * Признак `bodyRecovered` уходит наружу, чтобы интерфейс мог сказать
   * человеку, что письмо разобрать не удалось и показан исходный текст.
   */
  let bodyRecovered = false;
  if (!bodyHtml && (bodyText === null || bodyText.trim() === '') && attachments.length === 0) {
    const raw = rawBodyOf(source);
    if (raw.trim() !== '') {
      bodyText = raw;
      bodyRecovered = true;
    }
  }

  const snippet = makeSnippet(bodyText ?? '');

  /*
   * Заголовки для восстановления темы берём из самого письма: у полного
   * письма исходник уже на руках, отдельный запрос не нужен. Блок заголовков
   * кончается первой пустой строкой.
   *
   * Без этого страница письма показывала кашу там, где список уже показывал
   * тему правильно, — то есть в двух местах одно и то же письмо выглядело
   * по-разному.
   */
  const summary = buildSummary({ folderId, msg, snippet, rawHeaders: headerBlockOf(source) });

  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [];

  const message: Message = {
    ...summary,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    replyTo: mailparserAddresses(parsed.replyTo),
    bcc: mailparserAddresses(parsed.bcc),
    bodyHtml,
    bodyText,
    attachments,
    headers: pickHeaders(parsed),
    // Все значения заголовка, а не одно: письмо проходит через несколько
    // серверов, у каждого свой Authentication-Results, и наш надо выбрать
    // среди них по имени узла.
    authentication: parseAuthResults(authResultHeaders(parsed)),
    // Признак ставим ТОЛЬКО когда текст действительно взят из исходника:
    // лишнее поле в обычном письме заставило бы интерфейс объяснять то,
    // чего не было.
    ...(bodyRecovered ? { bodyRecovered: true } : {}),
  };

  return { message, blockedRemote };
}
