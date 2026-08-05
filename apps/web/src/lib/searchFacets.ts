/**
 * Фасетные фильтры поиска: признаки письма, папки со счётчиками совпадений
 * и разбивка по периодам — левая колонка страницы поиска (см. скриншот
 * research/mailru/09-search.png).
 *
 * ВРЕМЕННОЕ РЕШЕНИЕ. У mail.ru счётчики приходят с сервера: движок отдаёт
 * агрегаты по всему совпадению, а не только по показанной странице.
 * У нас маршрута агрегатов нет (см. docs/search.md — «Отдельного фасетного
 * API у Dovecot нет, считается на стороне API»), поэтому счётчики считаются
 * здесь, по уже загруженным результатам. Как только появится
 * `GET /api/search/aggregates`, эти функции заменяются одним запросом,
 * а разбор ответа остаётся тем же — форма `SearchAggregates` не изменится.
 */

import type { Folder, MessageSummary } from '@mail-true/shared';
import { folderTitle } from './folderNames';

/** Признаки письма — те же, что в меню «Фильтр» над списком. */
export type SearchFlagFacet = 'unread' | 'flagged' | 'attachments';

export const FLAG_FACET_TITLES: Record<SearchFlagFacet, string> = {
  unread: 'Непрочитанные',
  flagged: 'С флагом',
  attachments: 'С вложениями',
};

export interface FacetCount {
  /** Значение для адресной строки: id папки или ключ периода. */
  id: string;
  label: string;
  count: number;
}

export interface SearchAggregates {
  total: number;
  /** Счётчики признаков: непрочитанные, с флагом, с вложениями. */
  flags: Record<SearchFlagFacet, number>;
  /** Папки, в которых есть совпадения, в порядке списка папок. */
  folders: FacetCount[];
  /** Периоды: «За этот месяц», помесячно за текущий год, затем по годам. */
  periods: FacetCount[];
}

const MONTHS_NOMINATIVE = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

export interface PeriodBucket {
  id: string;
  label: string;
}

/**
 * Ключ и подпись периода для фасета:
 *   текущий месяц       → `month:2026-08`, «За этот месяц»
 *   месяц этого года    → `month:2026-07`, «Июль»
 *   прошлые годы        → `year:2020`,     «За 2020»
 */
export function periodBucket(iso: string, now: Date = new Date()): PeriodBucket {
  const date = new Date(iso);
  const year = date.getFullYear();
  if (year !== now.getFullYear()) {
    return { id: `year:${year}`, label: `За ${year}` };
  }
  const month = date.getMonth();
  const id = `month:${year}-${String(month + 1).padStart(2, '0')}`;
  if (month === now.getMonth()) return { id, label: 'За этот месяц' };
  return { id, label: MONTHS_NOMINATIVE[month] ?? id };
}

/**
 * Порядок периодов в колонке: сначала текущий месяц, затем месяцы текущего
 * года по убыванию, затем годы по убыванию. Сортировка идёт по ключу, а не
 * по подписи, — подписи месяцев не сравнимы лексикографически.
 */
function comparePeriods(a: string, b: string): number {
  const [aKind, aValue = ''] = a.split(':');
  const [bKind, bValue = ''] = b.split(':');
  if (aKind !== bKind) return aKind === 'month' ? -1 : 1;
  return bValue.localeCompare(aValue);
}

/** Проходит ли письмо под выбранный признак. */
export function matchesFlagFacet(message: MessageSummary, facet: SearchFlagFacet): boolean {
  switch (facet) {
    case 'unread':
      return !message.flags.seen;
    case 'flagged':
      return message.flags.flagged;
    case 'attachments':
      return message.hasAttachments;
  }
}

export interface SearchFacetSelection {
  /** Выбранные признаки письма (пересечение: и непрочитанное, и с флагом). */
  flags: readonly SearchFlagFacet[];
  /** id выбранной папки или null — все папки. */
  folderId: string | null;
  /** Ключ выбранного периода (`month:2026-07`) или null — за всё время. */
  period: string | null;
}

export const EMPTY_SELECTION: SearchFacetSelection = { flags: [], folderId: null, period: null };

/** Отбор писем по выбранным фасетам. */
export function applyFacets(
  messages: readonly MessageSummary[],
  selection: SearchFacetSelection,
  now: Date = new Date(),
): MessageSummary[] {
  return messages.filter((m) => {
    if (!selection.flags.every((f) => matchesFlagFacet(m, f))) return false;
    if (selection.folderId !== null && m.folderId !== selection.folderId) return false;
    if (selection.period !== null && periodBucket(m.date, now).id !== selection.period) return false;
    return true;
  });
}

/**
 * Счётчики для всех трёх групп фасетов.
 *
 * Считаются по полному набору совпадений, БЕЗ учёта уже выбранных фасетов:
 * иначе, выбрав папку, пользователь увидел бы нули у всех остальных и не смог
 * бы переключиться. Так же ведёт себя mail.ru.
 *
 * @param folders — список папок; задаёт порядок и русские названия.
 */
export function computeAggregates(
  messages: readonly MessageSummary[],
  folders: readonly Folder[],
  now: Date = new Date(),
): SearchAggregates {
  const flags: Record<SearchFlagFacet, number> = { unread: 0, flagged: 0, attachments: 0 };
  const byFolder = new Map<string, number>();
  const byPeriod = new Map<string, { label: string; count: number }>();

  for (const message of messages) {
    if (matchesFlagFacet(message, 'unread')) flags.unread += 1;
    if (matchesFlagFacet(message, 'flagged')) flags.flagged += 1;
    if (matchesFlagFacet(message, 'attachments')) flags.attachments += 1;

    byFolder.set(message.folderId, (byFolder.get(message.folderId) ?? 0) + 1);

    const bucket = periodBucket(message.date, now);
    const period = byPeriod.get(bucket.id);
    if (period) period.count += 1;
    else byPeriod.set(bucket.id, { label: bucket.label, count: 1 });
  }

  // Папки — в порядке левого меню; папки без совпадений не показываем.
  const known = new Set(folders.map((f) => f.id));
  const folderCounts: FacetCount[] = folders
    .filter((f) => (byFolder.get(f.id) ?? 0) > 0)
    .map((f) => ({ id: f.id, label: folderTitle(f), count: byFolder.get(f.id) ?? 0 }));

  // Письма из папок, которых нет в списке (например, пришли из поиска по
  // спаму, когда сам список папок ещё не догрузился), не теряем.
  for (const [id, count] of byFolder) {
    if (!known.has(id)) folderCounts.push({ id, label: id, count });
  }

  const periods: FacetCount[] = [...byPeriod.entries()]
    .map(([id, { label, count }]) => ({ id, label, count }))
    .sort((a, b) => comparePeriods(a.id, b.id));

  return { total: messages.length, flags, folders: folderCounts, periods };
}
