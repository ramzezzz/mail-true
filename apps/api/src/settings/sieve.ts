/**
 * Перевод правил фильтрации в Sieve и обратно.
 *
 * Почему Sieve, а не своя машина исполнения: Dovecot уже умеет Sieve и
 * применяет его при доставке (LMTP), то есть правило срабатывает ровно
 * тогда, когда письмо приходит, даже если веб-интерфейс закрыт, а почта
 * читается с телефона. Своя машина означала бы вторую точку правды и
 * правила, которые «иногда не срабатывают».
 *
 * Модуль намеренно чистый: ни файлов, ни базы, ни сети — только строки.
 * Благодаря этому перевод и экранирование проверяются юнит-тестами,
 * а не «посмотрели глазами на живом сервере».
 *
 * Особенность окружения: глобальный фильтр спама
 * (infra/dovecot/sieve/spam-to-junk.sieve) подключён как `sieve_default`,
 * то есть применяется ТОЛЬКО к ящикам без личного скрипта. У ящика с
 * личным скриптом раскладку спама делает сам личный скрипт — блок в его
 * конце (spamFallbackBlock). Из этого следует правило, которое нельзя
 * нарушать: личный скрипт должен быть верным и собираться САМ ПО СЕБЕ.
 * Не собравшийся скрипт Pigeonhole отбрасывает целиком, глобальный его не
 * подстрахует, и ящик молча остаётся вообще без фильтрации.
 */
import { isUserLabelKey } from '../mail/labels.js';
import {
  DEFAULT_ACTIONS,
  type FilterActions,
  type FilterCondition,
  type FilterField,
  type FilterOperator,
  type FilterRule,
  type MailSettings,
} from './types.js';

/** Заголовок, которым rspamd помечает спам (см. infra/rspamd/local.d). */
export const SPAM_HEADER = 'X-Spam';
export const SPAM_HEADER_VALUE = 'Yes';

/**
 * Папка-корзина по умолчанию.
 *
 * Совпадает с ролью 'trash' в imap/service.ts. Вынесено в параметр сборки
 * (BuildSieveOptions.trashFolder), потому что путь корзины — это свойство
 * ЯЩИКА, а не генератора: узнать его можно только по списку папок IMAP,
 * а сюда файлы и сеть не пускаются вовсе.
 */
export const DEFAULT_TRASH_FOLDER = 'Trash';

/** Поля, которые проверяются не заголовком письма. */
type NonHeaderField = 'size' | 'body' | 'attachment';

/** Соответствие поля правила заголовку письма. */
const FIELD_HEADER: Record<Exclude<FilterField, NonHeaderField>, string> = {
  from: 'from',
  to: 'to',
  subject: 'subject',
  cc: 'cc',
  'resent-from': 'resent-from',
  'resent-to': 'resent-to',
};

const HEADER_FIELD: Record<string, FilterField> = Object.fromEntries(
  Object.entries(FIELD_HEADER).map(([field, header]) => [header, field as FilterField]),
);

/** Соответствие оператора компаратору Sieve и признаку отрицания. */
const OPERATOR_MATCH: Record<
  Exclude<FilterOperator, 'greater' | 'less' | 'has' | 'has-not'>,
  { match: ':contains' | ':is' | ':matches'; negate: boolean }
> = {
  contains: { match: ':contains', negate: false },
  'not-contains': { match: ':contains', negate: true },
  is: { match: ':is', negate: false },
  'not-is': { match: ':is', negate: true },
  matches: { match: ':matches', negate: false },
  'not-matches': { match: ':matches', negate: true },
};

/* ------------------------------------------------------------------ */
/* Экранирование                                                        */
/* ------------------------------------------------------------------ */

/**
 * Строка Sieve в кавычках (RFC 5228 §2.4.2).
 *
 * Специальных символов ровно два: обратная косая черта и кавычка —
 * их и экранируем. Управляющие символы (кроме перевода строки) убираем:
 * в заголовке письма их быть не может, а в файле правил они превращают
 * ошибку компиляции в загадку.
 */
