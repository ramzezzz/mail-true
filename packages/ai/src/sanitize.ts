/**
 * Подготовка письма к отправке наружу.
 *
 * Это самый важный модуль пакета. Всё, что уходит к стороннему сервису,
 * проходит только через него, и он же формирует опись отправляемого —
 * чтобы интерфейс мог честно показать пользователю, что именно ушло.
 *
 * Правила:
 *   1. Вложения не отправляются НИКОГДА — только их имена попадают
 *      в список исключённого, чтобы пользователь видел, что мы их не взяли.
 *   2. Подписи и цитаты предыдущей переписки вырезаются: они не несут
 *      смысла для задачи и содержат чужие персональные данные.
 *   3. Служебные заголовки (Received, DKIM-Signature, X-*) не отправляются.
 *   4. Длинное письмо урезается с сохранением начала и конца.
 *   5. Опись строится из тех же полей, из которых потом собирается запрос,
 *      поэтому не может разойтись с содержимым.
 */

import { QUOTE_END, QUOTE_START, htmlToText, normalizeWhitespace } from './text.js';
import { estimateTokens } from './tokens.js';
import type {
  AiSourceAddress,
  AiSourceMessage,
  OutboundDisclosure,
  OutboundField,
  RemovedKind,
  RemovedPart,
} from './types.js';

export interface SanitizeOptions {
  /** Предельная длина тела письма в символах после очистки. */
  maxBodyChars?: number;
  /** Вырезать подпись. По умолчанию да. */
  stripSignature?: boolean;
  /** Вырезать цитаты предыдущей переписки. По умолчанию да. */
  stripQuotes?: boolean;
  /** Включать в запрос адреса получателей. По умолчанию да. */
  includeRecipients?: boolean;
}

export const DEFAULT_MAX_BODY_CHARS = 8000;

/** Письмо, подготовленное к отправке. Ничего, кроме этих полей, не уходит. */
export interface PreparedMessage {
  /** Идентификатор письма — для кэша и журнала, наружу НЕ отправляется. */
  sourceId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  body: string;
  /** Опись отправляемого; заполняется описанием поставщика позже. */
  parts: OutboundField[];
  removed: RemovedPart[];
  attachmentsExcluded: string[];
}

/** Описание поставщика для описи — берётся из настроек. */
export interface DisclosureContext {
  endpoint: string;
  model: string;
  providerLabel: string;
  local: boolean;
}

// ---------------------------------------------------------------------------
// Разбор письма
// ---------------------------------------------------------------------------

function formatAddress(a: AiSourceAddress): string {
  const address = a.address.trim();
  const name = a.name?.trim();
  return name ? `${name} <${address}>` : address;
}

/**
 * Готовит письмо к отправке. Не бросает исключений: любое письмо,
 * даже пустое или искажённое, даёт корректный результат.
 */
