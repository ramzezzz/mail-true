/**
 * Разбор CSV для массового импорта ящиков.
 *
 * Импорт всегда двухшаговый: сначала предварительный показ (что именно будет
 * создано и что не так), только потом фактическое создание. Поэтому разбор —
 * чистая функция без побочных эффектов, её результат и показывается в
 * интерфейсе.
 *
 * Ожидаемые столбцы (регистр и порядок неважны, лишние игнорируются):
 *   email     — обязателен
 *   name      — отображаемое имя (синонимы: display_name, имя, фио)
 *   password  — пароль (синонимы: пароль); пусто -> сгенерируется
 *   quota     — квота: «1G», «500M», «1073741824» (синонимы: квота)
 *
 * Заголовок необязателен: если в первой строке нет слова «email»,
 * считаем, что столбцы идут в порядке email,name,password,quota.
 */
import { addressProblem, displayNameLengthProblem } from '@mail-true/shared';

/**
 * Нулевой байт в файле.
 *
 * Postgres не хранит 0x00 ни в одном текстовом поле: вставка валится с
 * «invalid byte sequence for encoding "UTF8": 0x00». Раньше такой файл
 * проходил разбор как ни в чём не бывало — панель докладывала «распознано
 * столько-то строк», то есть «файл в порядке», — и только потом сервер
 * отвечал 500 без объяснений, уже посреди импорта. Проверяем ДО базы.
 *
 * Прочие управляющие символы вреда не делают и отдельной проверки не
 * требуют: они доходят до базы и хранятся как есть.
 */
export function nulByteProblem(text: string): string | null {
  const index = text.indexOf('\u0000');
  if (index === -1) return null;
  const line = text.slice(0, index).split('\n').length;
  return (
    `В файле есть нулевой байт (0x00) — строка ${line}. В тексте такого символа ` +
    'быть не может: обычно так выглядит двоичный файл (например, .xlsx вместо .csv) ' +
    'или файл в кодировке UTF-16. Пересохраните таблицу как «CSV UTF-8» и повторите.'
  );
}

/** Разбор CSV по RFC 4180 с автоопределением разделителя (`,` или `;`). */
export function parseCsv(text: string): string[][] {
  // BOM записан кодом, а не самим символом: живой U+FEFF в исходнике
  // невидим, и правка строки убила бы его молча (тот же случай уже был
  // в packages/shared и в csvPreview админки).
  const source = text.replace(/^\uFEFF/u, '');
  const delimiter = detectDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let hasContent = false;

  const pushField = (): void => {
    row.push(field.trim());
    field = '';
  };
  const pushRow = (): void => {
    pushField();
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
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // \r\n обрабатывается на следующем шаге
    } else {
      field += ch;
      if (ch !== undefined && ch.trim() !== '') hasContent = true;
    }
  }
  pushRow();
  return rows;
}

/** Разделитель — тот, что чаще встречается вне кавычек в первой строке. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let semicolons = 0;
  let commas = 0;
  let tabs = 0;
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (inQuotes) continue;
    else if (ch === ';') semicolons += 1;
    else if (ch === ',') commas += 1;
    else if (ch === '\t') tabs += 1;
  }
  if (tabs > semicolons && tabs > commas) return '\t';
  return semicolons > commas ? ';' : ',';
}

const HEADER_ALIASES: Readonly<Record<string, 'email' | 'name' | 'password' | 'quota'>> = {
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

/** Квота из человеческой записи: «1G», «500 M», «2 ГБ», «1073741824». */
export function parseQuota(raw: string): number | null {
  const value = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (value === '') return null;
  const match = /^(\d+(?:[.,]\d+)?)(b|k|m|g|t|kb|mb|gb|tb|б|кб|мб|гб|тб)?$/u.exec(value);
  if (!match) return null;
  const numberPart = Number.parseFloat((match[1] ?? '0').replace(',', '.'));
  if (!Number.isFinite(numberPart) || numberPart < 0) return null;
  const unit = match[2] ?? '';
  const multipliers: Record<string, number> = {
    '': 1,
    b: 1,
    б: 1,
    k: 1024,
    kb: 1024,
    кб: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    мб: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    гб: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    тб: 1024 ** 4,
  };
  const factor = multipliers[unit];
  if (factor === undefined) return null;
  return Math.round(numberPart * factor);
}

/** Одна строка предварительного показа импорта. */
export interface ImportRow {
  /** Номер строки в исходном файле (1-based, с учётом заголовка). */
  line: number;
  email: string;
  displayName: string | null;
  /** Пароль из файла; null — сгенерируем при создании. */
  password: string | null;
  quotaBytes: number | null;
  /** Причины, по которым строка не будет создана. Пустой массив — всё хорошо. */
  errors: string[];
  /** Предупреждения, не мешающие созданию. */
  warnings: string[];
}

export interface ImportPreview {
  rows: ImportRow[];
  /** Сколько строк будет создано. */
  validCount: number;
  /** Сколько строк отброшено. */
  invalidCount: number;
  /** Домены, встретившиеся в файле (для проверки, что они заведены). */
  domains: string[];
  /** Был ли распознан заголовок. */
  hasHeader: boolean;
  /**
   * Файл длиннее предела — разобраны не все строки.
   *
   * Раньше об этом сообщала одна строка таблицы под номером 5002, в самом
   * низу списка из пяти тысяч: человек импортировал организацию на 20 000
   * человек, видел «отброшено 1 строка» и не узнавал, что 15 000 остались
   * без почты.
   */
  truncated: boolean;
  /** Сколько строк с данными в файле всего — включая неразобранные. */
  totalDataRows: number;
  /** Сколько строк разбирается за один раз. */
  maxRows: number;
}