export function quoteSieveString(value: string): string {
  // Запрет на управляющие символы снят осознанно: именно от них строка и
  // чистится — управляющий байт в правиле превращает отказ компилятора
  // Sieve в загадку.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Значение условия: одна строка (переводы строк в заголовке невозможны). */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Регистр в условиях с кириллицей                                      */
/* ------------------------------------------------------------------ */

/**
 * Почему правила с кириллицей приходится переводить в регулярное выражение.
 *
 * Способ сравнения (компаратор) в Sieve по умолчанию — `i;ascii-casemap`.
 * Он сворачивает регистр ТОЛЬКО для латиницы. Проверено на живом стенде:
 * правило «REPORT» ловит «Monthly report», правило «отчёт» ловит «Квартальный
 * отчёт за август», а правило «ОТЧЁТ» то же самое письмо НЕ ловит. Для
 * продукта с русским интерфейсом это значит, что человек пишет правило,
 * оно молча не работает, и понять почему невозможно.
 *
 * Что не подошло (проверено на этом же Dovecot 2.3.19 / Pigeonhole 0.5.19):
 *
 *   - `:comparator "i;unicode-casemap"` (RFC 5051) — правильный ответ по
 *     стандарту, но Pigeonhole его не знает вовсе:
 *     «unknown Sieve capability `comparator-i;unicode-casemap'»;
 *   - расширение `variables` и `set :lower` — компилируется, но регистр
 *     кириллицы не сворачивает: письмо с темой «КВАРТАЛЬНЫЙ ОТЧЁТ»
 *     до условия «отчёт» так и не доходит (проверено `sieve-test`);
 *   - `:regex` со скобочными классами `[Оо]` — не работает: сравнение
 *     побайтовое, а класс из многобайтовых символов разбирается как набор
 *     отдельных байтов.
 *
 * Работает перечисление вариантов через `|`: `(О|о)(Т|т)(Ч|ч)(Ё|ё)(Т|т)`.
 * Каждая альтернатива — целая последовательность байтов символа, поэтому
 * побайтовое сравнение с ней справляется. Проверено `sieve-test`: и на
 * теме в верхнем регистре, и на теме в нижнем — совпадение есть.
 *
 * Первой альтернативой всегда идёт символ КАК ЕГО НАПИСАЛ ПОЛЬЗОВАТЕЛЬ.
 * Это не украшение: по первой альтернативе условие разбирается обратно
 * (parseSieveScript) и восстанавливается ровно тем, чем было.
 *
 * Латиницу трогать незачем: с ней компаратор по умолчанию справляется сам,
 * а лишняя перегенерация файла всем ящикам ни к чему. Поэтому в regex
 * переводятся только условия, где есть буквы вне ASCII.
 */

/** Расширение Sieve, нужное таким условиям. */
export const REGEX_EXTENSION = 'regex';

/* ------------------------------------------------------------------ */
/* Заглушённые цепочки: включаемый файл                                 */
/* ------------------------------------------------------------------ */

/**
 * Имя включаемого файла (без расширения) со списком заглушённых цепочек.
 *
 * Сам файл собирает settings/sieve-muted.ts, а кладёт в ящик
 * settings/sieve-include.ts. Здесь — только имя и строка подключения:
 * личный скрипт обязан ссылаться на файл ровно тем же именем, каким его
 * пишут, и хранить это имя в двух местах нельзя.
 *
 * Префикс `mt-` — чтобы файл нельзя было спутать с личным скриптом самого
 * человека, если он когда-нибудь получит доступ по ManageSieve.
 */
export const MUTED_INCLUDE_NAME = 'mt-muted';

/** Расширение Sieve, которым подключается этот файл (RFC 6609). */
export const INCLUDE_EXTENSION = 'include';

/** Символы, особые для POSIX ERE. */
function escapeRegexChar(ch: string): string {
  return /[.[\]{}()*+?^$|\\/]/.test(ch) ? `\\${ch}` : ch;
}

/** Есть ли в значении буква вне ASCII, у которой различаются регистры. */
export function needsRegexMatch(value: string): boolean {
  for (const ch of value) {
    if (ch.charCodeAt(0) < 128) continue;
    if (ch.toLowerCase() !== ch.toUpperCase()) return true;
  }
  return false;
}

/** `(О|о)` для буквы с двумя регистрами, экранированный символ — для прочего. */
function charAlternatives(ch: string): string {
  const lower = ch.toLowerCase();
  const upper = ch.toUpperCase();
  if (lower === upper) return escapeRegexChar(ch);
  // Второй вариант — противоположный регистр; первым идёт то, что написали.
  const other = ch === lower ? upper : lower;
  if (other === ch || [...other].length !== 1) return escapeRegexChar(ch);
  return `(${escapeRegexChar(ch)}|${escapeRegexChar(other)})`;
}

/**
 * Переводит значение условия в регулярное выражение, нечувствительное
 * к регистру, включая кириллицу.
 *
 * `matches` сохраняет смысл подстановочных знаков Sieve: `*` — любое число
 * любых символов, `?` — ровно один.
 */
export function valueToRegex(value: string, op: 'contains' | 'is' | 'matches'): string {
  let body = '';
  for (const ch of value) {
    if (op === 'matches' && ch === '*') {
      body += '.*';
      continue;
    }
    if (op === 'matches' && ch === '?') {
      body += '.';
      continue;
    }
    body += charAlternatives(ch);
  }
  return op === 'contains' ? body : `^${body}$`;
}

/**
 * Обратный разбор valueToRegex: из выражения восстанавливается то, что
 * написал человек, и способ сравнения.
 *
 * Оговорка: `matches` без единого подстановочного знака неотличим от `is`
 * (это одно и то же условие), поэтому такое выражение разбирается как `is`.
 */
export function regexToValue(pattern: string): {
  value: string;
  op: 'contains' | 'is' | 'matches';
} {
  let body = pattern;
  const anchored = body.startsWith('^') && body.endsWith('$');
  if (anchored) body = body.slice(1, -1);

  let value = '';
  let wildcard = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (ch === '(') {
      const close = body.indexOf(')', i);
      const bar = body.indexOf('|', i);
      if (close > i && bar > i && bar < close) {
        // Первая альтернатива — символ в исходном регистре
        value += body.slice(i + 1, bar).replace(/\\(.)/g, '$1');
        i = close + 1;
        continue;
      }
    }
    if (ch === '\\') {
      value += body[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === '.') {
      if (body[i + 1] === '*') {
        value += '*';
        wildcard = true;
        i += 2;
        continue;
      }
      value += '?';
      wildcard = true;
      i += 1;
      continue;
    }
    value += ch;
    i += 1;
  }
  return { value, op: anchored ? (wildcard ? 'matches' : 'is') : 'contains' };
}

/* ------------------------------------------------------------------ */
/* Генерация                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* «Есть вложение»                                                      */
/* ------------------------------------------------------------------ */

/**
 * Как выражено условие «есть вложение».
 *
 * Прямого предиката «есть вложение» в Sieve нет: вложение — это не
 * свойство письма, а вывод из строения MIME. Проверены на нашем Dovecot
 * (2.3.19.1, Pigeonhole 0.5.19) три пути, живыми письмами через sieve-test:
 *
 *   1. `header :contains "Content-Type" "multipart"` — самый простой и
 *      самый неверный: под него подходит ЛЮБОЕ письмо с версткой, потому
 *      что html+текст — это multipart/alternative. На нашем письме без
 *      единого вложения условие срабатывало;
 *   2. `foreverypart` + `variables`: обход частей письма с записью ответа
 *      в переменную. Точнее всех — разбирает даже связку «вставленная
 *      картинка + вложение старого клиента». Отвергнут, и не из-за
 *      сложности: расширение `variables` меняет смысл СТРОК во всём файле.
 *      Проверено на стенде — с `require ["variables"]` уже написанное
 *      правило со значением `${name}` (такое приходит в темах рассылок)
 *      превращается в подстановку пустой строки, то есть в «содержит
 *      пустоту», то есть срабатывает НА ВСЕХ письмах. Правило с действием
 *      «удалить» после такого молча вычистило бы ящик;
 *   3. `:mime :anychild` из RFC 5703 — обход частей внутри одного теста,
 *      без переменных и без изменения смысла строк. Выбран он.
 *
 * Само условие читается так: часть письма считается вложением, если она
 * либо прямо объявлена вложением (`Content-Disposition: attachment`), либо
 * у неё есть имя файла (`filename=` или `name=`) и при этом нет
 * `Content-ID`. Вторая половина — не придирка: `Content-ID` есть у
 * картинок, вставленных в тело письма, и без этой проверки любая рассылка
 * с логотипом считалась бы письмом со вложением. Правило совпадает с тем,
 * по которому продукт рисует скрепку в списке писем (mail/structure.ts,
 * collectAttachments: inline = disposition inline И есть Content-ID) —
 * иначе правило срабатывало бы на письмах без скрепки.
 *
 * Известное ограничение выбранного пути: тесты внутри `allof` обходят
 * части НЕЗАВИСИМО друг от друга, поэтому письмо, где вставленная картинка
 * соседствует с вложением БЕЗ `Content-Disposition` (так делали почтовые
 * программы прошлого десятилетия), под условие не подойдёт. Проверено:
 * из восьми собранных писем расходится ровно это одно. Цена ошибки здесь —
 * правило не сработало; цена ошибки у пути с `variables` — правило
 * сработало на всём, и поэтому выбор такой.
 */
export const ATTACHMENT_TEST = [
  'anyof (',
  'header :mime :anychild :contains "Content-Disposition" "attachment", ',
  'allof (',
  'header :mime :anychild :param ["filename", "name"] ',
  ':matches ["Content-Type", "Content-Disposition"] "?*", ',
  'not header :mime :anychild :matches "Content-ID" "?*"',
  ')',
  ')',
].join('');

/** Расширение Sieve для условия «есть вложение» (RFC 5703). */
export const MIME_EXTENSION = 'mime';

/** Расширение Sieve для условия по тексту письма (RFC 5173). */
export const BODY_EXTENSION = 'body';

/** Один тест Sieve для условия правила. */
export function conditionToTest(condition: FilterCondition): string {
  if (condition.field === 'size') {
    const kb = Math.max(0, Math.trunc(Number(condition.value) || 0));
    // :over/:under — единственные сравнения размера в Sieve.
    // «Больше» => :over, «меньше» => :under; прочие операторы для размера
    // смысла не имеют и трактуются как «больше».
    const tag = condition.op === 'less' ? ':under' : ':over';
    return `size ${tag} ${String(kb)}K`;
  }
  if (condition.field === 'attachment') {
    // Значение условия здесь не участвует вовсе: спрашивается наличие.
    return condition.op === 'has-not' ? `not ${ATTACHMENT_TEST}` : ATTACHMENT_TEST;
  }

  const rule = OPERATOR_MATCH[condition.op as keyof typeof OPERATOR_MATCH] ?? OPERATOR_MATCH.contains;
  const value = oneLine(condition.value);
  // Кириллица (и любые буквы вне ASCII) — через :regex с перечислением
  // регистров: компаратор по умолчанию сворачивает регистр только латиницы
  // и правило «ОТЧЁТ» молча не срабатывает. Подробности — выше.
  //
  // Тело письма — тот же случай и та же проверка. Убедились на стенде
  // (sieve-test, письмо в base64 со словом «СЧЁТ»): `body :text :contains
  // "счёт"` его НЕ находит, а `body :text :regex "(с|С)(ч|Ч)(ё|Ё)(т|Т)"` —
  // находит, и в обоих регистрах.
  const needsRegex = needsRegexMatch(value);
  const pattern = needsRegex
    ? quoteSieveString(valueToRegex(value, rule.match.slice(1) as 'contains' | 'is' | 'matches'))
    : quoteSieveString(value);
  const match = needsRegex ? ':regex' : rule.match;

  if (condition.field === 'body') {
    // :text — текст письма без разметки и уже раскодированный: Pigeonhole
    // сам разбирает base64/quoted-printable и вычищает теги HTML. Проверено
    // на трёх письмах (base64, quoted-printable, html) — условие находит
    // слово во всех трёх, а :raw — только в незакодированном.
    const test = `body :text ${match} ${pattern}`;
    return rule.negate ? `not ${test}` : test;
  }

  const header = FIELD_HEADER[condition.field];
  const test = `header ${match} ${quoteSieveString(header)} ${pattern}`;
  return rule.negate ? `not ${test}` : test;
}

/** Тест «письмо не помечено как спам». */
function notSpamTest(): string {
  return `not header :is ${quoteSieveString(SPAM_HEADER)} ${quoteSieveString(SPAM_HEADER_VALUE)}`;
}

/** Собирает условие правила целиком, включая защиту от спама. */
export function ruleToTest(rule: FilterRule): string {
  const inner = rule.conditions.map(conditionToTest);
  const parts: string[] = [];
  if (!rule.actions.applyToSpam) parts.push(notSpamTest());

  if (inner.length === 0) {
    // Правило без условий применяется ко всем письмам.
    if (parts.length === 0) return 'true';
    return parts[0] as string;
  }
  if (rule.matchMode === 'any' && inner.length > 1) {
    parts.push(`anyof (${inner.join(', ')})`);
  } else {
    parts.push(...inner);
  }
  if (parts.length === 1) return parts[0] as string;
  return `allof (${parts.join(', ')})`;
}

/**
 * Метки правила, очищенные от всего, что меткой быть не может.
 *
 * Проверка не формальность: `addflag` принимает ЛЮБОЕ слово, и правило
 * с меткой «\Deleted» стирало бы почту, а с меткой «$Snoozed» — прятало
 * письма в «Отложенные». Через API такое не пройдёт (см. routes.ts), но
 * в базу правило может попасть и мимо API, а файл Sieve собирается из базы.
 */
function labelFlags(actions: FilterActions): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of actions.labels) {
    const trimmed = key.trim();
    if (!isUserLabelKey(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface ActionsToCommandsOptions {
  /** Полный путь корзины ящика. */
  trashFolder?: string | undefined;
}

/** Команды Sieve для действий правила, в порядке исполнения. */
export function actionsToCommands(
  actions: FilterActions,
  options: ActionsToCommandsOptions = {},
): string[] {
  const out: string[] = [];
  // Флаги ставятся ДО fileinto: иначе письмо ляжет в папку без них.
  if (actions.markRead) out.push('addflag "\\\\Seen";');
  if (actions.flag) out.push('addflag "\\\\Flagged";');
  // Метка — такое же ключевое слово IMAP, как «прочитано» и «флажок»
  // (mail/labels.ts), поэтому ставится тем же addflag и там же по порядку.
  for (const key of labelFlags(actions)) out.push(`addflag ${quoteSieveString(key)};`);

  if (actions.deleteMessage === 'purge') {
    /*
     * Безвозвратное удаление. `discard` отменяет доставку целиком: письма
     * не будет ни в корзине, ни в ящике вообще — его туда не положат.
     *
     * Всё, что стоит выше (метки, пересылка), уже отработало намеренно:
     * пересылка копии — единственный способ узнать, что правило вообще
     * что-то удалило. Всё, что ниже (папка), теряет смысл и не пишется.
     *
     * `stop` обязателен: без него следующие правила продолжали бы
     * разбираться с письмом, которого уже нет, и, например, блок раскладки
     * спама попытался бы положить его в «Спам».
     */
    out.push('discard;');
    out.push('stop;');
    return out;
  }

  for (const address of actions.forwardTo) {
    // :copy — переслать копию, оставив письмо себе. Без :copy Sieve
    // считает redirect доставкой и отменяет сохранение в ящик.
    out.push(`redirect :copy ${quoteSieveString(address)};`);
  }
  if (actions.autoReply) {
    const days = Math.min(365, Math.max(1, Math.trunc(actions.autoReply.days) || 7));
    const subject = actions.autoReply.subject
      ? ` :subject ${quoteSieveString(actions.autoReply.subject)}`
      : '';
    out.push(`vacation :days ${String(days)}${subject} ${quoteSieveString(actions.autoReply.text)};`);
  }

  if (actions.deleteMessage === 'trash') {
    /*
     * Удаление в корзину — это перекладывание в неё, и ничего больше.
     * Папка-приёмник при этом не пишется: «положить в Счета» и «удалить»
     * одновременно — противоречие, и разрешается оно в пользу удаления,
     * потому что именно его человек выбрал последним осознанным действием.
     */
    const trash = options.trashFolder?.trim() ? options.trashFolder.trim() : DEFAULT_TRASH_FOLDER;
    out.push(`fileinto :create ${quoteSieveString(trash)};`);
    out.push('stop;');
    return out;
  }

  if (actions.folder) {
    // :create — папку могли ещё не завести; без него письмо потерялось бы.
    out.push(`fileinto :create ${quoteSieveString(actions.folder)};`);
  }
  if (!actions.continueFiltering) out.push('stop;');
  return out;
}

/** Расширения Sieve, нужные набору правил. */
export function requiredExtensions(rules: FilterRule[], settings?: MailSettings | null): string[] {
  const need = new Set<string>();
  for (const rule of rules) {
    if (rule.actions.folder) {
      need.add('fileinto');
      need.add('mailbox');
    }
    if (rule.actions.markRead || rule.actions.flag || labelFlags(rule.actions).length > 0) {
      need.add('imap4flags');
    }
    if (rule.actions.forwardTo.length > 0) need.add('copy');
    if (rule.actions.autoReply) need.add('vacation');
    for (const condition of rule.conditions) {
      if (condition.field === 'body') need.add(BODY_EXTENSION);
      if (condition.field === 'attachment') need.add(MIME_EXTENSION);
      // Условия с кириллицей переводятся в :regex — см. valueToRegex.
      // Размера и вложения это не касается: там нет пользовательской строки.
      if (
        condition.field !== 'size' &&
        condition.field !== 'attachment' &&
        needsRegexMatch(oneLine(condition.value))
      ) {
        need.add(REGEX_EXTENSION);
      }
    }
  }
  /*
   * fileinto и mailbox нужны ВСЕГДА, даже если ни одно правило никуда
   * ничего не перекладывает.
   *
   * Причина — блок раскладки спама: buildSieveScript дописывает его в конец
   * каждого личного скрипта, и в нём есть `fileinto :create "Spam"`.
   * Раньше расширения объявлялись только по правилам, и ящик, у которого
   * настроен ОДИН автоответчик и ни одного правила, получал файл вида
   *
   *     require ["vacation", "date", "relational"];
   *     ...
   *     if header :is "X-Spam" "Yes" { fileinto :create "Spam"; stop; }
   *
   * Pigeonhole на такой файл отвечает «unknown command 'fileinto'» и
   * ОТКАЗЫВАЕТСЯ от скрипта целиком. Дальше молчаливо ломается всё сразу:
   * спам с оценкой 9.40 при пороге 6 ложится во «Входящие» (личный скрипт
   * мёртв, а глобальный к ящикам с личным скриптом не применяется —
   * sieve_default), автоответчик не отвечает, правила не работают.
   * Ошибка видна только в .dovecot.sieve.log внутри ящика. Проверено
   * на живом стенде: ящик test@mail.local, письмо [9.40/15.00] с
   * BLACKLIST_CONTENT — во «Входящих».
   */
  need.add('fileinto');
  need.add('mailbox');
  /*
   * include — тоже всегда, по той же причине и с той же ценой ошибки.
   *
   * Личный скрипт подключает файл заглушённых цепочек строкой
   * `include :optional :personal "mt-muted";`, и строка эта стоит в КАЖДОМ
   * файле, а не только у тех, кто что-то заглушил. Иначе получилась бы
   * зависимость наоборот: чтобы заглушить переписку, пришлось бы сперва
   * переписать личный файл правил — то есть перекомпилировать все правила
   * человека ради нашей возможности, да ещё и в момент, когда он ждёт
   * от кнопки мгновенного ответа.
   *
   * Отсутствующий файл при этом не стоит ничего: `:optional` велит
   * Pigeonhole молча пропустить строку (проверено компилятором на живом
   * стенде — ни ошибки, ни предупреждения).
   */
  need.add(INCLUDE_EXTENSION);
  if (settings?.autoReply.enabled) {
    need.add('vacation');
    if (settings.autoReply.from || settings.autoReply.until) {
      need.add('date');
      need.add('relational');
    }
  }
  // Порядок фиксирован: файл должен быть побайтово одинаковым при
  // одинаковых правилах, иначе «изменилось / не изменилось» не определить.
  const order = [
    'fileinto',
    'mailbox',
    INCLUDE_EXTENSION,
    'imap4flags',
    'copy',
    BODY_EXTENSION,
    MIME_EXTENSION,
    'vacation',
    'date',
    'relational',
    REGEX_EXTENSION,
  ];
  return order.filter((ext) => need.has(ext));
}

/** Комментарий-заголовок правила: по нему же имя восстанавливается при разборе. */
function ruleHeader(rule: FilterRule): string {
  const name = rule.name.trim() === '' ? `Правило ${String(rule.position + 1)}` : rule.name.trim();
  return `# === Правило: ${name.replace(/[\r\n]+/g, ' ')} ===`;
}

/** Дата в формате Sieve-теста currentdate :value (YYYY-MM-DD). */
function isoDate(value: string): string | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Блок общего автоответчика (раздел «Общие» настроек). */
function autoReplyBlock(settings: MailSettings): string[] {
  const ar = settings.autoReply;
  if (!ar.enabled || ar.text.trim() === '') return [];
  const guards: string[] = [notSpamTest()];
  const from = ar.from ? isoDate(ar.from) : null;
  const until = ar.until ? isoDate(ar.until) : null;
  if (from) guards.push(`currentdate :value "ge" "date" ${quoteSieveString(from)}`);
  if (until) guards.push(`currentdate :value "le" "date" ${quoteSieveString(until)}`);
  const test = guards.length === 1 ? (guards[0] as string) : `allof (${guards.join(', ')})`;
  const days = Math.min(365, Math.max(1, Math.trunc(ar.days) || 7));
  const subject = ar.subject ? ` :subject ${quoteSieveString(ar.subject)}` : '';
  return [
    '# === Автоответчик ===',
    `if ${test} {`,
    `\tvacation :days ${String(days)}${subject} ${quoteSieveString(ar.text)};`,
    '}',
    '',
  ];
}

/**
 * Раскладка спама в конце личного скрипта.
 *
 * Идёт последней: сначала правила с пометкой «применять к спаму» получают
 * шанс забрать письмо себе, а всё, что они не забрали, отправляется
 * в «Спам» — ровно то, что сделал бы глобальный фильтр. Блок обязателен
 * для КАЖДОГО личного скрипта: глобальный подключён как `sieve_default`
 * и к ящикам с личным скриптом не применяется вовсе.
 *
 * Использует fileinto и mailbox — поэтому оба расширения объявляются
 * в require всегда, независимо от правил (см. requiredExtensions).
 */
function spamFallbackBlock(): string[] {
  return [
    '# === Спам ===',
    '# Правила с пометкой «применять к спаму» уже отработали выше.',
    '# Всё, что они не забрали, раскладывается как обычный спам.',
    `if header :is ${quoteSieveString(SPAM_HEADER)} ${quoteSieveString(SPAM_HEADER_VALUE)} {`,
    '	fileinto :create "Spam";',
    '	stop;',
    '}',
    '',
  ];
}

export interface BuildSieveOptions {
  /** Адрес ящика — попадает в шапку файла для опознания. */
  accountEmail?: string;
  /** Общие настройки: нужны только ради автоответчика. */
  settings?: MailSettings | null;
  /**
   * Полный путь корзины ящика для действия «удалить в корзину».
   * По умолчанию — DEFAULT_TRASH_FOLDER: у нашего Dovecot корзина
   * называется именно так (imap/service.ts, роль 'trash').
   */
  trashFolder?: string | undefined;
}

/**
 * Собирает личный файл правил Sieve.
 *
 * Порядок в файле = порядок применения: правила сортируются по position,
 * выключенные не попадают в файл вовсе (но остаются в базе — их можно
 * включить обратно, ничего не потеряв).
 */
export function buildSieveScript(rules: FilterRule[], options: BuildSieveOptions = {}): string {
  const active = rules
    .filter((r) => r.enabled)
    .slice()
    .sort((a, b) => (a.position === b.position ? a.id - b.id : a.position - b.position));

  const settings = options.settings ?? null;
  const extensions = requiredExtensions(active, settings);

  const lines: string[] = [
    '# Файл сформирован Mail.True автоматически.',
    ...(options.accountEmail ? [`# Ящик: ${options.accountEmail}`] : []),
    '# Не редактируйте вручную: файл переписывается целиком при каждом',
    '# сохранении правил в настройках. Источник истины — база (mail_filters).',
    '#',
    '# Порядок правил в файле = порядок их применения.',
    '',
  ];

  if (extensions.length > 0) {
    lines.push(`require [${extensions.map(quoteSieveString).join(', ')}];`, '');
  }

  /*
   * Заглушённые цепочки — ПЕРВЫМИ, до правил пользователя.
   *
   * Порядок здесь и есть смысл возможности. «Заглушить» — это решение
   * человека о переписке ЦЕЛИКОМ, и оно сильнее любого правила про
   * отдельное письмо: если правило разложило бы письмо по папке, а человек
   * сказал «эта переписка меня не касается», побеждает человек. Файл
   * заканчивается командой stop, поэтому дальше заглушённое письмо не идёт
   * ни в правила, ни в раскладку спама.
   *
   * Строка стоит в файле всегда, даже когда заглушать нечего: см. пояснение
   * к include в requiredExtensions.
   */
  lines.push(
    '# === Заглушённые цепочки ===',
    '# Список ведётся отдельным файлом (settings/sieve-muted.ts): он меняется',
    '# кнопкой в почте, а этот файл — только сохранением настроек.',
    `include :optional :personal ${quoteSieveString(MUTED_INCLUDE_NAME)};`,
    '',
  );

  for (const rule of active) {
    const commands = actionsToCommands(rule.actions, { trashFolder: options.trashFolder });
    if (commands.length === 0) {
      // Правило без единого действия ничего не делает — в файл не пишем,
      // но и молчать нельзя: пусть будет видно, что оно есть.
      lines.push(ruleHeader(rule), '# (нет действий — правило ничего не меняет)', '');
      continue;
    }
    lines.push(ruleHeader(rule));
    lines.push(`if ${ruleToTest(rule)} {`);
    for (const command of commands) lines.push(`\t${command}`);
    lines.push('}', '');
  }

  /*
   * Блок раскладки спама дописывается ВСЕГДА, а не только когда есть правило
   * с пометкой «применять к спаму».
   *
   * Так было раньше, и это оставалось от прежней схемы, где глобальный фильтр
   * спама подключался через sieve_before и отрабатывал сам по себе. После
   * перевода его в sieve_default личный скрипт глобальный не дополняет, а
   * ЗАМЕНЯЕТ — и без этого блока любое личное правило, даже про совсем другое
   * письмо, молча отключало раскладку спама целиком. Проверено на живом
   * стенде: чистый ящик кладёт спам в «Спам», но стоит завести одно обычное
   * правило — и то же письмо с оценкой 10.45 остаётся во «Входящих».
   *
   * Признака в интерфейсе при этом нет никакого: человек настраивает правило
   * про счета, а перестаёт работать антиспам.
   */
  lines.push(...spamFallbackBlock());
  if (settings) lines.push(...autoReplyBlock(settings));

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Разбор обратно                                                       */
/* ------------------------------------------------------------------ */

type Token =
  | { kind: 'string'; value: string }
  | { kind: 'tag'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'number'; value: number; suffix: string }
  | { kind: 'punct'; value: string }
  | { kind: 'comment'; value: string };

export class SieveParseError extends Error {}

/** Разбивает текст скрипта на лексемы. Комментарии сохраняются: в них имена правил. */
export function tokenizeSieve(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      tokens.push({ kind: 'comment', value: text.slice(i + 1, end).trim() });
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < text.length) {
        const c = text[i] as string;
        if (c === '\\') {
          // В строке Sieve экранируется только следующий символ как есть.
          const next = text[i + 1];
          if (next === undefined) throw new SieveParseError('Обрыв строки после \\');
          out += next;
          i += 2;
          continue;
        }
        if (c === '"') {
          i += 1;
          tokens.push({ kind: 'string', value: out });
          break;
        }
        out += c;
        i += 1;
        if (i >= text.length) throw new SieveParseError('Незакрытая строка в кавычках');
      }
      continue;
    }
    if (ch === ':' && /[a-zA-Z]/.test(text[i + 1] ?? '')) {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j] as string)) j += 1;
      tokens.push({ kind: 'tag', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j] as string)) j += 1;
      const num = Number(text.slice(i, j));
      let suffix = '';
      if (j < text.length && /[KMGkmg]/.test(text[j] as string)) {
        suffix = (text[j] as string).toUpperCase();
        j += 1;
      }
      tokens.push({ kind: 'number', value: num, suffix });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j] as string)) j += 1;
      tokens.push({ kind: 'ident', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[],;'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new SieveParseError(`Неожиданный символ '${ch}' в позиции ${String(i)}`);
  }
  return tokens;
}

