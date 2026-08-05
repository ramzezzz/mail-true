/**
 * Каркас страницы (по mail.ru):
 * шапка 62px во всю ширину, ниже — левая колонка 232px и белая карточка
 * контента со скруглённым верхним левым углом.
 *
 * В режиме поиска левая колонка подменяется фасетными фильтрами: у mail.ru
 * это то же место, что и список папок. Счётчики для них считает страница
 * поиска, поэтому весь каркас обёрнут в `SearchProvider`.
 *
 * До 1024px колонка не помещается рядом со списком и уезжает за левый край
 * выдвижным ящиком: показать её можно кнопкой-гамбургером в шапке.
 */

import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { ComposeWindows } from '../compose/ComposeWindows';
import { cx } from '../lib/cx';
import { SearchFacets } from '../search/SearchFacets';
import { SEARCH_PATH } from '../search/searchParams';
import { SearchProvider } from '../search/SearchContext';
import { Header, NAV_DRAWER_ID } from './Header';
import { Notice } from './Notice';
import { Sidebar } from './Sidebar';
import styles from './AppLayout.module.css';

export function AppLayout() {
  const location = useLocation();
  const inSearch = location.pathname.startsWith(SEARCH_PATH.replace(/\/$/u, ''));

  /**
   * Открыт ли выдвижной ящик с папками. Состояние живёт здесь, а не в общем
   * хранилище: ящик существует только внутри этого каркаса, и делить его
   * с остальным приложением незачем.
   */
  const [navOpen, setNavOpen] = useState(false);

  // Перешли в другую папку или в письмо — ящик закрывается сам: иначе он
  // остался бы поверх только что открытого списка.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <SearchProvider>
      <div className={styles.app}>
        <Header navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} />
        <div className={styles.body}>
          <div id={NAV_DRAWER_ID} className={cx(styles.aside, navOpen && styles.asideOpen)}>
            {inSearch ? <SearchFacets /> : <Sidebar />}
          </div>
          {/* Затемнение под ящиком: нажатие мимо закрывает его.
              Всегда в разметке, но на широком экране скрыто display:none,
              поэтому в дерево доступности не попадает. */}
          <button
            type="button"
            className={cx(styles.scrim, navOpen && styles.scrimOpen)}
            aria-label="Закрыть список папок"
            tabIndex={navOpen ? 0 : -1}
            onClick={() => setNavOpen(false)}
          />
          <main className={styles.content}>
            <Outlet />
          </main>
        </div>
        {/* Окна написания письма — поверх любой страницы */}
        <ComposeWindows />
        {/* Сообщение об отказе — поверх всего */}
        <Notice />
      </div>
    </SearchProvider>
  );
}
