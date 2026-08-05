/**
 * Разбор поисковой строки с операторами.
 *
 * Раньше вся строка целиком уходила в IMAP как поиск по тексту. Поэтому
 * `от:волкова` не находило ничего: почтовый сервер честно искал письмо, где
 * встречается сама подстрока «от:волкова». Человек, попробовав уточнить
 * запрос, получал пустой список — то есть уточнение делало поиск хуже, чем
 * его отсутствие.
 *
 * Понимаем и русские, и латинские названия операторов: писать «from:» на
 * русской раскладке неудобно, а переключаться ради одного слова — тем более.
 *
 *   от:иванов        кому:отдел        тема:договор
 *   from:ivanov      to:sales          subject:contract
 *   есть:вложение    непрочитанные     важные
 *   после:2026-01-01 до:2026-08-01
 *
 * Что не разобралось как оператор — остаётся обычными словами поиска.
 * Это важнее, чем строгость: адрес вида `ivan@mail.ru` содержит двоеточие
 * не чаще, чем часы «14:30» в теме, и объявлять такое ошибкой нельзя.
 */

/** Разобранный запрос: операторы отдельно, свободный текст отдельно. */
export interface ParsedSearch {
  /** Слова, не попавшие ни в один оператор. */
  text: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  /** Только письма с вложениями. */
  hasAttachment: boolean;
  seen: boolean | null;
  flagged: boolean | null;
  /** Письма не раньше этой даты (включительно). */
  since: Date | null;
  /** Письма не позже этой даты (включительно). */
  before: Date | null;
}

const EMPTY: ParsedSearch = {
  text: null,
  from: null,
  to: null,
  cc: null,
  subject: null,
  hasAttachment: false,
  seen: null,
  flagged: null,
  since: null,
  before: null,
};

/** Названия операторов: по-русски и по-английски, всё в нижнем регистре. */
const FIELD_ALIASES: Record<string, 'from' | 'to' | 'cc' | 'subject'> = {
  'от': 'from',
  'from': 'from',
  'кому': 'to',
  'to': 'to',
  'копия': 'cc',
  'cc': 'cc',
  'тема': 'subject',
  'subject': 'subject',
};

const DATE_ALIASES: Record<string, 'since' | 'before'> = {
  'после': 'since',
  'since': 'since',
  'after': 'since',
  'до': 'before',
  'before': 'before',
};

/** Одиночные слова-признаки без двоеточия. */
const FLAG_WORDS: Record<string, (out: Writable) => void> = {
  'непрочитанные': (o) => { o.seen = false; },
  'непрочитанное': (o) => { o.seen = false; },
  'unread': (o) => { o.seen = false; },
  'прочитанные': (o) => { o.seen = true; },
  'read': (o) => { o.seen = true; },
  'важные': (o) => { o.flagged = true; },
  'важное': (o) => { o.flagged = true; },
  'flagged': (o) => { o.flagged = true; },
};

/** Значения оператора «есть:». */
const HAS_VALUES = new Set(['вложение', 'вложения', 'attachment', 'attachments', 'file']);

type Writable = { -readonly [K in keyof ParsedSearch]: ParsedSearch[K] };

/**
 * Режет строку на части, уважая кавычки: `тема:"годовой отчёт"` — одно слово.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current !== '') tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Дата вида ГГГГ-ММ-ДД. Другие записи намеренно не поддерживаем: `01.02.2026`
 * в России и в США читается по-разному, и угадывать здесь — значит иногда
 * молча искать не тот месяц.
 */
function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  // Проверка от «2026-02-31»: такая дата молча переехала бы на март.
  if (date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return date;
}

/** Разбирает поисковую строку. */
export function parseSearch(input: string | undefined | null): ParsedSearch {
  const raw = (input ?? '').trim();
  if (raw === '') return { ...EMPTY };

  const out: Writable = { ...EMPTY };
  const words: string[] = [];

  for (const token of tokenize(raw)) {
    const colon = token.indexOf(':');

    if (colon > 0) {
      const name = token.slice(0, colon).toLowerCase();
      const value = token.slice(colon + 1).trim();

      if (value !== '') {
        const field = FIELD_ALIASES[name];
        if (field) {
          // Повторный оператор дописывается через пробел: два «от:» подряд —
          // это скорее уточнение, чем замена.
          out[field] = out[field] ? `${out[field] ?? ''} ${value}` : value;
          continue;
        }
        const dateField = DATE_ALIASES[name];
        if (dateField) {
          const date = parseDate(value);
          if (date) {
            out[dateField] = date;
            continue;
          }
          // Дату не разобрали — пусть ищется как обычные слова, а не
          // пропадает молча.
        }
        if ((name === 'есть' || name === 'has') && HAS_VALUES.has(value.toLowerCase())) {
          out.hasAttachment = true;
          continue;
        }
      }
    }

    const flag = FLAG_WORDS[token.toLowerCase()];
    if (flag) {
      flag(out);
      continue;
    }

    words.push(token);
  }

  out.text = words.length > 0 ? words.join(' ') : null;
  return out;
}

/** Есть ли в разобранном запросе хоть что-то, кроме свободного текста. */
export function hasOperators(parsed: ParsedSearch): boolean {
  return (
    parsed.from !== null ||
    parsed.to !== null ||
    parsed.cc !== null ||
    parsed.subject !== null ||
    parsed.hasAttachment ||
    parsed.seen !== null ||
    parsed.flagged !== null ||
    parsed.since !== null ||
    parsed.before !== null
  );
}