/** Правило, восстановленное из текста скрипта. */
export interface ParsedRule {
  name: string;
  matchMode: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterActions;
}

interface Cursor {
  tokens: Token[];
  pos: number;
}

function peek(c: Cursor): Token | undefined {
  return c.tokens[c.pos];
}

function next(c: Cursor): Token {
  const t = c.tokens[c.pos];
  if (!t) throw new SieveParseError('Неожиданный конец файла правил');
  c.pos += 1;
  return t;
}

function expectPunct(c: Cursor, value: string): void {
  const t = next(c);
  if (t.kind !== 'punct' || t.value !== value) {
    throw new SieveParseError(`Ожидалось '${value}'`);
  }
}

/** Разобранный элементарный тест. */
type ParsedTest =
  | { kind: 'condition'; condition: FilterCondition }
  | { kind: 'not-spam' }
  | { kind: 'true' }
  | { kind: 'group'; mode: 'all' | 'any'; items: ParsedTest[] }
  | { kind: 'other' };

/**
 * Лексемы обратно в строку без пробельных различий.
 *
 * Нужно ровно для одного: узнать условие «есть вложение». Оно собирается
 * не из одной лексемы, а из целого дерева тестов (ATTACHMENT_TEST), и
 * разбирать это дерево обратно по частям значило бы описать его правила
 * дважды — а два описания одного всегда расходятся. Вместо этого разобранный
 * кусок сравнивается с образцом, приведённым к тому же виду.
 */
