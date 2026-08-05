/**
 * Тесты адреса страницы поиска: состояние поиска целиком лежит в адресной
 * строке, поэтому разбор и сборка обязаны быть обратными друг другу —
 * иначе «назад» в браузере покажет не то, что было.
 */

import { describe, expect, it } from 'vitest';
import type { Folder } from '@mail-true/shared';
import {
  SEARCH_PATH,
  buildSearchUrl,
  parseSearchParams,
  searchTargets,
  searchUrlFor,
  toggleFlagFacet,
  toggleFolderFacet,
  togglePeriodFacet,
  type SearchState,
} from '../src/search/searchParams';

function parse(query: string): SearchState {
  return parseSearchParams(new URLSearchParams(query));
}

describe('parseSearchParams', () => {
  it('пустой адрес — пустой запрос, поиск везде, спам исключён', () => {
    expect(parse('')).toEqual({
      query: '',
      scope: { kind: 'all' },
      includeJunk: false,
      facets: { flags: [], folderId: null, period: null },
    });
  });

  it('читает запрос из q_query — как у mail.ru', () => {
    expect(parse('q_query=%D1%81%D1%87%D0%B5%D1%82').query).toBe('счет');
  });

  it('область поиска: scope=all равнозначен отсутствию параметра', () => {
    expect(parse('scope=all').scope).toEqual({ kind: 'all' });
    expect(parse('scope=inbox').scope).toEqual({ kind: 'folder', folderId: 'inbox' });
  });

  it('признаки, папка и период разбираются вместе', () => {
    const state = parse('unread=1&attachments=1&folder=inbox&period=month%3A2026-07&junk=1');
    expect(state.facets.flags).toEqual(['unread', 'attachments']);
    expect(state.facets.folderId).toBe('inbox');
    expect(state.facets.period).toBe('month:2026-07');
    expect(state.includeJunk).toBe(true);
  });
});

describe('buildSearchUrl', () => {
  it('простой поиск даёт короткую ссылку без служебных параметров', () => {
    expect(searchUrlFor('счет')).toBe(`${SEARCH_PATH}?q_query=%D1%81%D1%87%D0%B5%D1%82`);
  });

  it('пустое состояние даёт голый адрес', () => {
    expect(
      buildSearchUrl({
        query: '',
        scope: { kind: 'all' },
        includeJunk: false,
        facets: { flags: [], folderId: null, period: null },
      }),
    ).toBe(SEARCH_PATH);
  });

  it('разбор и сборка — обратные операции', () => {
    const query = 'q_query=%D1%81%D1%87%D0%B5%D1%82&scope=inbox&junk=1&flagged=1&period=year%3A2020';
    const state = parse(query);
    const rebuilt = parse(buildSearchUrl(state).split('?')[1] ?? '');
    expect(rebuilt).toEqual(state);
  });
});

describe('переключение фасетов', () => {
  const base = parse('q_query=счет');

  it('признак включается и выключается повторным нажатием', () => {
    const on = toggleFlagFacet(base, 'unread');
    expect(on.facets.flags).toEqual(['unread']);
    expect(toggleFlagFacet(on, 'unread').facets.flags).toEqual([]);
  });

  it('признаки накапливаются, не вытесняя друг друга', () => {
    const two = toggleFlagFacet(toggleFlagFacet(base, 'unread'), 'flagged');
    expect(two.facets.flags).toEqual(['unread', 'flagged']);
  });

  it('папка и период — одиночный выбор, повтор снимает его', () => {
    const folder = toggleFolderFacet(base, 'inbox');
    expect(folder.facets.folderId).toBe('inbox');
    expect(toggleFolderFacet(folder, 'inbox').facets.folderId).toBeNull();

    const period = togglePeriodFacet(base, 'year:2020');
    expect(period.facets.period).toBe('year:2020');
    expect(togglePeriodFacet(period, 'year:2020').facets.period).toBeNull();
  });

  it('переключение фасета не трогает запрос и область', () => {
    const next = toggleFlagFacet(parse('q_query=счет&scope=inbox'), 'unread');
    expect(next.query).toBe('счет');
    expect(next.scope).toEqual({ kind: 'folder', folderId: 'inbox' });
  });
});

describe('searchTargets', () => {
  function folder(id: string, role: Folder['role']): Folder {
    return {
      id,
      path: id,
      name: id,
      role,
      parentId: null,
      depth: 0,
      unreadCount: 0,
      totalCount: 0,
      system: true,
      uidValidity: 1,
    };
  }

  const FOLDERS = [
    folder('inbox', 'inbox'),
    folder('sent', 'sent'),
    folder('spam', 'spam'),
    folder('trash', 'trash'),
  ];

  it('по умолчанию спам и корзина исключены — их и не индексируют в фоне', () => {
    const ids = searchTargets(FOLDERS, parse('q_query=счет')).map((f) => f.id);
    expect(ids).toEqual(['inbox', 'sent']);
  });

  it('«Искать в спаме и корзине» добавляет их обратно', () => {
    const ids = searchTargets(FOLDERS, parse('q_query=счет&junk=1')).map((f) => f.id);
    expect(ids).toEqual(['inbox', 'sent', 'spam', 'trash']);
  });

  it('выбранная область — ровно одна папка, даже если это Спам', () => {
    const ids = searchTargets(FOLDERS, parse('q_query=счет&scope=spam')).map((f) => f.id);
    expect(ids).toEqual(['spam']);
  });
});
