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
 *
 * ОПЕРАТОРЫ ОБРЕЗКУ НЕ ПЕРЕЖИВАЮТ, если о них не знать, — и это не
 * умозрительный риск, а найденный дефект. Слово-признак `непрочитанные`
 * обрезалось до `непрочитанн`, сервер такого признака не узнавал, и запрос
 * молча превращался в полнотекстовый поиск слова, которого нет ни в одном
 * письме: человек получал ноль там, где ждал весь непрочитанный ящик.
 * Название оператора `тема` обрезки не переживает тем более: `тем:договор`
 * — это уже не оператор.
 *
 * Поэтому разбор идёт по той же грамматике, что и на сервере
 * (packages/shared/src/search.ts):
 *
 *   слово-признак           — не трогаем вовсе;
 *   имя оператора           — не трогаем вовсе;
 *   значение оператора      — обрезаем только у `тема:`; адреса, имена
 *                             файлов, даты и размеры обрезать нельзя;
 *   фраза в кавычках        — точное совпадение, не трогаем;
 *   всё остальное           — свободные слова, обрезаем как раньше.
 */

import { isFlagWord, isOperatorName, operatorField } from '@mail-true/shared';

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
 *
 * Кавычки после двоеточия держатся при своём операторе: `тема:"годовой
 * отчёт"` — это ОДИН кусок, а не «тема:"годовой» и «отчёт"». Иначе значение
 * оператора разваливалось бы на полпути, а обрезка окончаний работала бы
 * с обломками. Незакрытая кавычка дочитывается до конца строки — человек
 * ещё печатает, и отказывать ему на полпути не за что.
 *
 * Ёлочки понимаются наравне с прямыми кавычками — по той же причине, что и
 * в грамматике (packages/shared/src/search.ts): фразу в поиск чаще вставляют
 * из редактора, чем набирают, а редактор ставит именно ёлочки.
 */
export function splitQueryParts(query: string): string[] {
  const parts = query.match(/[\p{L}\p{N}_]+:["«][^"»]*["»]?|["«][^"»]*["»]?|\S+/gu);
  return parts ?? [];
}

/** Кусок запроса, разобранный на имя оператора и значение. */
interface QueryPart {
  /** Имя оператора в том виде, как его написали. Пусто — свободные слова. */
  name: string | null;
  value: string;
  /** Значение было взято в кавычки — значит, это точная фраза. */
  quoted: boolean;
}

/**
 * Раскладывает кусок на имя оператора и значение — по той же грамматике,
 * что и сервер. Неизвестное слово перед двоеточием оператором не считается:
 * «встреча 14:30» и «Договор № 452/26: правки» обязаны остаться собой.
 */
function readPart(part: string): QueryPart {
  const unquote = (value: string): string => value.replace(/^["«]|["»]$/gu, '');
  const colon = part.indexOf(':');
  if (colon > 0) {
    const name = part.slice(0, colon);
    if (isOperatorName(name)) {
      const rest = part.slice(colon + 1);
      const quoted = /^["«]/u.test(rest);
      return { name, value: quoted ? unquote(rest) : rest, quoted };
    }
  }
  const quoted = /^["«]/u.test(part);
  return { name: null, value: quoted ? unquote(part) : part, quoted };
}

/** Собирает кусок обратно в строку запроса. */
function writePart(part: QueryPart, value: string): string {
  const body = part.quoted ? `"${value}"` : value;
  return part.name === null ? body : `${part.name}:${body}`;
}

/**
 * Запрос, который уходит на сервер: у каждого русского слова обрезано
 * окончание. Куски в кавычках — точная фраза, их не трогаем; операторы и
 * слова-признаки не трогаем тоже (см. шапку файла).
 */
export function stemSearchQuery(query: string): string {
  return splitQueryParts(query)
    .map((raw) => {
      const part = readPart(raw);
      if (part.quoted) return raw;
      if (part.name === null) {
        return isFlagWord(part.value) ? raw : trimRussianEnding(part.value);
      }
      // Обрезаем значение только там, где оно ищется как слово текста.
      if (operatorField(part.name) !== 'subject') return raw;
      return writePart(part, trimRussianEnding(part.value));
    })
    .join(' ');
}

/** Нормализация для сравнения: нижний регистр и ё → е (так же делает Xapian). */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

/**
 * Поля, значения которых подсвечиваются в выдаче.
 *
 * Даты, размеры и папка сюда не входят: подсвечивать «2026-01-01» в теме
 * письма незачем — это условие отбора, а не искомое слово. А вот имя
 * отправителя и слово из темы человек глазами ищет в строке списка, и
 * подсветка там помогает.
 */
const HIGHLIGHTED_FIELDS = new Set(['from', 'to', 'cc', 'subject', 'filename']);

/**
 * Основы слов запроса — по ним подсвечиваются совпадения в результатах.
 * Кавычки снимаются, пустые куски отбрасываются.
 *
 * Названия операторов в основы не попадают: подсвечивать слово «тема»
 * в темах писем — ровно то, чего человек не просил.
 */
export function queryStems(query: string): string[] {
  const stems: string[] = [];
  for (const raw of splitQueryParts(query)) {
    const part = readPart(raw);
    if (part.name !== null) {
      const field = operatorField(part.name);
      if (field === null || !HIGHLIGHTED_FIELDS.has(field)) continue;
      stems.push(part.quoted ? part.value : trimRussianEnding(part.value));
      continue;
    }
    // Слово-признак — это условие отбора, а не искомое слово
    if (isFlagWord(part.value)) continue;
    stems.push(part.quoted ? part.value : trimRussianEnding(part.value));
  }
  return [...new Set(stems.map((s) => normalizeForMatch(s).trim()).filter((s) => s.length > 0))];
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