export function prepareMessage(
  message: AiSourceMessage,
  options?: SanitizeOptions,
): PreparedMessage {
  const maxBodyChars = options?.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const stripSignature = options?.stripSignature ?? true;
  const stripQuotes = options?.stripQuotes ?? true;
  const includeRecipients = options?.includeRecipients ?? true;

  const removed: RemovedPart[] = [];

  // 1. Тело: предпочитаем готовый текст, иначе разбираем HTML.
  const rawText = message.bodyText?.trim();
  let body: string;
  if (rawText && rawText.length > 0) {
    body = normalizeWhitespace(rawText, { keepQuoteMarks: true });
  } else if (message.bodyHtml && message.bodyHtml.length > 0) {
    const htmlLength = message.bodyHtml.length;
    body = htmlToText(message.bodyHtml);
    const droppedMarkup = Math.max(0, htmlLength - body.length);
    if (droppedMarkup > 0) {
      removed.push({
        kind: 'html-markup',
        count: 1,
        chars: droppedMarkup,
        note: 'Разметка HTML, стили и скрипты отброшены — отправляется только текст',
      });
    }
  } else {
    body = '';
  }

  // 2. Цитаты предыдущей переписки.
  if (stripQuotes) {
    const result = stripQuotedText(body);
    body = result.text;
    if (result.removedChars > 0) {
      removed.push({
        kind: 'quote',
        count: result.blocks,
        chars: result.removedChars,
        note: 'Цитаты предыдущих писем не отправляются',
      });
    }
  } else {
    body = normalizeWhitespace(body);
  }

  // 3. Подпись.
  if (stripSignature) {
    const result = stripSignatureBlock(body);
    body = result.text;
    if (result.removedChars > 0) {
      removed.push({
        kind: 'signature',
        count: 1,
        chars: result.removedChars,
        note: 'Подпись отправителя не отправляется',
      });
    }
  }

  body = normalizeWhitespace(body);

  // 4. Урезание длинного письма.
  const truncation = truncateBody(body, maxBodyChars);
  body = truncation.text;
  if (truncation.removedChars > 0) {
    removed.push({
      kind: 'truncated',
      count: 1,
      chars: truncation.removedChars,
      note: `Письмо длиннее ${maxBodyChars} символов — отправлены начало и конец`,
    });
  }

  // 5. Вложения — не отправляются никогда.
  const attachmentsExcluded = (message.attachments ?? []).map((a) =>
    a.filename && a.filename.length > 0 ? a.filename : `без имени (${a.mimeType})`,
  );
  if (attachmentsExcluded.length > 0) {
    const bytes = (message.attachments ?? []).reduce((sum, a) => sum + (a.size || 0), 0);
    removed.push({
      kind: 'attachment',
      count: attachmentsExcluded.length,
      chars: bytes,
      note: 'Вложения не отправляются никогда — ни содержимое, ни фрагменты',
    });
  }

  // 6. Служебные заголовки.
  const headerCount = Object.keys(message.headers ?? {}).length;
  if (headerCount > 0) {
    removed.push({
      kind: 'headers',
      count: headerCount,
      chars: 0,
      note: 'Служебные заголовки (Received, DKIM-Signature, X-*) не отправляются',
    });
  }

  const subject = normalizeWhitespace(message.subject ?? '');
  const from = message.from ? formatAddress(message.from) : '';
  const to = includeRecipients ? (message.to ?? []).map(formatAddress) : [];
  const cc = includeRecipients ? (message.cc ?? []).map(formatAddress) : [];
  const date = typeof message.date === 'string' ? message.date : '';

  const parts: OutboundField[] = [];
  const push = (field: string, label: string, value: string): void => {
    if (value.length === 0) return;
    parts.push({ field, label, value, chars: value.length });
  };
  push('subject', 'Тема', subject);
  push('from', 'Отправитель', from);
  push('to', 'Получатели', to.join(', '));
  push('cc', 'Копия', cc.join(', '));
  push('date', 'Дата', date);
  push('body', 'Текст письма', body);

  return {
    sourceId: message.id,
    subject,
    from,
    to,
    cc,
    date,
    body,
    parts,
    removed,
    attachmentsExcluded,
  };
}

/**
 * Собирает текст запроса ровно из тех полей, что перечислены в описи.
 * Другого пути данных наружу в пакете нет.
 */
export function renderPrepared(prepared: PreparedMessage): string {
  return prepared.parts.map((p) => `${p.label}: ${p.value}`).join('\n');
}

/** Строит опись по подготовленному письму и настройкам поставщика. */
export function describeOutbound(
  prepared: PreparedMessage | PreparedMessage[],
  context: DisclosureContext,
): OutboundDisclosure {
  const list = Array.isArray(prepared) ? prepared : [prepared];
  const fields: OutboundField[] = [];
  const removedByKind = new Map<RemovedKind, RemovedPart>();
  const attachments: string[] = [];

  for (const item of list) {
    for (const part of item.parts) fields.push(part);
    for (const r of item.removed) {
      const acc = removedByKind.get(r.kind);
      if (acc) {
        acc.count += r.count;
        acc.chars += r.chars;
      } else {
        removedByKind.set(r.kind, { ...r });
      }
    }
    for (const name of item.attachmentsExcluded) attachments.push(name);
  }

  let totalChars = 0;
  for (const f of fields) totalChars += f.chars;

  return {
    endpoint: context.endpoint,
    model: context.model,
    providerLabel: context.providerLabel,
    local: context.local,
    fields,
    removed: [...removedByKind.values()],
    attachmentsExcluded: attachments,
    totalChars,
    approxTokens: estimateTokens(fields.map((f) => f.value).join('\n')),
  };
}

/**
 * Опись для запроса, где наружу уходит ТОЛЬКО тело письма.
 *
 * Так работает перевод: модели отдаётся один текст, без темы и адресов.
 * Раньше опись для него строилась через describePlainText, у которой
 * `removed` пуст по определению, — и человек читал «вырезано: ничего»,
 * тогда как из письма уже убрали цитаты, подпись и хвост длиннее предела.
 * Для перевода это особенно чувствительно: он ЗАМЕНЯЕТ письмо на экране,
 * и вырезанное просто исчезает из виду.
 *
 * Поля берутся не из parts (там ещё тема и отправитель, которых в запросе
 * нет), а ровно одно — тело. Всё остальное переносится из подготовки как
 * есть: что вырезано, какие вложения не поехали.
 */
