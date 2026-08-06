/**
 * Возврат из письма в список: то же место и то же письмо.
 *
 * Дефект: человек листал папку, открывал письмо в середине, возвращался —
 * и оказывался в начале списка. При просмотре нескольких писем подряд это
 * значит, что место в списке приходится искать заново после каждого письма.
 *
 * Считать положение «вслепую по пикселю» нельзя: список виртуализирован,
 * высота строки разная на телефоне и в компактном режиме, а на момент
 * возврата большая часть строк ещё не отрисована. Поэтому здесь всё
 * считается по САМИМ строкам — их состав и высоты известны до отрисовки, —
 * а функции чистые и проверяются без браузера.
 */

import type { ListRow } from '../mail/MessageList';

export interface RowMetrics {
  /** Высота строки письма (зависит от плотности и ширины экрана). */
  rowHeight: number;
  /** Высота заголовка периода («Сегодня», «Вчера»). */
  headerHeight: number;
}

/** Отступ строки с этим номером от начала списка, px. */
export function rowOffsetTop(
  rows: readonly ListRow[],
  index: number,
  { rowHeight, headerHeight }: RowMetrics,
): number {
  let offset = 0;
  for (let i = 0; i < index && i < rows.length; i += 1) {
    offset += rows[i]?.type === 'header' ? headerHeight : rowHeight;
  }
  return offset;
}

/** Номер строки письма в плоском списке или -1. */
export function rowIndexOf(rows: readonly ListRow[], messageId: string | null | undefined): number {
  if (!messageId) return -1;
  return rows.findIndex((r) => r.type === 'message' && r.message.id === messageId);
}

export interface RestoreArgs {
  /** Прокрутка, запомненная при уходе из списка. */
  savedTop: number | undefined;
  /** Номер письма, из которого вернулись, или -1. */
  highlightIndex: number;
  rows: readonly ListRow[];
  metrics: RowMetrics;
  /** Высота видимой части списка. */
  viewportHeight: number;
}

/**
 * Куда поставить прокрутку при возврате в список.
 *
 * Правил два, и второе важнее первого:
 *  1. по умолчанию — туда же, где человек был;
 *  2. но если письмо, из которого он вернулся, в это окно не попадает,
 *     список доводится до него. Так бывает после переходов стрелками
 *     «предыдущее/следующее» внутри просмотра: ушёл с двадцатого письма,
 *     вернулся с двадцать четвёртого — ждёшь увидеть последнее прочитанное,
 *     а не то, с которого начал.
 *
 * `null` — восстанавливать нечего (в список пришли впервые).
 */
export function restoreScrollTop({
  savedTop,
  highlightIndex,
  rows,
  metrics,
  viewportHeight,
}: RestoreArgs): number | null {
  const known = savedTop !== undefined && savedTop > 0;
  if (!known && highlightIndex < 0) return null;

  const top = known ? savedTop : 0;
  if (highlightIndex < 0) return top;

  const rowTop = rowOffsetTop(rows, highlightIndex, metrics);
  const rowBottom = rowTop + metrics.rowHeight;
  // Строка целиком в окне — ничего не двигаем: человек вернулся ровно туда,
  // откуда ушёл, и подпрыгивать списку незачем.
  if (rowTop >= top && rowBottom <= top + viewportHeight) return top;

  // Иначе ставим строку по центру: у краёв окна её легко не заметить.
  return Math.max(0, Math.round(rowTop - viewportHeight / 2 + metrics.rowHeight / 2));
}
