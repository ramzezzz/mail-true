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
import { LabelPill } from '../mail/LabelPill';
import { useLabelsState } from '../mail/useLabels';
import {
  buildSearchUrl,
  parseSearchParams,
  toggleFlagFacet,
  toggleFolderFacet,
  toggleLabelFacet,
  togglePeriodFacet,
} from './searchParams';
import { SavedSearches } from './SavedSearches';
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
  /*
   * Справочник меток. Без него отбор по метке не показывается вовсе:
   * агрегаты знают только ключевое слово (`mt-oplatit`), а строка фильтра
   * с таким текстом ничего человеку не говорит. Пока справочник не приехал
   * (или возможность выключена), группы «Метки» в колонке просто нет.
   */
  const { available: labelsAvailable, items: labelDictionary } = useLabelsState();
  const labelFacets = (aggregates?.labels ?? []).flatMap((facet) => {
    const known = labelDictionary.find((l) => l.key.toLowerCase() === facet.id.toLowerCase());
    return known ? [{ ...facet, label: known }] : [];
  });

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

      {/* Свои метки. Группы нет, если меток нет среди совпадений: пустой
          заголовок в колонке фильтров занимает место и ничего не значит. */}
      {labelsAvailable && labelFacets.length > 0 && (
        <>
          <div className={styles.groupTitle}>Метки</div>
          <div className={styles.group}>
            {labelFacets.map((facet) => {
              const active = state.facets.label === facet.id;
              return (
                <button
                  key={facet.id}
                  type="button"
                  className={cx(styles.item, active && styles.active)}
                  aria-pressed={active}
                  onClick={() => go(toggleLabelFacet(state, facet.id))}
                >
                  {/* Пилюля целиком, а не кружок: название рядом с цветом
                      обязательно и здесь — иначе строка фильтра ничем не
                      отличается от соседней для того, кто цвет не видит. */}
                  <span className={styles.itemName}>
                    <LabelPill label={facet.label} />
                  </span>
                  <span className={styles.counter}>{facet.count}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

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

      {/*
        Сохранённые запросы видны и в режиме поиска: переключиться с одного
        сохранённого запроса на другой — самая частая причина сюда смотреть,
        а левая колонка здесь занята фильтрами и папок не показывает.
      */}
      <SavedSearches />
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
