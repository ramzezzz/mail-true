/**
 * Клиентский разбор CSV — ровно для того, чтобы показать таблицу
 * ДО отправки на сервер: сколько строк, какие столбцы распознаны,
 * что бросается в глаза сразу. Окончательное решение всё равно
 * принимает сервер (apps/api/src/admin/csv.ts) — здесь только
 * быстрая обратная связь без сетевого запроса.
 */

/** Разбор CSV по RFC 4180 с автоопределением разделителя. */
export function splitCsv(text: string): string[][] {
  // Метка порядка байтов записана кодом, а не самим символом: живой U+FEFF
  // в исходнике невидим, и следующая правка строки убила бы его молча.
  const source = text.replace(/^\uFEFF/u, '');
  const delimiter = detectDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let hasContent = false;

  const endField = (): void => {
    row.push(field.trim());
    field = '';
  };
  const endRow = (): void => {
    endField();
    if (hasContent) rows.push(row);
    row = [];
    hasContent = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      /* \r\n разберётся на следующем шаге */
    } else if (ch !== undefined) {
      field += ch;
      if (ch.trim() !== '') hasContent = true;
    }
  }
  endRow();
  return rows;
}

function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/u, 1)[0] ?? '';
  let semicolons = 0;
  let commas = 0;
  let tabs = 0;
  let inQuotes = false;
  for (const ch of first) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (inQuotes) continue;
    else if (ch === ';') semicolons += 1;
    else if (ch === ',') commas += 1;
    else if (ch === '\t') tabs += 1;
  }
  if (tabs > semicolons && tabs > commas) return '\t';
  return semicolons > commas ? ';' : ',';
}

export type ColumnKind = 'email' | 'name' | 'password' | 'quota' | null;

const HEADERS: Readonly<Record<string, Exclude<ColumnKind, null>>> = {
  email: 'email',
  'e-mail': 'email',
  mail: 'email',
  адрес: 'email',
  почта: 'email',
  name: 'name',
  display_name: 'name',
  displayname: 'name',
  имя: 'name',
  фио: 'name',
  password: 'password',
  pass: 'password',
  пароль: 'password',
  quota: 'quota',
  quota_bytes: 'quota',
  квота: 'quota',
};

/** Что удалось понять о файле до отправки на сервер. */
export interface LocalCsvSummary {
  /** Распознанные столбцы по порядку (null — столбец не используется). */
  columns: ColumnKind[];
  /** Есть ли строка заголовка. */
  hasHeader: boolean;
  /** Сколько строк с данными. */
  dataRows: number;
  /** Первые строки для показа в таблице (без пароля). */
  sample: Array<{ email: string; name: string; quota: string; hasPassword: boolean }>;
  /** Замечания, которые видно сразу, без обращения к серверу. */
  notes: string[];
}

const KNOWN_KINDS: ColumnKind[] = ['email', 'name', 'password', 'quota'];

/** Быстрый локальный разбор файла для предварительной таблицы. */
export function summarizeCsv(text: string, sampleSize = 10): LocalCsvSummary {
  const table = splitCsv(text);
  const notes: string[] = [];
  if (table.length === 0) {
    return { columns: [], hasHeader: false, dataRows: 0, sample: [], notes: ['Файл пуст'] };
  }

  const first = table[0] ?? [];
  const hasHeader = first.some(
    (cell) => HEADERS[cell.trim().toLowerCase()] !== undefined && !cell.includes('@'),
  );
  const columns: ColumnKind[] = hasHeader
    ? first.map((cell) => HEADERS[cell.trim().toLowerCase()] ?? null)
    : [...KNOWN_KINDS];

  if (!hasHeader) {
    notes.push('Заголовок не найден — столбцы читаются как email, имя, пароль, квота');
  }
  if (!columns.includes('email')) {
    notes.push('Не найден столбец с адресом — импорт не получится');
  }
  if (!columns.includes('password')) {
    notes.push('Столбца с паролем нет — пароли будут сгенерированы');
  }

  const dataStart = hasHeader ? 1 : 0;
  const dataRows = Math.max(0, table.length - dataStart);
  const pick = (cells: string[], kind: Exclude<ColumnKind, null>): string => {
    const index = columns.indexOf(kind);
    return index >= 0 ? (cells[index] ?? '') : '';
  };

  const sample = table.slice(dataStart, dataStart + sampleSize).map((cells) => ({
    email: pick(cells, 'email').trim().toLowerCase(),
    name: pick(cells, 'name').trim(),
    quota: pick(cells, 'quota').trim(),
    hasPassword: pick(cells, 'password').trim() !== '',
  }));

  return { columns, hasHeader, dataRows, sample, notes };
}
