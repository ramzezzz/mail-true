/**
 * Подготовка поискового запроса и подсветка совпадений.
 *
 * ОГРАНИЧЕНИЕ ПОИСКОВОГО ДВИЖКА (docs/search.md). Dovecot FTS Xapian
 * настроен как `partial=3 full=20`: он индексирует n-граммы **от начала
 * слова**, то есть совпадение префиксное, а не морфологическое.
 *
 *   запрос «документ»     → находит «документы», «документами», «документов»
 *   запрос «документами»  → НЕ находит «документ»
 *
 * Настоящей лемматизации в fts-xapian 1.5.5 нет. Поэтому перед отправкой
 * запроса в API мы сами обрезаем у русских слов хвост окончания: пользователь
 * пишет «документами», а на сервер уходит «документ» — и письмо находится.
 *
 * Обрезка намеренно осторожная:
 *   - трогаем только кириллические слова длиной от 5 букв;
 *   - основа не короче MIN_STEM (4) — иначе «счета» превратилось бы в «сч»
 *     и поиск начал бы находить всё подряд;
 *   - латиница, цифры и слова в кавычках не меняются вовсе.
 */

/** Ниже этой длины основу не укорачиваем: слишком общий префикс. */
const MIN_STEM = 4;

/** Слова короче этого не разбираем — там нечего отрезать. */
const MIN_WORD = 5;

/**
 * Окончания, которые отрезаем. Порядок важен: список перебирается как есть,
 * поэтому длинные окончания стоят раньше своих коротких хвостов
 * («ами» раньше «ми» и «и»).
 */
const ENDINGS: readonly string[] = [
  // возвратные частицы — снимаются первым проходом
  'ся',
  'сь',
  // существительные и прилагательные, три буквы
  'ами',
  'ями',
  'ого',
  'его',
  'ому',
  'ему',
  'ыми',
  'ими',
  'ках',
  // две буквы
  'ах',
  'ях',
  'ов',
  'ев',
  'ей',
  'ий',
  'ый',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ом',
  'ем',
  'ам',
  'ям',
  'ах',
  'ых',
  'их',
  // глагольные
  'ешь',
  'ишь',
  'ете',
  'ите',
  'ут',
  'ют',
  'ат',
  'ят',
  'ла',
  'ло',
  'ли',
  'ть',
  // одна буква
  'а',
  'я',
  'ы',
  'и',
  'е',
  'о',
  'у',
  'ю',
  'ь',
  'й',
  'л',
];

const CYRILLIC_WORD = /^[а-яёА-ЯЁ]+$/u;

/** Отрезать одно окончание, если после этого основа не короче MIN_STEM. */
function stripOnce(word: string): string {
  for (const ending of ENDINGS) {
    if (word.length - ending.length >= MIN_STEM && word.endsWith(ending)) {
      return word.slice(0, word.length - ending.length);
    }
  }
  return word;
}

/**
 * Основа русского слова для префиксного поиска.
 *
 * Два прохода: первый снимает возвратную частицу или падежное окончание,
 * второй — то, что под ней («работаться» → «работать» → «работа»).
 * Не кириллица, короткие слова и слова с цифрами возвращаются как есть.
 */
export function trimRussianEnding(word: string): string {
  if (word.length < MIN_WORD || !CYRILLIC_WORD.test(word)) return word;
  const once = stripOnce(word);
  // Второй проход имеет смысл, только если первый что-то отрезал.
  return once === word ? word : stripOnce(once);
}

/**
 * Разбирает строку запроса на части, сохраняя куски в кавычках целиком.
 * `счета "за июль" 2026` → ['счета', '"за июль"', '2026'].
 */
export function splitQueryParts(query: string): string[] {
  const parts = query.match(/"[^"]*"|\S+/gu);
  return parts ?? [];
}

/**
 * Запрос, который уходит на сервер: у каждого русского слова обрезано
 * окончание. Куски в кавычках — точная фраза, их не трогаем.
 */
export function stemSearchQuery(query: string): string {
  return splitQueryParts(query)
    .map((part) => (part.startsWith('"') ? part : trimRussianEnding(part)))
    .join(' ');
}

/** Нормализация для сравнения: нижний регистр и ё → е (так же делает Xapian). */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

/**
 * Основы слов запроса — по ним подсвечиваются совпадения в результатах.
 * Кавычки снимаются, пустые куски отбрасываются.
 */
export function queryStems(query: string): string[] {
  const stems = splitQueryParts(query)
    .map((part) => (part.startsWith('"') ? part.replace(/"/gu, '') : trimRussianEnding(part)))
    .map((part) => normalizeForMatch(part).trim())
    .filter((part) => part.length > 0);
  return [...new Set(stems)];
}

export interface HighlightSegment {
  text: string;
  /** Кусок попал под запрос — рисуется жёлтой подсветкой. */
  hit: boolean;
}

/**
 * Разбивает текст на куски для подсветки. Совпадением считается **слово
 * целиком**, начинающееся с одной из основ: запрос «счет» подсвечивает
 * «Счёт» и «счета» полностью, как это делает mail.ru.
 *
 * Соседние куски одного вида склеиваются, поэтому на пустом запросе
 * возвращается ровно один сегмент с исходным текстом.
 */
export function highlightSegments(text: string, stems: readonly string[]): HighlightSegment[] {
  if (text.length === 0) return [];
  const usable = stems.filter((s) => s.length > 0);
  if (usable.length === 0) return [{ text, hit: false }];

  const normalized = normalizeForMatch(text);
  const hits = new Array<boolean>(text.length).fill(false);

  // Границы слов ищем по исходному тексту: нормализация длину не меняет.
  const wordRe = /[\p{L}\p{N}]+/gu;
  for (let match = wordRe.exec(normalized); match; match = wordRe.exec(normalized)) {
    const word = match[0];
    if (!usable.some((stem) => word.startsWith(stem))) continue;
    for (let i = match.index; i < match.index + word.length; i += 1) hits[i] = true;
  }

  const segments: HighlightSegment[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const hit = hits[i] === true;
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else segments.push({ text: text[i] ?? '', hit });
  }
  return segments;
}

/** Есть ли в тексте хоть одно совпадение с основами запроса. */
export function hasMatch(text: string, stems: readonly string[]): boolean {
  return highlightSegments(text, stems).some((s) => s.hit);
}
