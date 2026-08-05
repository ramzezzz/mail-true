/** Тесты форматирования дат и группировки списка по периодам. */

import { describe, expect, it } from 'vitest';
import {
  calendarDaysAgo,
  formatListDate,
  formatMessageDate,
  groupMessagesByPeriod,
  periodLabel,
} from '../src/lib/listDates';

// Фиксированное «сейчас»: среда 5 августа 2026, 14:00 локального времени
const NOW = new Date(2026, 7, 5, 14, 0, 0);

function iso(y: number, m: number, d: number, h = 12, min = 0): string {
  return new Date(y, m, d, h, min).toISOString();
}

describe('calendarDaysAgo', () => {
  it('считает календарные дни, а не 24-часовые интервалы', () => {
    // 23:59 вчера — это «1 день назад», хотя прошло меньше суток
    expect(calendarDaysAgo(iso(2026, 7, 4, 23, 59), NOW)).toBe(1);
    expect(calendarDaysAgo(iso(2026, 7, 5, 0, 1), NOW)).toBe(0);
  });
});

describe('formatListDate', () => {
  it('сегодня — только время', () => {
    expect(formatListDate(iso(2026, 7, 5, 9, 5), NOW)).toBe('09:05');
  });

  it('в этом году — день и месяц без точки', () => {
    const s = formatListDate(iso(2026, 6, 12), NOW);
    expect(s).toMatch(/^12 июл/);
    expect(s).not.toContain('2026');
    expect(s).not.toContain('.');
  });

  it('в прошлом году — с годом', () => {
    expect(formatListDate(iso(2025, 6, 12), NOW)).toContain('2025');
  });
});

describe('formatMessageDate', () => {
  it('«Сегодня, ЧЧ:ММ» и «Вчера, ЧЧ:ММ»', () => {
    expect(formatMessageDate(iso(2026, 7, 5, 4, 38), NOW)).toBe('Сегодня, 4:38');
    expect(formatMessageDate(iso(2026, 7, 4, 22, 15), NOW)).toBe('Вчера, 22:15');
  });

  it('старые письма — «5 августа, 14:20»', () => {
    expect(formatMessageDate(iso(2026, 6, 20, 14, 20), NOW)).toBe('20 июля, 14:20');
  });
});

describe('periodLabel', () => {
  it('сегодня / вчера / неделя', () => {
    expect(periodLabel(iso(2026, 7, 5, 1), NOW)).toBe('Сегодня');
    expect(periodLabel(iso(2026, 7, 4), NOW)).toBe('Вчера');
    expect(periodLabel(iso(2026, 7, 2), NOW)).toBe('Неделя');
    expect(periodLabel(iso(2026, 6, 30), NOW)).toBe('Неделя');
  });

  it('старше недели — «Месяц Год» с большой буквы', () => {
    expect(periodLabel(iso(2026, 6, 15), NOW)).toBe('Июль 2026');
    expect(periodLabel(iso(2025, 11, 31), NOW)).toBe('Декабрь 2025');
  });
});

describe('groupMessagesByPeriod', () => {
  it('группирует, сохраняя порядок, без пустых групп', () => {
    const items = [
      { id: 'a', date: iso(2026, 7, 5, 10) }, // Сегодня
      { id: 'b', date: iso(2026, 7, 5, 9) }, // Сегодня
      { id: 'c', date: iso(2026, 7, 4) }, // Вчера
      { id: 'd', date: iso(2026, 7, 1) }, // Неделя
      { id: 'e', date: iso(2026, 6, 10) }, // Июль 2026
    ];
    const groups = groupMessagesByPeriod(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Сегодня', 'Вчера', 'Неделя', 'Июль 2026']);
    expect(groups[0].items.map((m) => m.id)).toEqual(['a', 'b']);
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });

  it('пустой список — пустой результат', () => {
    expect(groupMessagesByPeriod([], NOW)).toEqual([]);
  });
});

describe('formatListDate: сокращение месяца не теряет букв', () => {
  const now = new Date(2026, 7, 20, 12, 0, 0);

  it('август не превращается в «ав»', () => {
    // Правило удаления суффикса года «г» раньше срабатывало на последней букве
    // «авг», потому что точки к тому моменту уже были убраны.
    expect(formatListDate(new Date(2026, 7, 4, 9, 0).toISOString(), now)).toBe('4 авг');
  });

  it('прочие месяцы не задеты', () => {
    expect(formatListDate(new Date(2026, 6, 31, 9, 0).toISOString(), now)).toBe('31 июл');
    expect(formatListDate(new Date(2026, 8, 2, 9, 0).toISOString(), now)).toBe('2 сент');
    expect(formatListDate(new Date(2026, 0, 9, 9, 0).toISOString(), now)).toBe('9 янв');
  });

  it('у прошлых лет суффикс года всё ещё убирается', () => {
    expect(formatListDate(new Date(2024, 7, 4, 9, 0).toISOString(), now)).toBe('4 авг 2024');
  });
});
