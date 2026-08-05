/**
 * Мост между страницей поиска и левой колонкой.
 *
 * Фасетные фильтры рисуются на месте списка папок, то есть в каркасе, а
 * счётчики для них считаются из результатов, то есть на странице. Страница —
 * потомок каркаса через `<Outlet/>`, поэтому данные поднимаются контекстом:
 * страница кладёт агрегаты, левая колонка их читает.
 *
 * Через глобальное состояние (zustand) это делать не стоит: агрегаты живут
 * ровно столько же, сколько открытая страница поиска, и глобальным состоянием
 * не являются.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { SearchAggregates } from '../lib/searchFacets';

interface SearchContextValue {
  aggregates: SearchAggregates | null;
  setAggregates(aggregates: SearchAggregates | null): void;
  /** Идут ли сейчас запросы — колонка показывает скелетоны вместо нулей. */
  loading: boolean;
  setLoading(loading: boolean): void;
}

const SearchContext = createContext<SearchContextValue>({
  aggregates: null,
  setAggregates: () => {},
  loading: false,
  setLoading: () => {},
});

export function SearchProvider({ children }: { children: ReactNode }) {
  const [aggregates, setAggregates] = useState<SearchAggregates | null>(null);
  const [loading, setLoading] = useState(false);
  const value = useMemo(
    () => ({ aggregates, setAggregates, loading, setLoading }),
    [aggregates, loading],
  );
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export function useSearchContext(): SearchContextValue {
  return useContext(SearchContext);
}
