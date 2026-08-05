/**
 * Загрузка результатов поиска.
 *
 * ВРЕМЕННОЕ РЕШЕНИЕ, и вот почему. Отдельного маршрута поиска в API нет:
 * есть только `GET /api/messages?folderId=…&search=…`, то есть поиск в одной
 * папке. Поэтому «Везде» здесь разворачивается в параллельные запросы по
 * каждой папке, а результаты склеиваются и сортируются по дате уже в браузере.
 * Агрегаты для фасетных фильтров считаются там же (см. lib/searchFacets.ts).
 *
 * Что это значит на практике:
 *   - счётчики честны в пределах загруженной страницы (100 писем на папку),
 *     а не по всему ящику;
 *   - запросов столько, сколько папок.
 *
 * Нужен маршрут `GET /api/search` с параметрами запроса, областью и флагом
 * «включая спам и корзину», отдающий и совпадения, и агрегаты, и фрагменты
 * из вложений (SNIPPET у Dovecot уже объявлен, см. docs/search.md).
 *
 * Запрос перед отправкой прогоняется через `stemSearchQuery`: поиск Xapian
 * префиксный, и без обрезки окончаний «документами» не нашло бы «документ».
 */

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Folder, MessageSummary } from '@mail-true/shared';
import { api } from '../api';
import { MESSAGES_PAGE_SIZE } from '../api/client';
import { queryKeys } from '../api/queries';
import { computeAggregates, type SearchAggregates } from '../lib/searchFacets';
import { queryStems, stemSearchQuery } from '../lib/searchQuery';
import { searchTargets, type SearchState } from './searchParams';

export interface SearchResult {
  /** Совпадения из всех папок области, новые первыми. */
  items: MessageSummary[];
  aggregates: SearchAggregates;
  /** Основы слов запроса — по ним подсвечиваются совпадения. */
  stems: string[];
  /** Запрос в том виде, в котором он ушёл на сервер. */
  serverQuery: string;
  isPending: boolean;
  isError: boolean;
  /** Есть ли что искать: пустая строка запроса поиском не считается. */
  isEmptyQuery: boolean;
}

export function useSearch(state: SearchState, folders: readonly Folder[]): SearchResult {
  const serverQuery = useMemo(() => stemSearchQuery(state.query.trim()), [state.query]);
  const stems = useMemo(() => queryStems(state.query.trim()), [state.query]);
  const isEmptyQuery = serverQuery.length === 0;

  const targets = useMemo(() => searchTargets(folders, state), [folders, state]);

  const results = useQueries({
    queries: targets.map((folder) => {
      const query = {
        folderId: folder.id,
        offset: 0,
        limit: MESSAGES_PAGE_SIZE,
        threaded: false,
        filter: 'all' as const,
        search: serverQuery,
      };
      return {
        queryKey: queryKeys.messages(query),
        queryFn: () => api.getMessages(query),
        enabled: !isEmptyQuery,
      };
    }),
  });

  const items = useMemo(() => {
    const merged: MessageSummary[] = [];
    for (const result of results) {
      if (result.data) merged.push(...result.data.items);
    }
    return merged.sort((a, b) => b.date.localeCompare(a.date));
    // Зависимость по данным, а не по массиву объектов запроса: сами объекты
    // react-query пересоздаёт на каждый рендер, и useMemo терял бы смысл.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(',')]);

  const aggregates = useMemo(() => computeAggregates(items, folders), [items, folders]);

  return {
    items,
    aggregates,
    stems,
    serverQuery,
    isPending: !isEmptyQuery && results.some((r) => r.isPending),
    isError: results.some((r) => r.isError),
    isEmptyQuery,
  };
}