export function describeBodyOnly(
  label: string,
  prepared: PreparedMessage,
  context: DisclosureContext,
): OutboundDisclosure {
  const field: OutboundField = {
    field: 'body',
    label,
    value: prepared.body,
    chars: prepared.body.length,
  };
  return {
    endpoint: context.endpoint,
    model: context.model,
    providerLabel: context.providerLabel,
    local: context.local,
    fields: [field],
    removed: [...prepared.removed],
    attachmentsExcluded: [...prepared.attachmentsExcluded],
    totalChars: prepared.body.length,
    approxTokens: estimateTokens(prepared.body),
  };
}

/** Опись для запроса, в котором письма нет вообще (например, разбор поисковой фразы). */
export function describePlainText(
  label: string,
  value: string,
  context: DisclosureContext,
): OutboundDisclosure {
  const field: OutboundField = { field: 'text', label, value, chars: value.length };
  return {
    endpoint: context.endpoint,
    model: context.model,
    providerLabel: context.providerLabel,
    local: context.local,
    fields: [field],
    removed: [],
    attachmentsExcluded: [],
    totalChars: value.length,
    approxTokens: estimateTokens(value),
  };
}

// ---------------------------------------------------------------------------
// Цитаты
// ---------------------------------------------------------------------------

/** Строка-заголовок пересылки/цитаты: «-----Original Message-----» и т. п. */
const SEPARATOR_RE =
  /^\s*-{2,}\s*(original message|forwarded message|пересылаемое сообщение|исходное сообщение|начало пересылаемого сообщения)\s*-{2,}\s*$/i;

/** Атрибуция: «5 июня 2025 г., 10:00, Иван <i@x> написал(а):». */
const ATTRIBUTION_RE =
  /(wrote|schrieb|a écrit|escribió|написал(?:\(а\)|а)?|пишет|ответил(?:\(а\)|а)?)\s*:\s*$/i;

/** Блок заголовков вставленного письма в стиле Outlook. */
const OUTLOOK_FROM_RE = /^\s*(от|from|de|von)\s*:\s*\S/i;
const OUTLOOK_NEXT_RE = /^\s*(кому|to|отправлено|sent|дата|date|тема|subject|копия|cc)\s*:/i;

export interface StripResult {
  text: string;
  removedChars: number;
  blocks: number;
}

/**
 * Вырезает цитаты: строки с «>», блоки <blockquote> (по меткам из htmlToText),
 * атрибуции «… написал(а):» и вставленные шапки писем.
 */
export function stripQuotedText(input: string): StripResult {
  const original = input;
  const lines = input.split('\n');
  const keep: string[] = [];
  let blocks = 0;
  let inHtmlQuote = 0;
  let cutFromHere = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (line.includes(QUOTE_START)) {
      if (inHtmlQuote === 0) blocks += 1;
      inHtmlQuote += 1;
      continue;
    }
    if (line.includes(QUOTE_END)) {
      inHtmlQuote = Math.max(0, inHtmlQuote - 1);
      continue;
    }
    if (inHtmlQuote > 0) continue;

    if (cutFromHere) continue;

    if (SEPARATOR_RE.test(line)) {
      blocks += 1;
      cutFromHere = true;
      continue;
    }

    // Шапка вставленного письма: «От: …» и следом «Кому:»/«Тема:».
    if (OUTLOOK_FROM_RE.test(line)) {
      const next = lines[i + 1] ?? '';
      const next2 = lines[i + 2] ?? '';
      if (OUTLOOK_NEXT_RE.test(next) || OUTLOOK_NEXT_RE.test(next2)) {
        blocks += 1;
        cutFromHere = true;
        continue;
      }
    }

    // Атрибуция может занимать одну или две строки.
    if (looksLikeAttribution(line) || looksLikeAttribution(`${line} ${lines[i + 1] ?? ''}`)) {
      blocks += 1;
      cutFromHere = true;
      continue;
    }

    if (/^\s*>/.test(line)) {
      blocks += 1;
      continue;
    }

    keep.push(line);
  }

  const text = normalizeWhitespace(keep.join('\n'));
  return {
    text,
    removedChars: Math.max(0, normalizeWhitespace(original).length - text.length),
    blocks,
  };
}

function looksLikeAttribution(line: string): boolean {
  if (line.length > 300) return false;
  if (!ATTRIBUTION_RE.test(line)) return false;
  // Должен присутствовать адрес или дата — иначе это обычное предложение.
  return /[<@]/.test(line) || /\d{1,2}[.\-/\s]\d{1,2}|\d{4}|\d{1,2}:\d{2}/.test(line);
}

// ---------------------------------------------------------------------------
// Подпись
// ---------------------------------------------------------------------------

