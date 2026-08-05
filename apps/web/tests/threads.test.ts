/**
 * Тесты раскладки цепочки переписки: какие строки скругляются
 * и кто из них сосед раскрытого письма.
 */

import { describe, expect, it } from 'vitest';
import { COLLAPSED_ROW_HEIGHT, threadRowStates } from '../src/lib/threads';

describe('threadRowStates', () => {
  it('свёрнутая строка той же высоты, что строка списка', () => {
    expect(COLLAPSED_ROW_HEIGHT).toBe(48);
  });

  it('помечает первое и последнее письмо цепочки', () => {
    const states = threadRowStates(['a', 'b', 'c'], new Set());
    expect(states.map((s) => s.first)).toEqual([true, false, false]);
    expect(states.map((s) => s.last)).toEqual([false, false, true]);
  });

  it('соседи раскрытого письма знают об этом — по ним идут скругления', () => {
    const states = threadRowStates(['a', 'b', 'c'], new Set(['b']));
    expect(states[0]).toMatchObject({ expanded: false, expandedNext: true, expandedPrev: false });
    expect(states[1]).toMatchObject({ expanded: true });
    expect(states[2]).toMatchObject({ expanded: false, expandedPrev: true, expandedNext: false });
  });

  it('раскрытых писем может быть несколько', () => {
    const states = threadRowStates(['a', 'b', 'c'], new Set(['a', 'c']));
    expect(states.filter((s) => s.expanded).map((s) => s.id)).toEqual(['a', 'c']);
    expect(states[1]).toMatchObject({ expandedPrev: true, expandedNext: true });
  });

  it('цепочка из одного письма — оно и первое, и последнее', () => {
    expect(threadRowStates(['a'], new Set(['a']))[0]).toEqual({
      id: 'a',
      expanded: true,
      first: true,
      last: true,
      expandedPrev: false,
      expandedNext: false,
    });
  });

  it('пустая цепочка не ломается', () => {
    expect(threadRowStates([], new Set())).toEqual([]);
  });
});
