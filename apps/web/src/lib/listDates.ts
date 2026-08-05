/**
 * Даты в списке писем и группировка по периодам — как у mail.ru:
 * «Сегодня» / «Вчера» / «Неделя» / «Июль 2026». Все функции принимают
 * необязательное `now`, чтобы быть детерминированными в тестах.
 */

const MS_PER_DAY = 24 * 3600 * 1000;

/** Полночь календарного дня даты. */
export function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Разница в календарных днях: 0 — сегодня, 1 — вчера… (отрицательное — будущее). */
export function calendarDaysAgo(iso: string, now: Date = new Date()): number {
  return Math.round((startOfDay(now).getTime() - startOfDay(new Date(iso)).getTime()) / MS_PER_DAY);
}

/** «12:34» сегодня, «5 авг» в этом году, «5 авг 2025» раньше. */
export function formatListDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date
    .toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: sameYear ? undefined : 'numeric',
    })
    .replace(/\./g, '')
    // Пробел перед «г» обязателен. Иначе, после удаления точек, это правило
    // съедало последнюю букву в «авг» и август показывался как «4 ав» —
    // единственный месяц, чьё сокращение оканчивается на «г».
    .replace(/\s+г$/, '');
}

/** «Сегодня, 4:38» / «Вчера, 22:15» / «5 августа, 14:20» / «5 августа 2025, 14:20». */
export function formatMessageDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('ru-RU', { hour: 'numeric', minute: '2-digit' });
  const days = calendarDaysAgo(iso, now);
  if (days === 0) return `Сегодня, ${time}`;
  if (days === 1) return `Вчера, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
  });
  return `${day.replace(/\s*г\.$/, '')}, ${time}`;
}

/**
 * Заголовок периода для группировки списка:
 * сегодня → «Сегодня», вчера → «Вчера», 2–6 дней назад → «Неделя»,
 * старше → «Июль 2026» (месяц с большой буквы + год).
 */
export function periodLabel(iso: string, now: Date = new Date()): string {
  const days = calendarDaysAgo(iso, now);
  if (days <= 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  if (days < 7) return 'Неделя';
  const date = new Date(iso);
  const month = date.toLocaleDateString('ru-RU', { month: 'long' });
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${date.getFullYear()}`;
}

export interface PeriodGroup<T> {
  label: string;
  items: T[];
}

/**
 * Группирует отсортированный по дате (новые первыми) список по периодам,
 * сохраняя порядок. Пустых групп не бывает.
 */
export function groupMessagesByPeriod<T extends { date: string }>(
  items: readonly T[],
  now: Date = new Date(),
): PeriodGroup<T>[] {
  const groups: PeriodGroup<T>[] = [];
  for (const item of items) {
    const label = periodLabel(item.date, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
