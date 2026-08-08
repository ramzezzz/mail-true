/**
 * Разбор и сборка адреса страницы поиска.
 *
 * Адресация повторяет привычный почтовый интерфейс: `/search/?q_query=<запрос>`. Всё остальное
 * состояние — область поиска, выбранные фасеты, «искать в спаме и корзине» —
 * тоже живёт в адресной строке, а не в памяти компонента. Так работают
 * «назад» и «вперёд» браузера, а ссылку на найденное можно переслать.
 */

import type { Folder } from '@mail-true/shared';
import {
  EMPTY_SELECTION,
  type SearchFacetSelection,
  type SearchFlagFacet,
} from '../lib/searchFacets';

export const SEARCH_PATH = '/search/';

/**
 * Папки, которые поиск не трогает без явного разрешения: спам и корзина.
 * Это не прихоть интерфейса — в фоне они и не индексируются
 * (`fts_autoindex_exclude`, docs/search.md), поэтому кнопка «Искать в спаме
 * и корзине» существует и в привычных почтовых интерфейсах.
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
      label: params.get('label'),
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
  // В адрес попадает КЛЮЧ метки, а не её название: название человек меняет
  // когда захочет, и ссылка «письма с меткой Оплатить», отправленная себе
  // же на завтра, после переименования указывала бы в пустоту.
  if (state.facets.label) params.set('label', state.facets.label);
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
    facets: EMPTY_SELECTION,
  });
}

/**
 * Ссылка «показать всё с этой меткой».
 *
 * Запрос пустым быть не может — поиск без запроса ничего не ищет
 * (см. useSearch), — поэтому меткой отбирают уже найденное. Отдельная
 * функция нужна затем, чтобы пункт «Отобрать по метке» из любого меню
 * собирал адрес одинаково.
 */
export function searchUrlForLabel(query: string, labelKey: string): string {
  return buildSearchUrl({
    query,
    scope: { kind: 'all' },
    includeJunk: false,
    facets: { ...EMPTY_SELECTION, label: labelKey },
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

/**
 * Выбрать метку; повторное нажатие снимает отбор.
 *
 * Метка выбирается одна, как папка и период, а не набором, как признаки
 * письма. Причина в том, что «и оплатить, и спросить у юриста» — это
 * пересечение, которое человек почти никогда не имеет в виду: метки он
 * вешает как раз затем, чтобы разделить эти два дела.
 */
export function toggleLabelFacet(state: SearchState, labelKey: string): SearchState {
  const next = state.facets.label === labelKey ? null : labelKey;
  return { ...state, facets: { ...state.facets, label: next } };
}
