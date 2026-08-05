/**
 * Разбор и сборка адреса страницы поиска.
 *
 * Адресация повторяет mail.ru: `/search/?q_query=<запрос>`. Всё остальное
 * состояние — область поиска, выбранные фасеты, «искать в спаме и корзине» —
 * тоже живёт в адресной строке, а не в памяти компонента. Так работают
 * «назад» и «вперёд» браузера, а ссылку на найденное можно переслать.
 */

import type { Folder } from '@mail-true/shared';
import type { SearchFacetSelection, SearchFlagFacet } from '../lib/searchFacets';

export const SEARCH_PATH = '/search/';

/**
 * Папки, которые поиск не трогает без явного разрешения: спам и корзина.
 * Это не прихоть интерфейса — в фоне они и не индексируются
 * (`fts_autoindex_exclude`, docs/search.md), поэтому кнопка «Искать в спаме
 * и корзине» существует и у mail.ru.
 */
export const JUNK_ROLES: ReadonlySet<Folder['role']> = new Set(['spam', 'trash']);

/** Область поиска: везде или в одной папке (чип «Везде ▾» в шапке). */
export type SearchScope = { kind: 'all' } | { kind: 'folder'; folderId: string };

export interface SearchState {
  /** Текст запроса, как его ввёл пользователь (без обрезки окончаний). */
  query: string;
  scope: SearchScope;
  /** Искать в Спаме и Корзине — по умолчанию они исключены. */
  includeJunk: boolean;
  facets: SearchFacetSelection;
}

const FLAG_KEYS: readonly SearchFlagFacet[] = ['unread', 'flagged', 'attachments'];

export function parseSearchParams(params: URLSearchParams): SearchState {
  const scopeFolder = params.get('scope');
  const flags = FLAG_KEYS.filter((key) => params.get(key) === '1');
  return {
    query: params.get('q_query') ?? '',
    scope:
      scopeFolder && scopeFolder !== 'all'
        ? { kind: 'folder', folderId: scopeFolder }
        : { kind: 'all' },
    includeJunk: params.get('junk') === '1',
    facets: {
      flags,
      folderId: params.get('folder'),
      period: params.get('period'),
    },
  };
}

/**
 * Обратная сборка. Значения по умолчанию в адрес не пишутся — иначе ссылка
 * на простой поиск выглядела бы как строка настроек.
 */
export function buildSearchParams(state: SearchState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.query) params.set('q_query', state.query);
  if (state.scope.kind === 'folder') params.set('scope', state.scope.folderId);
  if (state.includeJunk) params.set('junk', '1');
  for (const key of FLAG_KEYS) {
    if (state.facets.flags.includes(key)) params.set(key, '1');
  }
  if (state.facets.folderId) params.set('folder', state.facets.folderId);
  if (state.facets.period) params.set('period', state.facets.period);
  return params;
}

export function buildSearchUrl(state: SearchState): string {
  const params = buildSearchParams(state);
  const query = params.toString();
  return query ? `${SEARCH_PATH}?${query}` : SEARCH_PATH;
}

/** Ссылка на простой поиск по строке — для шапки и «писем отправителя». */
export function searchUrlFor(query: string): string {
  return buildSearchUrl({
    query,
    scope: { kind: 'all' },
    includeJunk: false,
    facets: { flags: [], folderId: null, period: null },
  });
}

/**
 * Папки, по которым реально пойдёт поиск при текущей области и флаге.
 * При выбранной области «одна папка» флаг «искать в спаме и корзине»
 * не применяется: пользователь уже сказал, где искать.
 */
export function searchTargets(folders: readonly Folder[], state: SearchState): Folder[] {
  if (state.scope.kind === 'folder') {
    const scopeFolderId = state.scope.folderId;
    return folders.filter((f) => f.id === scopeFolderId);
  }
  return folders.filter((f) => state.includeJunk || !JUNK_ROLES.has(f.role));
}

/** Переключить признак письма, не трогая остальное состояние. */
export function toggleFlagFacet(state: SearchState, flag: SearchFlagFacet): SearchState {
  const has = state.facets.flags.includes(flag);
  return {
    ...state,
    facets: {
      ...state.facets,
      flags: has ? state.facets.flags.filter((f) => f !== flag) : [...state.facets.flags, flag],
    },
  };
}

/** Выбрать папку-фасет; повторное нажатие снимает выбор. */
export function toggleFolderFacet(state: SearchState, folderId: string): SearchState {
  const next = state.facets.folderId === folderId ? null : folderId;
  return { ...state, facets: { ...state.facets, folderId: next } };
}

/** Выбрать период; повторное нажатие возвращает «за всё время». */
export function togglePeriodFacet(state: SearchState, period: string): SearchState {
  const next = state.facets.period === period ? null : period;
  return { ...state, facets: { ...state.facets, period: next } };
}