function renderTokens(tokens: readonly Token[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    switch (token.kind) {
      case 'comment':
        break;
      case 'string':
        parts.push(`"${token.value}"`);
        break;
      case 'number':
        parts.push(`${String(token.value)}${token.suffix}`);
        break;
      default:
        parts.push(token.value);
    }
  }
  return parts.join(' ');
}

/** Образец условия «есть вложение» — с ним сравнивается разобранное. */
let attachmentSignature: string | null = null;
function attachmentTestSignature(): string {
  attachmentSignature ??= renderTokens(tokenizeSieve(ATTACHMENT_TEST));
  return attachmentSignature;
}

/** Пропускает аргументы теста до конца: запятой, скобки или начала блока. */
function skipTestArguments(c: Cursor): void {
  let depth = 0;
  for (;;) {
    const p = peek(c);
    if (!p) return;
    if (p.kind === 'punct') {
      if (p.value === '[' || p.value === '(') depth += 1;
      else if (p.value === ']' || p.value === ')') {
        if (depth === 0) return;
        depth -= 1;
      } else if (depth === 0 && (p.value === ',' || p.value === '{')) return;
    }
    c.pos += 1;
  }
}

function parseTest(c: Cursor, negated = false): ParsedTest {
  const t = next(c);
  if (t.kind !== 'ident') throw new SieveParseError('Ожидалось имя теста');

  if (t.value === 'not') return parseTest(c, !negated);

  if (t.value === 'true') return { kind: 'true' };

  if (t.value === 'allof' || t.value === 'anyof') {
    const start = c.pos - 1;
    expectPunct(c, '(');
    const items: ParsedTest[] = [];
    for (;;) {
      items.push(parseTest(c));
      const p = peek(c);
      if (p && p.kind === 'punct' && p.value === ',') {
        c.pos += 1;
        continue;
      }
      expectPunct(c, ')');
      break;
    }
    // «Есть вложение» — целое дерево тестов, а не один тест: узнаём его
    // по совпадению с образцом, см. attachmentTestSignature.
    if (renderTokens(c.tokens.slice(start, c.pos)) === attachmentTestSignature()) {
      return {
        kind: 'condition',
        condition: { field: 'attachment', op: negated ? 'has-not' : 'has', value: '' },
      };
    }
    return { kind: 'group', mode: t.value === 'allof' ? 'all' : 'any', items };
  }

  if (t.value === 'body' || t.value === 'header') {
    let match: ':contains' | ':is' | ':matches' = ':is';
    let regex = false;
    let mime = false;
    while (peek(c)?.kind === 'tag') {
      const tag = next(c) as { kind: 'tag'; value: string };
      if (tag.value === ':contains' || tag.value === ':is' || tag.value === ':matches') {
        match = tag.value;
      }
      if (tag.value === ':regex') regex = true;
      if (tag.value === ':mime') mime = true;
      // Способ сравнения задаётся тегом со строковым аргументом —
      // его нужно снять, иначе он будет принят за имя заголовка
      if (tag.value === ':comparator' && peek(c)?.kind === 'string') c.pos += 1;
      // :param и :content тоже берут аргумент — строку или список строк.
      // Список внутрь разбора не пускаем: тест с ним разбирается целиком
      // выше, по образцу (см. anyof), а сюда доходит только чужой скрипт.
      if (tag.value === ':param' || tag.value === ':content') {
        if (peek(c)?.kind === 'string') c.pos += 1;
        else if (peek(c)?.kind === 'punct' && peek(c)?.value === '[') skipTestArguments(c);
      }
    }
    // Тест по частям MIME (RFC 5703) в одиночку мы не собираем никогда:
    // он бывает только внутри условия «есть вложение». Значит, это чужой
    // скрипт — пропускаем тест целиком, но разбор не роняем.
    if (mime) {
      skipTestArguments(c);
      return { kind: 'other' };
    }

    // У header две строки (имя заголовка и значение), у body — одна:
    // тело письма называть не нужно, оно у письма одно.
    let headerName: string | null = null;
    if (t.value === 'header') {
      const headerToken = next(c);
      if (headerToken.kind !== 'string') {
        throw new SieveParseError('Тест header ожидает имя заголовка строкой');
      }
      headerName = headerToken.value.toLowerCase();
    }
    const valueToken = next(c);
    if (valueToken.kind !== 'string') {
      throw new SieveParseError(`Тест ${t.value} ожидает значение строкой`);
    }
    if (regex) {
      // Обратный разбор нашего же перевода кириллицы (см. valueToRegex):
      // из `(О|о)(Т|т)` восстанавливается «ОТ» — то, что написал человек.
      const decoded = regexToValue(valueToken.value);
      match = decoded.op === 'contains' ? ':contains' : decoded.op === 'is' ? ':is' : ':matches';
      valueToken.value = decoded.value;
    }
    const op: FilterOperator =
      match === ':contains'
        ? negated
          ? 'not-contains'
          : 'contains'
        : match === ':is'
          ? negated
            ? 'not-is'
            : 'is'
          : negated
            ? 'not-matches'
            : 'matches';

    if (headerName === null) {
      return { kind: 'condition', condition: { field: 'body', op, value: valueToken.value } };
    }

    if (
      negated &&
      headerName === SPAM_HEADER.toLowerCase() &&
      valueToken.value === SPAM_HEADER_VALUE
    ) {
      return { kind: 'not-spam' };
    }
    const field = HEADER_FIELD[headerName];
    if (!field) return { kind: 'other' };
    return { kind: 'condition', condition: { field, op, value: valueToken.value } };
  }

  if (t.value === 'size') {
    let tag = ':over';
    while (peek(c)?.kind === 'tag') {
      tag = (next(c) as { kind: 'tag'; value: string }).value;
    }
    const numToken = next(c);
    if (numToken.kind !== 'number') throw new SieveParseError('Тест size ожидает число');
    const multiplier = numToken.suffix === 'M' ? 1024 : numToken.suffix === 'G' ? 1024 * 1024 : 1;
    const kb = numToken.suffix === '' ? Math.round(numToken.value / 1024) : numToken.value * multiplier;
    return {
      kind: 'condition',
      condition: { field: 'size', op: tag === ':under' ? 'less' : 'greater', value: String(kb) },
    };
  }

  // Незнакомый тест (например currentdate у автоответчика): пропускаем
  // его аргументы до запятой, скобки или '{'.
  for (;;) {
    const p = peek(c);
    if (!p) break;
    if (p.kind === 'punct' && (p.value === ',' || p.value === ')' || p.value === '{')) break;
    c.pos += 1;
  }
  return { kind: 'other' };
}

