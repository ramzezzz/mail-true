/**
 * Язык поисковых запросов: операторы вида `от:`, `тема:`, `есть:вложение`.
 *
 * ПОЧЕМУ ЭТО ЛЕЖИТ В ОБЩЕМ ПАКЕТЕ, А НЕ В API. Разбор нужен обеим сторонам,
 * и по разным поводам:
 *
 *   сервер — чтобы превратить операторы в условия IMAP SEARCH;
 *   браузер — чтобы показать чипы «во что превратился запрос», не обрезать
 *             окончания у названий операторов и применить те операторы,
 *             которые сервер применить не может (`папка:` — область поиска
 *             выбирает вызывающий, см. ниже).
 *
 * Две отдельные реализации одной грамматики разошлись бы в первый же месяц,
 * и разошлись бы молча: браузер рисовал бы чип «Тема: договор», а сервер
 * искал бы слова «тема:договор» в теле письма. Поэтому грамматика одна.
 *
 * Операторы русские, потому что продукт русский. Латинские синонимы приняты
 * тоже: человек, пришедший из Gmail, наберёт `from:` не задумываясь, и
 * отвечать ему пустым списком — значит наказывать за прошлый опыт.
 *
 *   от:иванов        кому:отдел        тема:договор      копия:юрист
 *   from:ivanov      to:sales          subject:contract  cc:lawyer
 *   есть:вложение    файл:.pdf         папка:Рассылки
 *   has:attachment   filename:.pdf     folder:Newsletters
 *   после:2026-01-01 до:2026-08-01     старше:1г         новее:7д
 *   больше:5м        меньше:100к
 *   непрочитанные    важные
 *
 * ГЛАВНОЕ ПРАВИЛО РАЗБОРА. Оператором считается только известное слово из
 * списка с непустым и осмысленным значением. Всё прочее — обычные слова
 * полнотекстового поиска. Это не снисходительность к пользователю, а
 * защита от целого класса пустых выдач: двоеточие в обычном запросе
 * встречается сплошь и рядом («Договор № 452/26: правки», «встреча 14:30»,
 * «Re: смета»), и разборщик, объявляющий такое ошибкой или полем, ломал бы
 * ровно те запросы, которые человек набрал правильно.
 *
 * Незакрытая кавычка — не ошибка, а недопечатанная строка: `тема:"годовой
 * отчёт` читается как `тема:годовой отчёт`. Человек продолжает печатать,
 * а не получает отказ на полпути.
 */

/** Разобранный запрос: операторы отдельно, свободный текст отдельно. */
export interface ParsedSearch {
  /** Слова, не попавшие ни в один оператор. */
  text: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  /**
   * Только письма с вложениями.
   *
   * Здесь `false` значит «про вложения не спрашивали», а НЕ «письма без
   * вложений»: обратного оператора у нас нет. Остальные поля говорят то же
   * самое через `null`, и это единственное место, где условие выражено
   * иначе, — потому и написано.
   *
   * Если однажды появится «без вложения», поле обязано стать
   * `boolean | null`: иначе новое условие молча совпадёт с «не спрашивали»
   * и отсечёт ровно те письма, ради которых его завели.
   */
  hasAttachment: boolean;
  /**
   * Имя вложения или его кусок: `файл:.pdf`, `файл:договор`.
   * Подразумевает и `hasAttachment` — искать имя файла у письма без
   * вложений бессмысленно.
   */
  filename: string | null;
  /**
   * Где искать: имя или идентификатор папки, как его написал человек.
   *
   * Применяет ВЫЗЫВАЮЩИЙ, а не сборка запроса к IMAP: у IMAP папка не
   * условие поиска, а то, что открыто до поиска. В браузере это область
   * поиска (какие папки опрашивать), в API — параметр `folderId`.
   * Здесь оператор разбирается ради одного: чтобы `папка:Рассылки` не
   * ушло в полнотекстовый поиск обычными словами и не дало пустоту.
   */
  folder: string | null;
  seen: boolean | null;
  flagged: boolean | null;
  /** Письма не раньше этой даты (включительно). */
  since: Date | null;
  /** Письма не позже этой даты (включительно). */
  before: Date | null;
  /** Размер письма больше стольких байт. */
  larger: number | null;
  /** Размер письма меньше стольких байт. */
  smaller: number | null;
}

const EMPTY: ParsedSearch = {
  text: null,
  from: null,
  to: null,
  cc: null,
  subject: null,
  hasAttachment: false,
  filename: null,
  folder: null,
  seen: null,
  flagged: null,
  since: null,
  before: null,
  larger: null,
  smaller: null,
};