/** Стандартный разделитель подписи по RFC 3676. */
const SIG_DELIMITER_RE = /^--\s?$/;

/** Заключительные обороты, после которых обычно идёт подпись. */
const SIG_PHRASE_RE =
  /^\s*(с уважением|с наилучшими пожеланиями|всего доброго|всего наилучшего|хорошего дня|best regards|kind regards|warm regards|regards|sincerely|yours (?:sincerely|truly)|cheers|thanks(?: in advance)?|thank you|br)\s*[,!.]?\s*$/i;

/** Служебные приписки почтовых программ. */
// Внимание: \b в JS опирается на латинский \w и с кириллицей не работает,
// поэтому границу задаём явно пробелом.
const SIG_SENT_FROM_RE =
  /^\s*(отправлено с|отправлено из|отправлено через|sent from|get outlook for|von meinem|envoyé de)(?:\s.{0,80})?\s*$/i;

const SIG_RULE_RE = /^\s*[_=~*-]{5,}\s*$/;

/**
 * Вырезает подпись. Осторожно: режем только в хвосте письма,
 * чтобы не потерять содержательный текст.
 */
export function stripSignatureBlock(input: string): StripResult {
  const lines = input.split('\n');
  const originalLength = input.length;

  // 1. Стандартный разделитель — самый надёжный признак.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (SIG_DELIMITER_RE.test(lines[i] ?? '')) {
      const text = normalizeWhitespace(lines.slice(0, i).join('\n'));
      return { text, removedChars: Math.max(0, originalLength - text.length), blocks: 1 };
    }
  }

  // 2. Приписка почтовой программы.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (SIG_SENT_FROM_RE.test(lines[i] ?? '')) {
      const text = normalizeWhitespace(lines.slice(0, i).join('\n'));
      return { text, removedChars: Math.max(0, originalLength - text.length), blocks: 1 };
    }
  }

  // 3. Заключительный оборот в хвосте письма: не дальше 12 строк от конца
  //    и не в начале — иначе это может быть содержательная фраза.
  const tailStart = Math.max(1, lines.length - 12);
  for (let i = lines.length - 1; i >= tailStart; i -= 1) {
    const line = lines[i] ?? '';
    if (SIG_PHRASE_RE.test(line) || SIG_RULE_RE.test(line)) {
      const text = normalizeWhitespace(lines.slice(0, i).join('\n'));
      return { text, removedChars: Math.max(0, originalLength - text.length), blocks: 1 };
    }
  }

  return { text: normalizeWhitespace(input), removedChars: 0, blocks: 0 };
}

// ---------------------------------------------------------------------------
// Урезание
// ---------------------------------------------------------------------------

export interface TruncateResult {
  text: string;
  removedChars: number;
}

/**
 * Урезает текст до `maxChars`, сохраняя начало (там суть) и конец
 * (там просьбы и сроки). Режет по границам абзацев, если получается.
 */
export function truncateBody(input: string, maxChars: number): TruncateResult {
  if (maxChars <= 0 || input.length <= maxChars) {
    return { text: input, removedChars: 0 };
  }

  const marker = (n: number): string => `\n\n[...пропущено ${n} символов...]\n\n`;
  const headShare = 0.7;
  // Резерв под саму метку с запасом на длину числа.
  const budget = Math.max(0, maxChars - 40);
  const headLimit = Math.floor(budget * headShare);
  const tailLimit = budget - headLimit;

  const head = cutAtBoundary(input.slice(0, headLimit), 'end');
  const tail = cutAtBoundary(input.slice(input.length - tailLimit), 'start');
  const removedChars = input.length - head.length - tail.length;

  return {
    text: `${head}${marker(removedChars)}${tail}`,
    removedChars,
  };
}

/** Двигает границу к ближайшему концу абзаца или предложения. */
function cutAtBoundary(chunk: string, side: 'start' | 'end'): string {
  if (chunk.length === 0) return chunk;
  const window = Math.min(400, Math.floor(chunk.length / 4));
  if (window < 20) return chunk.trim();

  if (side === 'end') {
    const zone = chunk.slice(chunk.length - window);
    const idx = Math.max(zone.lastIndexOf('\n\n'), zone.lastIndexOf('. '), zone.lastIndexOf('\n'));
    if (idx > 0) return chunk.slice(0, chunk.length - window + idx).trimEnd();
    return chunk.trimEnd();
  }

  const zone = chunk.slice(0, window);
  const nl = zone.indexOf('\n\n');
  const dot = zone.indexOf('. ');
  const idx = nl >= 0 ? nl + 2 : dot >= 0 ? dot + 2 : -1;
  if (idx > 0) return chunk.slice(idx).trimStart();
  return chunk.trimStart();
}
