/**
 * Преобразование HTML письма в простой текст и нормализация пробелов.
 * Своя реализация: новых зависимостей пакет не добавляет.
 */

/**
 * Служебные метки границ цитаты (<blockquote>). Символы из области
 * частного использования Unicode — в настоящем письме их не бывает.
 * Ставятся при разборе HTML, вырезаются на шаге очистки.
 */
export const QUOTE_START = '\uE000';
export const QUOTE_END = '\uE001';

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'div', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tfoot', 'thead', 'tbody', 'ul',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
};

/** Раскрывает HTML-сущности: именованные, десятичные и шестнадцатеричные. */
export function decodeEntities(input: string): string {
  return input.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (match: string, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const digits = isHex ? body.slice(2) : body.slice(1);
        const code = Number.parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? match;
    },
  );
}

/**
 * HTML → текст. Сохраняет структуру абзацев и списков, потому что
 * от неё зависит смысл письма, но выбрасывает разметку, скрипты,
 * стили и служебные атрибуты.
 */
export function htmlToText(html: string): string {
  let out = html;

  // Полностью удаляем содержимое неотображаемых элементов.
  out = out.replace(/<(script|style|head|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');

  // Цитата предыдущего письма в HTML-вёрстке — размечаем метками,
  // чтобы вырезать её вместе с текстовыми цитатами.
  out = out.replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_START}\n`);
  out = out.replace(/<\/blockquote\s*>/gi, `\n${QUOTE_END}\n`);

  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<li\b[^>]*>/gi, '\n• ');
  out = out.replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n');
  out = out.replace(/<\/(td|th)\s*>/gi, '\t');
  out = out.replace(/<hr\s*\/?>/gi, '\n');

  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_m: string, tag: string) => {
    return BLOCK_TAGS.has(tag.toLowerCase()) ? '\n' : '';
  });

  out = decodeEntities(out);
  return normalizeWhitespace(out, { keepQuoteMarks: true });
}

/**
 * Приводит пробелы к виду, пригодному для отправки в модель:
 * убирает неразрывные пробелы и символы нулевой ширины, хвостовые
 * пробелы строк, серии пустых строк.
 */
export function normalizeWhitespace(
  input: string,
  options?: { keepQuoteMarks?: boolean },
): string {
  let out = input
    .replace(/\r\n?/g, '\n')
    // Неразрывные и типографские пробелы → обычный пробел.
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    // Символы нулевой ширины и управляющие метки направления письма.
    .replace(/[\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, '');

  if (options?.keepQuoteMarks !== true) {
    out = out.split(QUOTE_START).join('').split(QUOTE_END).join('');
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Первые `limit` символов одной строкой — для превью в описи. */
export function preview(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
