/** Тесты логики скругления группы выделенных строк (радиус 12px). */

import { describe, expect, it } from 'vitest';
import { rowSelectionStates } from '../src/lib/selection';

describe('rowSelectionStates', () => {
  it('одиночная выбранная строка скругляется и сверху, и снизу', () => {
    const map = rowSelectionStates(['a', 'b', 'c'], new Set(['b']));
    expect(map.get('b')).toEqual({ selected: true, firstSelected: true, lastSelected: true });
    expect(map.get('a')).toEqual({ selected: false, firstSelected: false, lastSelected: false });
  });

  it('в группе подряд первая скругляется сверху, последняя — снизу', () => {
    const map = rowSelectionStates(['a', 'b', 'c', 'd'], new Set(['a', 'b', 'c']));
    expect(map.get('a')).toEqual({ selected: true, firstSelected: true, lastSelected: false });
    expect(map.get('b')).toEqual({ selected: true, firstSelected: false, lastSelected: false });
    expect(map.get('c')).toEqual({ selected: true, firstSelected: false, lastSelected: true });
  });

  it('разрывы выделения дают несколько независимых групп', () => {
    const map = rowSelectionStates(['a', 'b', 'c', 'd', 'e'], new Set(['a', 'b', 'd']));
    expect(map.get('b')?.lastSelected).toBe(true);
    expect(map.get('d')).toEqual({ selected: true, firstSelected: true, lastSelected: true });
  });

  it('заголовок периода (null) разрывает группу', () => {
    const map = rowSelectionStates(['a', null, 'b'], new Set(['a', 'b']));
    expect(map.get('a')).toEqual({ selected: true, firstSelected: true, lastSelected: true });
    expect(map.get('b')).toEqual({ selected: true, firstSelected: true, lastSelected: true });
  });

  it('крайние строки списка считаются границами группы', () => {
    const map = rowSelectionStates(['a', 'b'], new Set(['a', 'b']));
    expect(map.get('a')?.firstSelected).toBe(true);
    expect(map.get('b')?.lastSelected).toBe(true);
  });
});
