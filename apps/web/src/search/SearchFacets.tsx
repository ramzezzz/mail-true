/**
 * Левая колонка в режиме поиска: вместо папок — «Фильтры поиска» тремя
 * группами (research/mailru/09-search.png).
 *
 *   Признаки письма — Непрочитанные, С флагом, С вложениями
 *   Все папки       — папки со счётчиками совпадений
 *   За всё время    — За этот месяц, помесячно, затем по годам
 *
 * Счётчики берутся из контекста: их считает страница поиска по загруженным
 * результатам (временное решение, см. lib/searchFacets.ts).
 */

import { useNavigate, useSearchParams } from 'react-router-dom';
import { cx } from '../lib/cx';
import { FLAG_FACET_TITLES, type SearchFlagFacet } from '../lib/searchFacets';
import { IconAttach, IconFlag, IconFolder, IconMailUnread } from '../mail/icons';
import {
  buildSearchUrl,
  parseSearchParams,
  toggleFlagFacet,
  toggleFolderFacet,
  togglePeriodFacet,
} from './searchParams';
import { useSearchContext } from './SearchContext';
import styles from './SearchFacets.module.css';

const FLAG_ORDER: readonly SearchFlagFacet[] = ['unread', 'flagged', 'attachments'];

const FLAG_ICONS: Record<SearchFlagFacet, () => JSX.Element> = {
  unread: () => <IconMailUnread />,
  flagged: () => <IconFlag />,
  attachments: () => <IconAttach />,
};

export function SearchFacets() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { aggregates, loading } = useSearchContext();
  const state = parseSearchParams(params);

  const go = (next: ReturnType<typeof parseSearchParams>) => {
    void navigate(buildSearchUrl(next));
  };

  return (
    <aside className={styles.sidebar} aria-label="Фильтры поиска">
      <div className={styles.title}>Фильтры поиска</div>

      {/* Признаки письма */}
      <div className={styles.group}>
        {FLAG_ORDER.map((flag) => {
          const Icon = FLAG_ICONS[flag];
          const active = state.facets.flags.includes(flag);
          const count = aggregates?.flags[flag] ?? 0;
          return (
            <button
              key={flag}
              type="button"
              className={cx(styles.item, active && styles.active)}
              aria-pressed={active}
              onClick={() => go(toggleFlagFacet(state, flag))}
            >
              <span className={styles.itemIcon}>
                <Icon />
              </span>
              <span className={styles.itemName}>{FLAG_FACET_TITLES[flag]}</span>
              {!loading && count > 0 && <span className={styles.counter}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Папки со счётчиками совпадений */}
      <div className={styles.groupTitle}>Все папки</div>
      <div className={styles.group}>
        {loading && aggregates === null && <FacetSkeleton rows={4} />}
        {aggregates?.folders.length === 0 && !loading && (
          <div className={styles.empty}>Совпадений нет</div>
        )}
        {aggregates?.folders.map((folder) => {
          const active = state.facets.folderId === folder.id;
          return (
            <button
              key={folder.id}
              type="button"
              className={cx(styles.item, active && styles.active)}
              aria-pressed={active}
              onClick={() => go(toggleFolderFacet(state, folder.id))}
            >
              <span className={styles.itemIcon}>
                <IconFolder />
              </span>
              <span className={styles.itemName}>{folder.label}</span>
              <span className={styles.counter}>{folder.count}</span>
            </button>
          );
        })}
      </div>

      {/* Периоды */}
      <div className={styles.groupTitle}>За всё время</div>
      <div className={styles.group}>
        {loading && aggregates === null && <FacetSkeleton rows={3} />}
        {aggregates?.periods.map((period) => {
          const active = state.facets.period === period.id;
          return (
            <button
              key={period.id}
              type="button"
              className={cx(styles.item, styles.periodItem, active && styles.active)}
              aria-pressed={active}
              onClick={() => go(togglePeriodFacet(state, period.id))}
            >
              <span className={styles.itemName}>{period.label}</span>
              <span className={styles.counter}>{period.count}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** Скелетоны вместо нулей, пока считаются первые результаты. */
function FacetSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={styles.skeleton} aria-hidden="true" />
      ))}
    </>
  );
}
