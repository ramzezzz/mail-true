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

/** «Июль 2026» — месяц с большой буквы и год. */
function monthYearLabel(date: Date): string {
  const month = date.toLocaleDateString('ru-RU', { month: 'long' });
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${date.getFullYear()}`;
}

/**
 * Заголовок периода для группировки списка:
 * сегодня → «Сегодня», вчера → «Вчера», 2–6 дней назад → «Неделя»,
 * старше → «Июль 2026» (месяц с большой буквы + год).
 *
 * Даты из будущего попадают в свой месяц («Январь 2099»), а не в «Сегодня».
 * Раньше сюда сваливалось всё, у чего разница в днях меньше или равна нулю:
 * письмо с датой 1 января 2099 стояло под заголовком «Сегодня», хотя в самой
 * строке было написано «1 янв 2099». Дата в письме — то, что написал
 * отправитель, и врать про неё нельзя: сломанные часы и подделанный `Date:`
 * встречаются в настоящей почте постоянно.
 */
export function periodLabel(iso: string, now: Date = new Date()): string {
  const days = calendarDaysAgo(iso, now);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  if (days > 1 && days < 7) return 'Неделя';
  return monthYearLabel(new Date(iso));
}

export interface PeriodGroup<T> {
  label: string;
  items: T[];
}

/**
 * Группирует список по периодам. Пустых групп не бывает, и — главное —
 * заголовок не повторяется: каждый период встречается ровно один раз.
 *
 * Список приходит отсортированным по приходу писем, а не по дате внутри них,
 * и это правильный для почты порядок: пересланное или перенесённое письмо
 * встаёт в конец папки со своей старой датой. Прежняя версия просто резала
 * последовательность на куски по смене заголовка и на таком списке выдавала
 * «Август 2025», потом «Сегодня», потом «Январь 1899», а потом снова
 * «Сегодня» — четыре заголовка, два из которых одинаковые.
 *
 * Поэтому письма раскладываются по периодам, а не режутся: период попадает
 * в список там, где встретилось его первое письмо, а внутри периода письма
 * идут в том же порядке, в каком пришли. Ни одно письмо не оказывается под
 * чужим заголовком, и ни один заголовок не появляется дважды.
 */
export function groupMessagesByPeriod<T extends { date: string }>(
  items: readonly T[],
  now: Date = new Date(),
): PeriodGroup<T>[] {
  const groups: PeriodGroup<T>[] = [];
  const byLabel = new Map<string, PeriodGroup<T>>();
  for (const item of items) {
    const label = periodLabel(item.date, now);
    let group = byLabel.get(label);
    if (!group) {
      group = { label, items: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