/**
 * Разбирает блок команд `{ ... }` в действия правила.
 *
 * Оговорка про удаление, которую стоит знать читателю: «удалить в корзину»
 * возвращается сюда как папка-приёмник «Trash», а не как признак удаления.
 * Так и должно быть — в Sieve это одна и та же команда `fileinto "Trash"`,
 * и различить их в файле нечем. Разница живёт в базе (deleteMessage), она
 * же и источник истины; файл — производное. Безвозвратное удаление
 * (`discard`) двусмысленным не бывает и восстанавливается точно.
 */
function parseCommands(c: Cursor): FilterActions {
  const actions: FilterActions = { ...DEFAULT_ACTIONS, forwardTo: [], labels: [] };
  let sawStop = false;
  for (;;) {
    const t = peek(c);
    if (!t) throw new SieveParseError('Не закрыт блок правила');
    if (t.kind === 'punct' && t.value === '}') {
      c.pos += 1;
      break;
    }
    if (t.kind === 'comment') {
      c.pos += 1;
      continue;
    }
    const cmd = next(c);
    if (cmd.kind !== 'ident') throw new SieveParseError('Ожидалась команда');
    const args: Token[] = [];
    for (;;) {
      const p = peek(c);
      if (!p) throw new SieveParseError('Команда не закрыта символом ;');
      if (p.kind === 'punct' && p.value === ';') {
        c.pos += 1;
        break;
      }
      args.push(next(c));
    }
    switch (cmd.value) {
      case 'addflag':
      case 'setflag': {
        for (const a of args) {
          if (a.kind !== 'string') continue;
          for (const flag of a.value.split(/\s+/)) {
            if (flag === '\\Seen') actions.markRead = true;
            else if (flag === '\\Flagged') actions.flag = true;
            // Метка — обычное ключевое слово IMAP. Берём только СВОИ
            // (приставка `mt-`): чужие ключевые слова, которые поставила
            // другая почтовая программа, метками ящика не являются и
            // показывать их в правиле было бы выдумкой.
            else if (isUserLabelKey(flag) && !actions.labels.includes(flag)) {
              actions.labels.push(flag);
            }
          }
        }
        break;
      }
      case 'discard':
        actions.deleteMessage = 'purge';
        break;
      case 'redirect': {
        const addr = args.find((a) => a.kind === 'string');
        if (addr && addr.kind === 'string') actions.forwardTo.push(addr.value);
        break;
      }
      case 'fileinto': {
        const path = args.filter((a): a is Token & { kind: 'string' } => a.kind === 'string').pop();
        if (path) actions.folder = path.value;
        break;
      }
      case 'vacation': {
        let days = 7;
        let subject: string | null = null;
        let text = '';
        for (let k = 0; k < args.length; k += 1) {
          const a = args[k] as Token;
          if (a.kind === 'tag' && a.value === ':days') {
            const v = args[k + 1];
            if (v && v.kind === 'number') days = v.value;
            k += 1;
          } else if (a.kind === 'tag' && a.value === ':subject') {
            const v = args[k + 1];
            if (v && v.kind === 'string') subject = v.value;
            k += 1;
          } else if (a.kind === 'string') {
            text = a.value;
          }
        }
        actions.autoReply = { subject, text, days };
        break;
      }
      case 'stop':
        sawStop = true;
        break;
      default:
        break;
    }
  }
  actions.continueFiltering = !sawStop;
  return actions;
}

