/**
 * Поисковая строка в шапке. Два вида, как у mail.ru:
 *
 *   обычный  — одно поле «Поиск по почте»;
 *   поисковый — «‹ Сбросить поиск», лупа, чип области «Везде ▾», запрос
 *               с крестиком и кнопка «Найти» (research/mailru/09-search.png).
 *
 * Значение поля — своё состояние, а не адресная строка: пользователь правит
 * запрос, и до нажатия «Найти» адрес меняться не должен, иначе каждая буква
 * запускала бы новый поиск. Синхронизация в обратную сторону есть: пришли
 * по ссылке или нажали «назад» — поле подхватывает запрос из адреса.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useFolders } from '../api/queries';
import { Dropdown, MenuItem } from '../components';
import { cx } from '../lib/cx';
import { folderTitle } from '../lib/folderNames';
import { EMPTY_SELECTION } from '../lib/searchFacets';
import {
  SEARCH_PATH,
  buildSearchUrl,
  parseSearchParams,
  type SearchState,
} from '../search/searchParams';
import styles from './SearchBar.module.css';

export function SearchBar() {
  const location = useLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: folders } = useFolders();
  const inputRef = useRef<HTMLInputElement>(null);

  const inSearch = location.pathname.startsWith(SEARCH_PATH.replace(/\/$/u, ''));
  const state: SearchState = parseSearchParams(params);
  const [text, setText] = useState(state.query);

  // Запрос в адресе поменялся снаружи (ссылка, «назад», фасетный фильтр)
  useEffect(() => {
    setText(inSearch ? state.query : '');
  }, [inSearch, state.query]);

  // Переменная, а не обращение к state.scope внутри замыкания: сужение типа
  // размеченного объединения через колбэк TypeScript не переносит.
  const scopeFolderId = state.scope.kind === 'folder' ? state.scope.folderId : null;
  const scopeFolder = scopeFolderId ? folders?.find((f) => f.id === scopeFolderId) : undefined;
  // Папка ещё не загрузилась — показываем «Везде», а не пустой чип.
  const scopeLabel = scopeFolder ? folderTitle(scopeFolder) : 'Везде';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const query = text.trim();
    if (query.length === 0) return;
    // Смена запроса сбрасывает фасеты: счётчики относятся к прошлому поиску.
    void navigate(
      buildSearchUrl({
        ...state,
        query,
        // Отбор по метке сбрасывается вместе с остальными фасетами: он
        // тоже относится к прошлому поиску (EMPTY_SELECTION собран в
        // lib/searchFacets.ts, чтобы новый фасет не забыли ни здесь, ни там).
        facets: EMPTY_SELECTION,
      }),
    );
  };

  const setScope = (scope: SearchState['scope']) => {
    if (!inSearch) return;
    void navigate(buildSearchUrl({ ...state, scope }));
  };

  if (!inSearch) {
    return (
      <form className={styles.zone} onSubmit={submit} role="search">
        <label className={styles.field}>
          <SearchIcon />
          <input
            ref={inputRef}
            className={styles.input}
            type="search"
            value={text}
            placeholder="Поиск по почте"
            aria-label="Поиск по почте"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </form>
    );
  }

  return (
    <form className={cx(styles.zone, styles.zoneSearch)} onSubmit={submit} role="search">
      <button
        type="button"
        className={styles.reset}
        onClick={() => void navigate(`/${scopeFolderId ?? 'inbox'}/`)}
      >
        <span className={styles.resetChevron} aria-hidden="true">
          ‹
        </span>
        Сбросить поиск
      </button>

      <div className={styles.field}>
        <SearchIcon />

        {/* Чип области поиска: «Везде» или конкретная папка */}
        <Dropdown
          className={styles.scopeHost}
          trigger={({ toggle }) => (
            <button type="button" className={styles.scope} onClick={toggle}>
              {scopeLabel}
              <span className={styles.scopeArrow} aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        >
          <MenuItem onClick={() => setScope({ kind: 'all' })}>Везде</MenuItem>
          {(folders ?? []).map((f) => (
            <MenuItem key={f.id} onClick={() => setScope({ kind: 'folder', folderId: f.id })}>
              {f.depth > 0 ? `  ${folderTitle(f)}` : folderTitle(f)}
            </MenuItem>
          ))}
        </Dropdown>

        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          value={text}
          aria-label="Поисковый запрос"
          onChange={(e) => setText(e.target.value)}
        />

        {text.length > 0 && (
          <button
            type="button"
            className={styles.clear}
            aria-label="Очистить запрос"
            onClick={() => {
              setText('');
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>

      <button type="submit" className={styles.submit}>
        Найти
      </button>
    </form>
  );
}

function SearchIcon() {
  return (
    <svg className={styles.icon} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M9 3.5a5.5 5.5 0 1 0 3.4 9.82l3.14 3.14a.9.9 0 1 0 1.27-1.27l-3.13-3.14A5.5 5.5 0 0 0 9 3.5Zm-3.7 5.5a3.7 3.7 0 1 1 7.4 0 3.7 3.7 0 0 1-7.4 0Z"
        fill="currentColor"
      />
    </svg>
  );
}