export interface ImportOptions {
  /** Домены, которые уже есть в системе (остальные — ошибка). */
  knownDomains?: readonly string[];
  /** Адреса, которые уже заняты. */
  existingEmails?: readonly string[];
  /** Квота по умолчанию, если в файле не указана. */
  defaultQuotaBytes?: number;
  /** Разрешить создавать домены, которых ещё нет. */
  allowNewDomains?: boolean;
  /** Максимум строк за один импорт. */
  maxRows?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/** Определяет, является ли строка заголовком таблицы. */
function looksLikeHeader(cells: readonly string[]): boolean {
  return cells.some(
    (c) => HEADER_ALIASES[c.trim().toLowerCase()] !== undefined && !c.includes('@'),
  );
}

/**
 * Разбирает CSV в предварительный показ импорта.
 * Ничего не создаёт и не обращается к базе — все внешние сведения
 * передаются через options.
 */
export function parseUserImport(text: string, options: ImportOptions = {}): ImportPreview {
  const maxRows = options.maxRows ?? 5000;
  const knownDomains = new Set((options.knownDomains ?? []).map((d) => d.toLowerCase()));
  const existing = new Set((options.existingEmails ?? []).map((e) => e.toLowerCase()));
  const table = parseCsv(text);

  let columns: Array<'email' | 'name' | 'password' | 'quota' | null> = [
    'email',
    'name',
    'password',
    'quota',
  ];
  let startIndex = 0;
  const first = table[0];
  const hasHeader = first !== undefined && looksLikeHeader(first);
  if (hasHeader && first) {
    columns = first.map((cell) => HEADER_ALIASES[cell.trim().toLowerCase()] ?? null);
    startIndex = 1;
  }

  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  const domains = new Set<string>();

  // Считаем непустые строки заранее: без этого невозможно сказать, сколько
  // именно строк осталось за пределом, — а сказать это обязательно.
  let totalDataRows = 0;
  for (let i = startIndex; i < table.length; i += 1) {
    const cells = table[i];
    if (cells && !cells.every((c) => c === '')) totalDataRows += 1;
  }
  const truncated = totalDataRows > maxRows;

  for (let i = startIndex; i < table.length; i += 1) {
    const cells = table[i];
    if (!cells || cells.every((c) => c === '')) continue;
    const line = i + 1;

    // Перебор прекращаем молча: об усечении говорит признак truncated,
    // а не строка-заглушка в самом низу таблицы, которую никто не видит.
    if (rows.length >= maxRows) break;

    const pick = (kind: 'email' | 'name' | 'password' | 'quota'): string => {
      const index = columns.indexOf(kind);
      return index >= 0 ? (cells[index] ?? '') : '';
    };

    const errors: string[] = [];
    const warnings: string[] = [];
    const email = pick('email').trim().toLowerCase();
    const displayNameRaw = pick('name').trim();
    const passwordRaw = pick('password');
    const quotaRaw = pick('quota').trim();

    // Форма и длина одной проверкой — та же, что и при создании ящика
    // поштучно, и с теми же человеческими объяснениями.
    const addressBad = addressProblem(email);
    if (email === '') {
      errors.push('Пустой адрес');
    } else if (!EMAIL_RE.test(email) && addressBad === null) {
      errors.push(`Некорректный адрес: «${email}»`);
    } else if (addressBad !== null) {
      errors.push(addressBad);
    } else {
      const domain = email.slice(email.indexOf('@') + 1);
      domains.add(domain);
      if (seen.has(email)) {
        errors.push('Повтор адреса внутри файла');
      } else {
        seen.add(email);
      }
      if (existing.has(email)) {
        errors.push('Такой ящик уже существует');
      }
      if (knownDomains.size > 0 && !knownDomains.has(domain)) {
        if (options.allowNewDomains) {
          warnings.push(`Домена «${domain}» ещё нет — он будет создан`);
        } else {
          errors.push(`Домен «${domain}» не заведён в системе`);
        }
      }
    }

    // Раньше слишком длинное имя молча обрезалось до 255 символов: ящик
    // создавался, а имя в нём оказывалось не тем, что в файле. Теперь строка
    // отбрасывается с объяснением — молчаливой порчи данных быть не должно.
    const displayNameTooLong = displayNameLengthProblem(displayNameRaw);
    if (displayNameTooLong !== null) errors.push(displayNameTooLong);

    let password: string | null = null;
    if (passwordRaw.trim() !== '') {
      if (passwordRaw.trim().length < 8) {
        errors.push('Пароль короче 8 символов');
      } else {
        password = passwordRaw.trim();
      }
    } else {
      warnings.push('Пароль не задан — будет сгенерирован');
    }

    let quotaBytes: number | null = null;
    if (quotaRaw !== '') {
      const parsed = parseQuota(quotaRaw);
      if (parsed === null) {
        errors.push(`Не удалось понять квоту: «${quotaRaw}»`);
      } else if (parsed === 0) {
        warnings.push('Квота 0 — без ограничения');
        quotaBytes = 0;
      } else {
        quotaBytes = parsed;
      }
    } else if (options.defaultQuotaBytes !== undefined) {
      quotaBytes = options.defaultQuotaBytes;
    }

    rows.push({
      line,
      email,
      displayName: displayNameRaw === '' ? null : displayNameRaw,
      password,
      quotaBytes,
      errors,
      warnings,
    });
  }

  const validCount = rows.filter((r) => r.errors.length === 0).length;
  return {
    rows,
    validCount,
    invalidCount: rows.length - validCount,
    domains: [...domains].sort(),
    hasHeader,
    truncated,
    totalDataRows,
    maxRows,
  };
}
