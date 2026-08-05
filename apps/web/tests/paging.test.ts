/**
 * Постраничная подгрузка списка писем.
 *
 * Числа взяты с живого ящика: `GET /api/messages?folderId=inbox&limit=100`
 * отвечает `total: 187` при сотне писем на странице. Раньше интерфейс просил
 * одну страницу с `offset: 0`, `total` не использовал и подгрузки не имел —
 * восемьдесят семь писем были недостижимы вовсе.
 */

import { describe, expect, it } from 'vitest';
import {
  hasMore,
  loadedCount,
  nextPageOffset,
  selectAllLabel,
  totalCount,
} from '../src/lib/paging';

/** Страница ответа: n писем при total из живого ящика. */
const page = (offset: number, count: number, total = 187) => ({
  items: Array.from({ length: count }, (_, i) => `inbox:${offset + i}`),
  total,
  offset,
  limit: 100,
});

describe('nextPageOffset', () => {
  it('первый запрос — с нулевого смещения', () => {
    expect(nextPageOffset([])).toBe(0);
  });

  it('после первой сотни из 187 просит следующую с offset 100', () => {
    expect(nextPageOffset([page(0, 100)])).toBe(100);
  });

  it('когда всё загружено — больше не просит', () => {
    expect(nextPageOffset([page(0, 100), page(100, 87)])).toBeUndefined();
  });

  it('пустая страница останавливает подгрузку, а не крутит её вечно', () => {
    expect(nextPageOffset([page(0, 100), page(100, 0)])).toBeUndefined();
  });

  it('смещение считается по полученным письмам, а не по номеру страницы', () => {
    // сервер вправе отдать меньше, чем просили
    expect(nextPageOffset([page(0, 60)])).toBe(60);
  });
});

describe('счётчики страниц', () => {
  it('loadedCount складывает письма всех страниц', () => {
    expect(loadedCount([page(0, 100), page(100, 87)])).toBe(187);
  });

  it('totalCount берётся из ответа сервера', () => {
    expect(totalCount([page(0, 100)])).toBe(187);
    expect(totalCount([])).toBe(0);
  });

  it('hasMore честно отвечает, осталось ли что грузить', () => {
    expect(hasMore([page(0, 100)])).toBe(true);
    expect(hasMore([page(0, 100), page(100, 87)])).toBe(false);
  });
});

describe('selectAllLabel', () => {
  it('пока загружено не всё — говорит правду про число писем', () => {
    // Раньше кнопка обещала «Выделить все», а выделяла загруженную сотню
    expect(selectAllLabel(100, 187)).toBe('Выделить загруженные (100 из 187)');
  });

  it('когда загружено всё — обычное «Выделить все»', () => {
    expect(selectAllLabel(187, 187)).toBe('Выделить все');
    expect(selectAllLabel(12, 12)).toBe('Выделить все');
    expect(selectAllLabel(0, 0)).toBe('Выделить все');
  });
});