/** Разворачивает дерево тестов в плоский список условий правила. */
function flattenTest(test: ParsedTest): {
  conditions: FilterCondition[];
  matchMode: 'all' | 'any';
  applyToSpam: boolean;
} {
  let applyToSpam = true;
  const conditions: FilterCondition[] = [];
  let matchMode: 'all' | 'any' = 'all';

  const walk = (node: ParsedTest, mode: 'all' | 'any'): void => {
    switch (node.kind) {
      case 'not-spam':
        applyToSpam = false;
        break;
      case 'condition':
        conditions.push(node.condition);
        if (mode === 'any') matchMode = 'any';
        break;
      case 'group':
        for (const item of node.items) walk(item, node.mode);
        break;
      default:
        break;
    }
  };
  walk(test, 'all');
  return { conditions, matchMode, applyToSpam };
}

/**
 * Разбирает файл правил обратно в список правил.
 *
 * Нужен не для красоты: без обратного разбора нельзя проверить, что
 * перевод правил ничего не теряет, и нельзя показать пользователю,
 * что лежит в его личном файле, если файл правили в обход интерфейса.
 *
 * Восстанавливаются имя (из комментария-заголовка), условия, режим
 * соединения условий и действия. Выключенных правил в файле нет —
 * все разобранные считаются включёнными.
 */
