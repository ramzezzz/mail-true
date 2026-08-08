/**
 * Логика скругления группы выделенных строк — как в привычных почтовых интерфейсах:
 * подряд идущие выбранные письма выглядят одной карточкой с радиусом 12px,
 * первая строка группы скругляется сверху, последняя — снизу.
 * Заголовки периодов разрывают группу.
 */

export interface RowSelectionState {
  selected: boolean;
  /** Первая строка непрерывной группы выделения — скругление сверху. */
  firstSelected: boolean;
  /** Последняя строка группы — скругление снизу. */
  lastSelected: boolean;
}

/**
 * @param rows — идентификаторы строк в порядке отображения;
 *               `null` — разрыв (заголовок периода между строками).
 * @param selected — множество выделенных id.
 */
export function rowSelectionStates(
  rows: readonly (string | null)[],
  selected: ReadonlySet<string>,
): Map<string, RowSelectionState> {
  const result = new Map<string, RowSelectionState>();
  for (let i = 0; i < rows.length; i += 1) {
    const id = rows[i];
    if (id == null) continue;
    const isSelected = selected.has(id);
    if (!isSelected) {
      result.set(id, { selected: false, firstSelected: false, lastSelected: false });
      continue;
    }
    const prev = rows[i - 1];
    const next = rows[i + 1];
    result.set(id, {
      selected: true,
      firstSelected: prev == null || !selected.has(prev),
      lastSelected: next == null || !selected.has(next),
    });
  }
  return result;
}
