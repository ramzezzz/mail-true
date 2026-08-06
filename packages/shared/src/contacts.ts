/**
 * Приведение адресов к общему виду и подготовка строки поиска.
 *
 * Отдельный файл без единой зависимости — намеренно: это единственное
 * место, где решается, что считать одним и тем же человеком и по каким
 * словам его можно найти. Тот же вопрос возникает в трёх местах сразу
 * (сборщик, поиск в базе, отбор в браузере), и три разных ответа означали
 * бы, что подсказка находит человека при вводе имени и теряет при вводе
 * адреса — то есть ведёт себя случайно.
 */

/** Адрес и имя рядом с ним, как они лежат в письме. */
export interface RawContact {
  name: string | null;
  address: string;
}

/**
 * Приводит адрес к виду, в котором он лежит в указателе.
 *
 * Регистр снимается целиком, включая локальную часть. По RFC 5321 она
 * регистрозависима, но ни один почтовый сервер в жизни этим не пользуется,
 * а различение дало бы две записи об одном человеке и два одинаковых
 * пункта в подсказке — из которых один заведомо лишний.
 *
 * Возвращает null для всего, что адресом не является: подсказывать «мусор
 * из заголовка» хуже, чем не подсказывать ничего.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  if (value.length === 0 || value.length > 320) return null;
  const at = value.indexOf('@');
  // Ровно одна собака, непустые части с обеих сторон, точка в домене и
  // никаких пробелов. Полную проверку по RFC здесь делать нечего: адрес
  // пришёл из доставленного письма, то есть уже прошёл через SMTP.
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return null;
  const domain = value.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;
  if (/[\s,;<>"]/.test(value)) return null;
  return value;
}

/**
 * Приводит имя к показываемому виду.
 *
 * Кавычки снимаются (в заголовке имя с запятой обязано быть в кавычках,
 * человеку они не нужны), пробелы схлопываются. Имя, совпадающее с самим
 * адресом, отбрасывается: строка «ivan@x.ru <ivan@x.ru>» в подсказке —
 * это шум, а не сведения.
 */
export function normalizeName(
  raw: string | null | undefined,
  address: string | null = null,
): string | null {
  const value = (raw ?? '')
    // Управляющие символы из заголовка: перевод строки внутри имени
    // разорвал бы пополам и строку поиска, и вывеску подсказки.
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length === 0) return null;
  if (address && value.toLowerCase() === address.toLowerCase()) return null;
  // Длинное «имя» — почти всегда не имя, а склеенный заголовок. В подсказке
  // ему всё равно не хватит места, а в базе он занимал бы килобайты.
  return value.length > 200 ? value.slice(0, 200).trim() : value;
}

/** Разделители внутри локальной части и имени: по ним слово рвётся. */
const WORD_SPLIT = /[\s.,_+/\\|()[\]{}'"«»@:;!?*&#-]+/u;

/**
 * Собирает строку поиска: слова имени, адрес целиком и его части.
 *
 * ПОЧЕМУ ИМЕННО СЛОВА, А НЕ ПОДСТРОКИ. Человек помнит корреспондента
 * по-разному: «Иван», «Петров», «iva». Все три — НАЧАЛА слов. Поиск же по
 * произвольной подстроке нашёл бы «Петрова» по запросу «етр» и вывалил бы
 * на человека выдачу, в которой его корреспондента не видно; вдобавок
 * подстрочный поиск не ложится ни на один индекс.
 *
 * Поэтому в строку кладутся все слова, с начала которых человек может
 * начать печатать:
 *
 *   Иван Петров <ivan.petrov@mail.example.com>
 *   -> «иван петров ivan.petrov@mail.example.com ivan petrov
 *       mail.example.com mail example»
 *
 * Запрос «iva» найдёт по слову «ivan», «petrov» — по слову «petrov»,
 * «петр» — по слову «петров», «mail.ex» — по слову «mail.example.com».
 */
export function contactTokens(name: string | null, address: string): string {
  const tokens: string[] = [];
  const push = (value: string): void => {
    const token = value.trim().toLowerCase();
    if (token.length > 0 && !tokens.includes(token)) tokens.push(token);
  };

  // Адрес целиком идёт первым: набранное «ivan@» должно находить человека
  // по самому очевидному признаку без всяких разбиений.
  push(address);
  const at = address.indexOf('@');
  if (at > 0) {
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    push(local);
    push(domain);
    for (const part of local.split(WORD_SPLIT)) push(part);
    // Домен без зоны: «example» для example.com. Компанию помнят по
    // названию, а не по «.com».
    const label = domain.split('.')[0];
    if (label) push(label);
  }
  if (name) {
    push(name);
    for (const part of name.split(WORD_SPLIT)) push(part);
  }
  return tokens.join(' ');
}

/** Приводит поисковый запрос к тому же виду, что и строка поиска. */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Совпадает ли строка поиска с запросом: любое слово начинается с запроса.
 *
 * Повторяет условие SQL-запроса один в один — и потому живёт здесь, в
 * общем пакете, а не рядом с запросом. Тем же правилом браузер отбирает
 * уже полученные подсказки, пока сервер отвечает на уточнённый запрос;
 * разойдись эти два правила — и список подсказок дёргался бы при каждой
 * набранной букве, то показывая человека, то теряя его.
 */
export function tokensMatch(tokens: string, query: string): boolean {
  const q = normalizeQuery(query);
  if (q === '') return false;
  return tokens.startsWith(q) || tokens.includes(` ${q}`);
}
