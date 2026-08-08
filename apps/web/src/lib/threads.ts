/**
 * Раскладка цепочки переписки — классы-модификаторы письма в цепочке
 * (docs/features-reference.md, раздел «Цепочки переписки»):
 *
 *   thread__letter_expanded        раскрытое письмо
 *   thread__letter_collapsed       свёрнутая строка 48px
 *   thread__letter_first / _last   первое и последнее в цепочке
 *   thread__letter_expanded-prev   сосед сверху от раскрытого
 *   thread__letter_expanded-next   сосед снизу от раскрытого
 *
 * Соседи раскрытого письма помечены не ради красоты: по краям раскрытого
 * блока цепочка скругляется, и знать об этом должна соседняя строка,
 * а не сама карточка.
 */

/** Высота свёрнутой строки цепочки — та же, что у строки списка. */
export const COLLAPSED_ROW_HEIGHT = 48;

export interface ThreadRowState {
  id: string;
  expanded: boolean;
  first: boolean;
  last: boolean;
  /** Следующее письмо раскрыто — низ этой строки скруглять не надо. */
  expandedNext: boolean;
  /** Предыдущее письмо раскрыто — не надо скруглять верх. */
  expandedPrev: boolean;
}

/**
 * Состояние каждой строки цепочки.
 *
 * @param ids — письма цепочки в порядке показа (старые сверху, как в привычных почтовых интерфейсах).
 * @param expandedIds — раскрытые письма; их может быть несколько, если
 *   пользователь развернул ещё одно, не сворачивая первое.
 */
export function threadRowStates(
  ids: readonly string[],
  expandedIds: ReadonlySet<string>,
): ThreadRowState[] {
  return ids.map((id, index) => {
    const prev = ids[index - 1];
    const next = ids[index + 1];
    return {
      id,
      expanded: expandedIds.has(id),
      first: index === 0,
      last: index === ids.length - 1,
      expandedPrev: prev !== undefined && expandedIds.has(prev),
      expandedNext: next !== undefined && expandedIds.has(next),
    };
  });
}
