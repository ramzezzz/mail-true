/** Форматирование и разбор значений в интерфейсе админки. */
import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDateTime,
  formatRelative,
  parseBytes,
  plural,
  pluralize,
} from '../src/lib/format';

describe('formatBytes', () => {
  it('переводит байты в понятные единицы', () => {
    expect(formatBytes(1024 ** 3)).toBe('1 ГБ');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 МБ');
    expect(formatBytes(1536)).toBe('1,5 КБ');
    expect(formatBytes(999)).toBe('999 Б');
  });

  it('ноль означает «без ограничения»', () => {
    expect(formatBytes(0)).toBe('без ограничения');
    expect(formatBytes(0, '0 Б')).toBe('0 Б');
  });

  it('не падает на мусоре', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-5)).toBe('—');
  });
});

describe('parseBytes', () => {
  it('понимает человеческие обозначения', () => {
    expect(parseBytes('1G')).toBe(1024 ** 3);
    expect(parseBytes('1 ГБ')).toBe(1024 ** 3);
    expect(parseBytes('500M')).toBe(500 * 1024 ** 2);
    expect(parseBytes('2,5 гб')).toBe(Math.round(2.5 * 1024 ** 3));
    expect(parseBytes('1073741824')).toBe(1073741824);
    expect(parseBytes('0')).toBe(0);
  });

  it('возвращает null на непонятном', () => {
    expect(parseBytes('')).toBeNull();
    expect(parseBytes('много')).toBeNull();
    expect(parseBytes('-1G')).toBeNull();
    expect(parseBytes('1 попугай')).toBeNull();
  });

  it('обратим с formatBytes для круглых значений', () => {
    for (const bytes of [1024, 1024 ** 2, 1024 ** 3, 5 * 1024 ** 3]) {
      expect(parseBytes(formatBytes(bytes))).toBe(bytes);
    }
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');

  it('показывает свежие события словами', () => {
    expect(formatRelative('2026-08-05T11:59:40Z', now)).toBe('только что');
    expect(formatRelative('2026-08-05T11:55:00Z', now)).toBe('5 мин назад');
    expect(formatRelative('2026-08-05T09:00:00Z', now)).toBe('3 ч назад');
    expect(formatRelative('2026-08-04T09:00:00Z', now)).toBe('вчера');
    expect(formatRelative('2026-08-01T12:00:00Z', now)).toBe('4 дн назад');
  });

  it('пустое значение — «никогда»', () => {
    expect(formatRelative(null, now)).toBe('никогда');
    expect(formatRelative(undefined, now)).toBe('никогда');
  });

  it('мусор не ломает вывод', () => {
    expect(formatRelative('не-дата', now)).toBe('—');
    expect(formatDateTime('не-дата')).toBe('—');
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('склонение', () => {
  it('выбирает правильную форму', () => {
    expect(plural(1, 'ящик', 'ящика', 'ящиков')).toBe('ящик');
    expect(plural(2, 'ящик', 'ящика', 'ящиков')).toBe('ящика');
    expect(plural(5, 'ящик', 'ящика', 'ящиков')).toBe('ящиков');
    expect(plural(11, 'ящик', 'ящика', 'ящиков')).toBe('ящиков');
    expect(plural(21, 'ящик', 'ящика', 'ящиков')).toBe('ящик');
    expect(plural(0, 'ящик', 'ящика', 'ящиков')).toBe('ящиков');
  });

  it('pluralize добавляет число', () => {
    expect(pluralize(3, 'ящик', 'ящика', 'ящиков')).toBe('3 ящика');
  });
});
