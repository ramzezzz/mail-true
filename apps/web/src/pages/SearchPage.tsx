/**
 * Страница поиска `/search/?q_query=<запрос>`.
 *
 * Шапка переключается в поисковый режим (см. layout/Header.tsx), левая
 * колонка показывает фасетные фильтры (search/SearchFacets.tsx), а здесь —
 * панель «Искать в спаме и корзине», чипы «во что превратился запрос»,
 * сообщение об обрезке окончаний и сгруппированные по периодам результаты.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { parseSearch, type Folder, type SearchChip } from '@mail-true/shared';
import { useFolders } from '../api/queries';
import { Button } from '../components';
import { applyFacets } from '../lib/searchFacets';
import { splitQueryParts } from '../lib/searchQuery';
import { IconSearch } from '../mail/icons';
import { ListSkeleton } from '../mail/ListSkeleton';
import { buildSearchUrl, parseSearchParams } from '../search/searchParams';
import { SaveSearchDialog } from '../search/SaveSearchDialog';
import { SearchChips } from '../search/SearchChips';
import { useSearchContext } from '../search/SearchContext';
import { SearchHelp } from '../search/SearchHelp';
import { SearchResults } from '../search/SearchResults';
import { useCreateSavedSearch, useSavedSearches } from '../search/useSavedSearches';
import { useSearch } from '../search/useSearch';
import styles from './SearchPage.module.css';

/**
 * Постоянная пустышка вместо `folders ?? []` по месту.
 * Новый массив на каждом рендере ломал бы мемоизацию агрегатов: они
 * пересчитывались бы заново, эффект каждый раз клал бы в контекст новый
 * объект и вызывал следующий рендер — бесконечный круг, пока грузятся папки.
 */
const NO_FOLDERS: readonly Folder[] = [];

/**
 * Убирает из строки запроса условие, которое человек снял чипом.
 *
 * Каждый кусок разбирается ТОЙ ЖЕ грамматикой и проверяется по тому же
 * описанию, что рисует чипы. Своего разбора здесь нет намеренно: он
 * разошёлся бы с грамматикой в первый же месяц, и чип «Отправитель»
 * перестал бы убирать `от:` — при том что нарисован был бы исправно.
 */
export function dropSearchChip(query: string, field: SearchChip['field']): string {
  return splitQueryParts(query)
    .filter((token) => {
      const chips = describeToken(token);
      return !chips.includes(field);
    })
    .join(' ');
}

function describeToken(token: string): SearchChip['field'][] {
  // Разбираем кусок сам по себе: что он даёт в одиночку, то он и добавил
  // к общему запросу.
  const parsed = parseSearch(token);
  const fields: SearchChip['field'][] = [];
  if (parsed.from) fields.push('from');
  if (parsed.to) fields.push('to');
  if (parsed.cc) fields.push('cc');
  if (parsed.subject) fields.push('subject');
  if (parsed.folder) fields.push('folder');
  if (parsed.filename) fields.push('filename');
  else if (parsed.hasAttachment) fields.push('hasAttachment');
  if (parsed.seen !== null) fields.push('seen');
  if (parsed.flagged !== null) fields.push('flagged');
  if (parsed.since) fields.push('since');
  if (parsed.before) fields.push('before');
  if (parsed.larger !== null) fields.push('larger');
  if (parsed.smaller !== null) fields.push('smaller');
  if (parsed.text) fields.push('text');
  return fields;
}

export function SearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const state = parseSearchParams(params);
  const { data: folders } = useFolders();
  const { setAggregates, setLoading } = useSearchContext();
  const [helpOpen, setHelpOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  const search = useSearch(state, folders ?? NO_FOLDERS);
  /*
   * Кнопка «Сохранить запрос» появляется вместе с поведением: пока сервер
   * не сказал, что запросы есть куда сохранять, кнопки нет вовсе — а не
   * есть, но с отказом при нажатии.
   */
  const savedSearches = useSavedSearches();
  const createSaved = useCreateSavedSearch();

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

  const goQuery = (query: string) => {
    void navigate(buildSearchUrl({ ...state, query }));
  };

  const visible = applyFacets(search.items, state.facets);

  if (search.isEmptyQuery) {
    return (
      <div className={styles.page}>
        <div className={styles.placeholder}>
          <IconSearch size={32} />
          <p className={styles.placeholderText}>Введите запрос — поиск идёт по всем папкам</p>
        </div>
        {/* Подсказка по операторам показана сразу: это единственное место,
            где человек её ещё готов прочитать — искать ему пока нечего. */}
        <SearchHelp onPick={(sample) => goQuery(`${state.query} ${sample}`.trim())} />
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

        {savedSearches.available && (
          <Button mode="secondary" onClick={() => setSaveOpen(true)}>
            Сохранить запрос
          </Button>
        )}

        <button
          type="button"
          className={styles.helpToggle}
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          {helpOpen ? 'Скрыть подсказку' : 'Как искать точнее'}
        </button>

        <div className={styles.spacer} />

        {!search.isPending && (
          <span className={styles.total} aria-live="polite">
            Найдено: {visible.length}
          </span>
        )}
      </div>

      {helpOpen && <SearchHelp onPick={(sample) => goQuery(`${state.query} ${sample}`.trim())} />}

      <SearchChips
        chips={search.plan.chips}
        onDrop={(chip) => goQuery(dropSearchChip(state.query, chip.field))}
      />

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

      {/*
        Названа папка, которой нет. Молчать здесь нельзя: человек увидел бы
        «ничего не найдено» и искал бы ошибку в словах запроса, а ошибка
        в названии папки.
      */}
      {search.plan.unknownFolder !== null && (
        <div className={styles.note}>
          Папки <b>{search.plan.unknownFolder}</b> нет. Уберите условие «Папка» или назовите папку
          так, как она называется в левой колонке.
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

      {saveOpen && (
        <SaveSearchDialog
          query={state.query.trim()}
          includeJunk={state.includeJunk}
          busy={createSaved.isPending}
          onClose={() => setSaveOpen(false)}
          onSave={(name) => {
            createSaved.mutate(
              { name, query: state.query.trim(), includeJunk: state.includeJunk },
              { onSuccess: () => setSaveOpen(false) },
            );
          }}
        />
      )}
    </div>
  );
}
