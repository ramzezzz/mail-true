/**
 * Подготовка исходника письма к показу на экране.
 *
 * Исходник смотрят ради заголовков: разобрать путь письма, проверить подпись,
 * увидеть настоящего отправителя. А занимают в нём место не заголовки, а
 * вложения — они лежат прямо в письме, закодированные base64. Письмо с одной
 * фотографией — это десятки тысяч строк из букв и цифр, в которых ничего
 * найти нельзя, и браузер на них честно задумывается: каждый такой символ
 * становится узлом разметки.
 *
 * Поэтому длинные полосы base64 сворачиваются в одну строку с пометкой, а
 * заголовки и текст остаются целиком. Всё письмо байт в байт доступно рядом —
 * кнопкой «Скачать .eml».
 */

/** Сколько подряд идущих строк base64 считать «полосой вложения». */
const FOLD_AFTER_LINES = 12;
/** Сколько строк полосы оставить на виду, чтобы было видно, что это. */
const KEEP_LINES = 3;
/** Предел показываемого текста после сворачивания. */
const MAX_CHARS = 400_000;

/** Строка выглядит как кусок base64-содержимого, а не как текст письма. */
function base64Line(line: string): boolean {
  return line.length >= 60 && /^[A-Za-z0-9+/=]+\r?$/.test(line);
}

export interface FoldedSource {
  /** Текст для показа. */
  text: string;
  /** Сколько строк свёрнуто. */
  foldedLines: number;
  /** Текст пришлось обрезать — даже свёрнутый он слишком велик. */
  truncated: boolean;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}

export function foldMessageSource(raw: string): FoldedSource {
  const lines = raw.split('\n');
  const out: string[] = [];
  let foldedLines = 0;

  for (let i = 0; i < lines.length; ) {
    if (!base64Line(lines[i] ?? '')) {
      out.push(lines[i] ?? '');
      i += 1;
      continue;
    }
    let end = i;
    let bytes = 0;
    while (end < lines.length && base64Line(lines[end] ?? '')) {
      bytes += (lines[end] ?? '').length;
      end += 1;
    }
    const run = end - i;
    if (run <= FOLD_AFTER_LINES) {
      // Короткая полоса — это не вложение, а, например, длинная подпись DKIM.
      // Её как раз и приходят смотреть.
      for (; i < end; i += 1) out.push(lines[i] ?? '');
      continue;
    }
    for (let k = 0; k < KEEP_LINES; k += 1) out.push(lines[i + k] ?? '');
    const hidden = run - KEEP_LINES;
    foldedLines += hidden;
    out.push(
      `[…свёрнуто ${hidden} строк содержимого вложения, примерно ${humanSize(bytes)}. ` +
        'Письмо целиком — кнопкой «Скачать .eml»…]',
    );
    i = end;
  }

  const text = out.join('\n');
  if (text.length <= MAX_CHARS) return { text, foldedLines, truncated: false };
  return {
    text:
      `${text.slice(0, MAX_CHARS)}\n\n` +
      '[…исходник обрезан: он слишком велик, чтобы показать его целиком. ' +
      'Письмо полностью — кнопкой «Скачать .eml»…]',
    foldedLines,
    truncated: true,
  };
}