/** Текстовые операторы: значение дописывается как есть. */
const FIELD_ALIASES: Record<string, 'from' | 'to' | 'cc' | 'subject' | 'filename' | 'folder'> = {
  'от': 'from',
  'from': 'from',
  'кому': 'to',
  'to': 'to',
  'копия': 'cc',
  'cc': 'cc',
  'тема': 'subject',
  'subject': 'subject',
  'файл': 'filename',
  'вложение': 'filename',
  'filename': 'filename',
  'папка': 'folder',
  'folder': 'folder',
};

/** Операторы, у которых значение — календарная дата ГГГГ-ММ-ДД. */
const DATE_ALIASES: Record<string, 'since' | 'before'> = {
  'после': 'since',
  'since': 'since',
  'after': 'since',
  'до': 'before',
  'before': 'before',
};

/** Операторы «за последние N» и «старше N». */
const AGE_ALIASES: Record<string, 'since' | 'before'> = {
  'новее': 'since',
  'newer': 'since',
  'newer_than': 'since',
  'старше': 'before',
  'older': 'before',
  'older_than': 'before',
};

/** Операторы размера письма. */
const SIZE_ALIASES: Record<string, 'larger' | 'smaller'> = {
  'больше': 'larger',
  'larger': 'larger',
  'меньше': 'smaller',
  'smaller': 'smaller',
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

/** Названия операторов «есть». */
const HAS_NAMES = new Set(['есть', 'has']);

type Writable = { -readonly [K in keyof ParsedSearch]: ParsedSearch[K] };

/**
 * Какое поле стоит за словом слева от двоеточия. `null` — слово неизвестное,
 * то есть это обычный текст, а не оператор.
 *
 * Нужно браузеру, и не для красоты. Во-первых, обрезать окончание у слова
 * `тема` в `тема:договор` нельзя — получилось бы `тем:договор`, и оператор
 * умер бы по дороге на сервер. Во-вторых, значения у операторов разные по
 * природе: тему обрезать до основы надо (поиск префиксный, см.
 * apps/web/src/lib/searchQuery.ts), а дату, размер и имя файла — ни в коем
 * случае.
 */
export function operatorField(name: string): keyof ParsedSearch | 'hasAttachment' | null {
  const lower = name.toLowerCase();
  return (
    FIELD_ALIASES[lower] ??
    DATE_ALIASES[lower] ??
    AGE_ALIASES[lower] ??
    SIZE_ALIASES[lower] ??
    (HAS_NAMES.has(lower) ? 'hasAttachment' : null)
  );
}

/** Известно ли разборщику слово слева от двоеточия. */
export function isOperatorName(name: string): boolean {
  return operatorField(name) !== null;
}

/**
 * Слово-признак без двоеточия: `непрочитанные`, `важные`, `unread`.
 *
 * Браузеру нужно затем, чтобы не обрезать у него окончание: `непрочитанные`
 * после обрезки становится `непрочитанн`, и сервер такого признака уже не
 * узнаёт — поиск молча превращается в полнотекстовый по слову, которого
 * нет ни в одном письме.
 */
export function isFlagWord(token: string): boolean {
  return token.toLowerCase() in FLAG_WORDS;
}

/**
 * Режет строку на части, уважая кавычки: `тема:"годовой отчёт"` — одно слово.
 * Незакрытая кавычка дочитывается до конца строки (см. шапку файла).
 *
 * Ёлочки (`«»`) понимаются наравне с прямыми кавычками. Это не любезность:
 * русская раскладка и любой текстовый редактор ставят именно их, а фразу
 * в поиск чаще всего вставляют откуда-то, а не набирают. Строка
 * `тема:«годовой отчёт»`, разобранная как две отдельные части, дала бы
 * пустоту — и человек решил бы, что кавычки в поиске не работают вовсе.
 */
export function tokenizeSearch(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === '«') {
      quoted = true;
      continue;
    }
    if (ch === '»') {
      quoted = false;
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

/** Сколько дней в единице срока. Месяц и год — календарные, считаем точно. */
const AGE_UNITS: Record<string, 'day' | 'week' | 'month' | 'year'> = {
  'д': 'day', 'дн': 'day', 'день': 'day', 'дня': 'day', 'дней': 'day', 'd': 'day', 'day': 'day', 'days': 'day',
  'н': 'week', 'нед': 'week', 'неделя': 'week', 'недели': 'week', 'недель': 'week', 'w': 'week', 'week': 'week', 'weeks': 'week',
  'м': 'month', 'мес': 'month', 'месяц': 'month', 'месяца': 'month', 'месяцев': 'month', 'm': 'month', 'month': 'month', 'months': 'month',
  'г': 'year', 'год': 'year', 'года': 'year', 'лет': 'year', 'y': 'year', 'year': 'year', 'years': 'year',
};

/**
 * Срок «столько-то назад» в дату. `1г`, `7д`, `3мес`, `2y`.
 *
 * Считаем календарём (`setUTCMonth`, `setUTCFullYear`), а не умножением на
 * 30 дней: «старше года» человек понимает как «до этого же числа прошлого
 * года», и в високосном году приближение уехало бы на сутки.
 */
function parseAge(value: string, now: Date): Date | null {
  const match = /^(\d{1,4})\s*([\p{L}_]+)$/u.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = AGE_UNITS[(match[2] ?? '').toLowerCase()];
  if (!unit || amount <= 0) return null;
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (unit === 'day') date.setUTCDate(date.getUTCDate() - amount);
  if (unit === 'week') date.setUTCDate(date.getUTCDate() - amount * 7);
  if (unit === 'month') date.setUTCMonth(date.getUTCMonth() - amount);
  if (unit === 'year') date.setUTCFullYear(date.getUTCFullYear() - amount);
  return date;
}

/** Множители размера. Килобайт здесь двоичный — как его считает почтовый клиент. */
const SIZE_UNITS: Record<string, number> = {
  '': 1, 'б': 1, 'b': 1,
  'к': 1024, 'кб': 1024, 'k': 1024, 'kb': 1024,
  'м': 1024 * 1024, 'мб': 1024 * 1024, 'm': 1024 * 1024, 'mb': 1024 * 1024,
  'г': 1024 * 1024 * 1024, 'гб': 1024 * 1024 * 1024, 'g': 1024 * 1024 * 1024, 'gb': 1024 * 1024 * 1024,
};

/** `5м`, `500к`, `1048576` в байты. */
function parseSize(value: string): number | null {
  const match = /^(\d{1,9})\s*([\p{L}]*)$/u.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const factor = SIZE_UNITS[(match[2] ?? '').toLowerCase()];
  if (factor === undefined || amount <= 0) return null;
  return amount * factor;
}

/**
 * Разбирает поисковую строку.
 *
 * `now` — только ради проверок и ради того, чтобы «старше:1г» на сервере и
 * в браузере считалось от одного и того же мгновения.
 */
export function parseSearch(input: string | undefined | null, now: Date = new Date()): ParsedSearch {
  const raw = (input ?? '').trim();
  if (raw === '') return { ...EMPTY };

  const out: Writable = { ...EMPTY };
  const words: string[] = [];

  for (const token of tokenizeSearch(raw)) {
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
        const ageField = AGE_ALIASES[name];
        if (ageField) {
          const date = parseAge(value, now);
          if (date) {
            out[ageField] = date;
            continue;
          }
        }
        const sizeField = SIZE_ALIASES[name];
        if (sizeField) {
          const bytes = parseSize(value);
          if (bytes !== null) {
            out[sizeField] = bytes;
            continue;
          }
        }
        if (HAS_NAMES.has(name) && HAS_VALUES.has(value.toLowerCase())) {
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

  /*
   * Имя файла подразумевает вложение. Иначе `файл:.pdf` вело бы себя как
   * «письма, где где-то встречается .pdf» — а человек просил письма
   * с приложенным PDF.
   */
  if (out.filename) out.hasAttachment = true;

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
    parsed.filename !== null ||
    parsed.folder !== null ||
    parsed.hasAttachment ||
    parsed.seen !== null ||
    parsed.flagged !== null ||
    parsed.since !== null ||
    parsed.before !== null ||
    parsed.larger !== null ||
    parsed.smaller !== null
  );
}

/* ------------------------------------------------------------------ */
/* Подсказка и чипы                                                    */
/* ------------------------------------------------------------------ */

/**
 * Справочник операторов для подсказки человеку.
 *
 * Живёт рядом с разборщиком намеренно: подсказка, которая обещает оператор,
 * не понимаемый разборщиком, — это ложь интерфейса, и заметить её можно
 * только руками. Здесь два списка стоят в одном файле, и расхождение видно
 * при первом же чтении.
 */
export interface SearchOperatorHelp {
  /** Как писать по-русски. */
  sample: string;
  /** Латинский синоним — для тех, кто пришёл из Gmail. */
  latin: string;
  /** Что делает, одной строкой. */
  hint: string;
}

export const SEARCH_OPERATORS: readonly SearchOperatorHelp[] = [
  { sample: 'от:волкова', latin: 'from:', hint: 'письма от этого отправителя' },
  { sample: 'кому:отдел', latin: 'to:', hint: 'письма этому получателю' },
  { sample: 'копия:юрист', latin: 'cc:', hint: 'адрес стоит в копии' },
  { sample: 'тема:договор', latin: 'subject:', hint: 'слово в теме письма' },
  { sample: 'есть:вложение', latin: 'has:attachment', hint: 'только письма с вложениями' },
  { sample: 'файл:.pdf', latin: 'filename:', hint: 'имя или расширение вложения' },
  { sample: 'папка:Рассылки', latin: 'folder:', hint: 'искать только в этой папке' },
  { sample: 'после:2026-01-01', latin: 'after:', hint: 'не раньше этой даты' },
  { sample: 'до:2026-08-01', latin: 'before:', hint: 'не позже этой даты' },
  { sample: 'новее:7д', latin: 'newer_than:', hint: 'за последние дни, недели, месяцы, годы' },
  { sample: 'старше:1г', latin: 'older_than:', hint: 'старше срока' },
  { sample: 'больше:5м', latin: 'larger:', hint: 'письма тяжелее указанного размера' },
  { sample: 'меньше:100к', latin: 'smaller:', hint: 'письма легче указанного размера' },
  { sample: 'непрочитанные', latin: 'unread', hint: 'слово-признак, двоеточие не нужно' },
  { sample: 'важные', latin: 'flagged', hint: 'помеченные флажком' },
];

/**
 * Чип над выдачей: во что превратился кусок запроса.
 *
 * Показывать это обязательно. Разборщик молча меняет смысл строки, и без
 * чипов человек, набравший `Договор № 452/26: правки`, не может отличить
 * «нашлось ноль писем» от «запрос понят не так, как я думал».
 */
export interface SearchChip {
  /** Ключ поля — интерфейсу для значка и для снятия чипа. */
  field: keyof ParsedSearch;
  /** Название поля по-человечески: «Отправитель». */
  title: string;
  /** Значение, как его показать: «волкова», «с 15 января 2026». */
  value: string;
}

const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Размер человеческими единицами: 5 МБ, 100 КБ. */
export function formatSearchSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${String(Math.round(bytes / (1024 * 1024 * 1024)))} ГБ`;
  if (bytes >= 1024 * 1024) return `${String(Math.round(bytes / (1024 * 1024)))} МБ`;
  if (bytes >= 1024) return `${String(Math.round(bytes / 1024))} КБ`;
  return `${String(bytes)} Б`;
}

/** Разобранный запрос словами человека — по одному чипу на условие. */
export function describeSearch(parsed: ParsedSearch): SearchChip[] {
  const chips: SearchChip[] = [];
  const add = (field: keyof ParsedSearch, title: string, value: string): void => {
    chips.push({ field, title, value });
  };
  if (parsed.from) add('from', 'Отправитель', parsed.from);
  if (parsed.to) add('to', 'Получатель', parsed.to);
  if (parsed.cc) add('cc', 'В копии', parsed.cc);
  if (parsed.subject) add('subject', 'Тема', parsed.subject);
  if (parsed.folder) add('folder', 'Папка', parsed.folder);
  if (parsed.filename) add('filename', 'Вложение', parsed.filename);
  else if (parsed.hasAttachment) add('hasAttachment', 'Вложения', 'есть');
  if (parsed.seen === false) add('seen', 'Признак', 'непрочитанные');
  if (parsed.seen === true) add('seen', 'Признак', 'прочитанные');
  if (parsed.flagged === true) add('flagged', 'Признак', 'важные');
  if (parsed.since) add('since', 'С даты', DATE_FORMAT.format(parsed.since));
  if (parsed.before) add('before', 'По дату', DATE_FORMAT.format(parsed.before));
  if (parsed.larger !== null) add('larger', 'Больше', formatSearchSize(parsed.larger));
  if (parsed.smaller !== null) add('smaller', 'Меньше', formatSearchSize(parsed.smaller));
  if (parsed.text) add('text', 'Слова', parsed.text);
  return chips;
}
