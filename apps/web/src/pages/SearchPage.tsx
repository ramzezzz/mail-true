/**
 * Страница поиска `/search/?q_query=<запрос>`.
 *
 * Шапка переключается в поисковый режим (см. layout/Header.tsx), левая
 * колонка показывает фасетные фильтры (search/SearchFacets.tsx), а здесь —
 * панель «Искать в спаме и корзине», сообщение об обрезке окончаний и
 * сгруппированные по периодам результаты.
 */

import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Folder } from '@mail-true/shared';
import { useFolders } from '../api/queries';
import { Button } from '../components';
import { applyFacets } from '../lib/searchFacets';
import { IconSearch } from '../mail/icons';
import { ListSkeleton } from '../mail/ListSkeleton';
import { buildSearchUrl, parseSearchParams } from '../search/searchParams';
import { useSearchContext } from '../search/SearchContext';
import { SearchResults } from '../search/SearchResults';
import { useSearch } from '../search/useSearch';
import styles from './SearchPage.module.css';

/**
 * Постоянная пустышка вместо `folders ?? []` по месту.
 * Новый массив на каждом рендере ломал бы мемоизацию агрегатов: они
 * пересчитывались бы заново, эффект каждый раз клал бы в контекст новый
 * объект и вызывал следующий рендер — бесконечный круг, пока грузятся папки.
 */
const NO_FOLDERS: readonly Folder[] = [];

export function SearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const state = parseSearchParams(params);
  const { data: folders } = useFolders();
  const { setAggregates, setLoading } = useSearchContext();

  const search = useSearch(state, folders ?? NO_FOLDERS);

  // Счётчики уходят в левую колонку — она рисуется каркасом, не страницей
  useEffect(() => {
    setAggregates(search.isEmptyQuery ? null : search.aggregates);
    setLoading(search.isPending);
  }, [search.aggregates, search.isPending, search.isEmptyQuery, setAggregates, setLoading]);

  // Уходя со страницы, гасим счётчики: иначе они мигнут при следующем поиске
  useEffect(
    () => () => {
      setAggregates(null);
      setLoading(false);
    },
    [setAggregates, setLoading],
  );

  const visible = applyFacets(search.items, state.facets);

  if (search.isEmptyQuery) {
    return (
      <div className={styles.page}>
        <div className={styles.placeholder}>
          <IconSearch size={32} />
          <p className={styles.placeholderText}>Введите запрос — поиск идёт по всем папкам</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        {/* Спам и Корзина исключены по умолчанию — их не индексируют в фоне */}
        {!state.includeJunk ? (
          <Button
            mode="secondary"
            before={<IconSearch />}
            onClick={() => void navigate(buildSearchUrl({ ...state, includeJunk: true }))}
          >
            Искать в спаме и корзине
          </Button>
        ) : (
          <Button
            mode="secondary"
            onClick={() => void navigate(buildSearchUrl({ ...state, includeJunk: false }))}
          >
            Не искать в спаме и корзине
          </Button>
        )}

        <div className={styles.spacer} />

        {!search.isPending && (
          <span className={styles.total} aria-live="polite">
            Найдено: {visible.length}
          </span>
        )}
      </div>

      {/*
        Поиск префиксный (docs/search.md), поэтому на сервер уходит основа
        слова, а не то, что набрал пользователь. Показываем это честно —
        иначе непонятно, почему «документами» находит «документ».
      */}
      {search.serverQuery !== state.query.trim() && (
        <div className={styles.note}>
          Ищем по основам слов: <b>{search.serverQuery}</b>
        </div>
      )}

      {search.isPending && <ListSkeleton rows={8} />}

      {search.isError && !search.isPending && (
        <div className={styles.centered}>Не удалось выполнить поиск. Попробуйте ещё раз.</div>
      )}

      {!search.isPending && !search.isError && visible.length === 0 && (
        <div className={styles.centered}>
          Ничего не найдено{state.includeJunk ? '' : '. Попробуйте поискать в спаме и корзине'}
        </div>
      )}

      {!search.isPending && visible.length > 0 && (
        <SearchResults items={visible} stems={search.stems} folders={folders ?? NO_FOLDERS} />
      )}
    </div>
  );
}