export function parseSieveScript(text: string): ParsedRule[] {
  const tokens = tokenizeSieve(text);
  const c: Cursor = { tokens, pos: 0 };
  const rules: ParsedRule[] = [];
  let pendingName = '';
  let skipNextBlock = false;

  while (c.pos < tokens.length) {
    const t = next(c);
    if (t.kind === 'comment') {
      const m = /^===\s*Правило:\s*(.*?)\s*===$/.exec(t.value);
      if (m) {
        pendingName = m[1] ?? '';
        skipNextBlock = false;
      } else if (/^===\s*(Автоответчик|Спам)\s*===$/.test(t.value)) {
        // Блок общего автоответчика — не правило пользователя.
        skipNextBlock = true;
      }
      continue;
    }
    if (t.kind === 'ident' && t.value === 'require') {
      while (c.pos < tokens.length) {
        const p = next(c);
        if (p.kind === 'punct' && p.value === ';') break;
      }
      continue;
    }
    if (t.kind === 'ident' && t.value === 'if') {
      const test = parseTest(c);
      expectPunct(c, '{');
      const actions = parseCommands(c);
      if (skipNextBlock) {
        skipNextBlock = false;
        pendingName = '';
        continue;
      }
      const { conditions, matchMode, applyToSpam } = flattenTest(test);
      actions.applyToSpam = applyToSpam;
      rules.push({ name: pendingName, matchMode, conditions, actions });
      pendingName = '';
      continue;
    }
    // Прочие команды верхнего уровня пропускаем до ';'
    if (t.kind === 'ident') {
      while (c.pos < tokens.length) {
        const p = peek(c);
        if (!p) break;
        c.pos += 1;
        if (p.kind === 'punct' && p.value === ';') break;
      }
    }
  }
  return rules;
}
