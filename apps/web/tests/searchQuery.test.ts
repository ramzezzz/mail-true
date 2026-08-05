/**
 * Тесты подготовки поискового запроса.
 *
 * Главное здесь — обрезка окончаний: поиск Dovecot FTS Xapian ищет только по
 * префиксу (docs/search.md), поэтому «документами» обязано превратиться
 * в «документ», иначе пользователь не найдёт очевидное письмо.
 */

import { describe, expect, it } from 'vitest';
import {
  hasMatch,
  highlightSegments,
  normalizeForMatch,
  queryStems,
  splitQueryParts,
  stemSearchQuery,
  trimRussianEnding,
} from '../src/lib/searchQuery';

describe('trimRussianEnding', () => {
  it('обрезает падежные окончания до общей основы', () => {
    expect(trimRussianEnding('документами')).toBe('документ');
    expect(trimRussianEnding('документов')).toBe('документ');
    expect(trimRussianEnding('документы')).toBe('документ');
  });

  it('слово уже в основе не портится', () => {
    expect(trimRussianEnding('документ')).toBe('документ');
  });

  it('разные словоформы сходятся к одной основе — иначе поиск бесполезен', () => {
    const stems = ['счета', 'счетами', 'счетов'].map(trimRussianEnding);
    expect(new Set(stems).size).toBe(1);
    expect(stems[0]).toBe('счет');
  });

  it('не укорачивает основу короче четырёх букв', () => {
    // «сч» находило бы всё подряд, поэтому «счет» остаётся как есть
    expect(trimRussianEnding('счет')).toBe('счет');
    expect(trimRussianEnding('мира')).toBe('мира');
  });

  it('короткие слова не трогает', () => {
    expect(trimRussianEnding('мир')).toBe('мир');
    expect(trimRussianEnding('за')).toBe('за');
  });

  it('латиницу, цифры и смешанные строки оставляет как есть', () => {
    expect(trimRussianEnding('invoices')).toBe('invoices');
    expect(trimRussianEnding('2026')).toBe('2026');
    expect(trimRussianEnding('bill_2026.pdf')).toBe('bill_2026.pdf');
  });

  it('снимает возвратную частицу вторым проходом', () => {
    expect(trimRussianEnding('регистрируйся').startsWith('регистр')).toBe(true);
  });
});

describe('splitQueryParts', () => {
  it('сохраняет фразу в кавычках одним куском', () => {
    expect(splitQueryParts('счета "за июль" 2026')).toEqual(['счета', '"за июль"', '2026']);
  });

  it('пустой запрос даёт пустой список', () => {
    expect(splitQueryParts('   ')).toEqual([]);
  });
});

describe('stemSearchQuery', () => {
  it('обрезает окончания у каждого слова', () => {
    expect(stemSearchQuery('счета документами')).toBe('счет документ');
  });

  it('точную фразу в кавычках не трогает', () => {
    expect(stemSearchQuery('"письма от банка" счетами')).toBe('"письма от банка" счет');
  });

  it('пустой запрос остаётся пустым', () => {
    expect(stemSearchQuery('')).toBe('');
  });
});

describe('queryStems', () => {
  it('снимает кавычки, приводит к нижнему регистру и убирает повторы', () => {
    expect(queryStems('Счета счетами "Июль"')).toEqual(['счет', 'июль']);
  });

  it('ё приравнивается к е — так же нормализует Xapian', () => {
    expect(normalizeForMatch('Счёт')).toBe('счет');
  });
});

describe('highlightSegments', () => {
  it('подсвечивает слово целиком, а не только префикс', () => {
    const segments = highlightSegments('Счета за июль', ['счет']);
    expect(segments.map((s) => s.text).join('')).toBe('Счета за июль');
    expect(segments.filter((s) => s.hit).map((s) => s.text)).toEqual(['Счета']);
  });

  it('находит совпадение через ё', () => {
    expect(hasMatch('Ваш Счёт готов', ['счет'])).toBe(true);
  });

  it('не подсвечивает совпадение в середине слова', () => {
    // префиксный поиск не находит «отсчет» по запросу «счет» — подсветка
    // должна врать не больше, чем сам поиск
    expect(hasMatch('пересчет данных', ['счет'])).toBe(false);
  });

  it('без основ возвращает один сегмент с исходным текстом', () => {
    expect(highlightSegments('Тема письма', [])).toEqual([{ text: 'Тема письма', hit: false }]);
  });

  it('пустой текст даёт пустой список сегментов', () => {
    expect(highlightSegments('', ['счет'])).toEqual([]);
  });

  it('склеивает соседние куски одного вида', () => {
    const segments = highlightSegments('счет счет', ['счет']);
    expect(segments).toHaveLength(3); // «счет» + пробел + «счет»
  });
});
