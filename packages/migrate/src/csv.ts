/**
 * Небольшой CSV-парсер (RFC 4180 + автоопределение разделителя).
 *
 * Нужен для двух задач: разбор выгрузки пользователей Kerio Connect
 * (разделитель «;») и списка ящиков для пакетного переноса («,» или «;»).
 * Внешних зависимостей в монорепозитории для CSV нет, формат простой.
 */

export interface CsvOptions {
  /** Разделитель полей; по умолчанию определяется по первой строке. */
  delimiter?: ',' | ';' | '\t';
  /**
   * Что делать с незакрытой кавычкой в конце файла.
   *   'error' (по умолчанию) — бросить CsvParseError;
   *   'lenient' — разобрать как есть (для случаев, когда важнее хоть что-то).
   * Молчаливого варианта нет намеренно: незакрытая кавычка съедает весь
   * хвост файла в одно поле, и без ошибки это выглядит как «в выгрузке
   * был всего один пользователь».
   */
  onUnterminatedQuote?: 'error' | 'lenient';
}

/** Ошибка разбора CSV: файл нельзя считать разобранным целиком. */
export class CsvParseError extends Error {
  /** Строка (1-based), в которой открылась незакрытая кавычка. */
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = 'CsvParseError';
    this.line = line;
  }
}

/** Определить разделитель по первой строке (вне кавычек). */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts: Record<',' | ';' | '\t', number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === ',' || ch === ';' || ch === '\t')) counts[ch]++;
  }
  if (counts[';'] >= counts[','] && counts[';'] >= counts['\t'] && counts[';'] > 0) return ';';
  if (counts['\t'] > counts[',']) return '\t';
  return ',';
}

/** Разобрать CSV-текст в массив строк-массивов. Пустые строки пропускаются. */
export function parseCsv(text: string, options: CsvOptions = {}): string[][] {
  // Срезаем BOM, которым часто начинаются выгрузки из Windows-программ
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = options.delimiter ?? detectDelimiter(src);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  // Номер строки, в которой открылась текущая кавычка — нужен для
  // внятного сообщения об ошибке, если её так и не закрыли.
  let line = 1;
  let quoteOpenedAt = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    // пустая строка (одно пустое поле) — пропускаем
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      quoteOpenedAt = line;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      line++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes && options.onUnterminatedQuote !== 'lenient') {
    // Здесь заканчивался разбор молча: весь хвост файла оставался внутри
    // одного поля, и вызывающий получал «одного пользователя» без единого
    // намёка на потерю. Теперь это ошибка с указанием строки.
    throw new CsvParseError(
      `незакрытая кавычка: открыта в строке ${quoteOpenedAt} и не закрыта до конца файла — ` +
        `остаток файла (${rows.length + 1}-я строка и далее) попал бы в одно поле, разбор прерван`,
      quoteOpenedAt,
    );
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/**
 * Разобрать CSV с заголовком в массив объектов.
 * Имена колонок приводятся к нижнему регистру и обрезаются.
 */
export function parseCsvWithHeader(
  text: string,
  options: CsvOptions = {},
): Array<Record<string, string>> {
  const rows = parseCsv(text, options);
  const header = rows[0];
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    keys.forEach((key, idx) => {
      if (key.length > 0) obj[key] = (cells[idx] ?? '').trim();
    });
    return obj;
  });
}
