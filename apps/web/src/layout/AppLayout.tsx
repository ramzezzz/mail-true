/**
 * Каркас страницы (по эталонному интерфейсу):
 * шапка 62px во всю ширину, ниже — левая колонка 232px и белая карточка
 * контента со скруглённым верхним левым углом.
 *
 * В режиме поиска левая колонка подменяется фасетными фильтрами: в привычных почтовых интерфейсах
 * это то же место, что и список папок. Счётчики для них считает страница
 * поиска, поэтому весь каркас обёрнут в `SearchProvider`.
 *
 * До 1024px колонка не помещается рядом со списком и уезжает за левый край
 * выдвижным ящиком: показать её можно кнопкой-гамбургером в шапке.
 */

import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { ComposeWindows } from '../compose/ComposeWindows';
import { useUiStore } from '../app/store';
import { cx } from '../lib/cx';
import { IconCompose } from '../mail/icons';
import { SearchFacets } from '../search/SearchFacets';
import { SEARCH_PATH } from '../search/searchParams';
import { SearchProvider } from '../search/SearchContext';
import { globalHotkeyFor } from '../lib/hotkeys';
import { BottomNav } from './BottomNav';
import bottomStyles from './BottomNav.module.css';
import { Footer } from './Footer';
import { Header, NAV_DRAWER_ID } from './Header';
import { HotkeysHelp } from './HotkeysHelp';
import { Notice } from './Notice';
import { SEARCH_INPUT_ATTR } from './SearchBar';
import { Sidebar } from './Sidebar';
import styles from './AppLayout.module.css';

export function AppLayout() {
  const location = useLocation();
  const inSearch = location.pathname.startsWith(SEARCH_PATH.replace(/\/$/u, ''));
  const openCompose = useUiStore((s) => s.openCompose);

  /**
   * Открыт ли выдвижной ящик с папками. Состояние живёт здесь, а не в общем
   * хранилище: ящик существует только внутри этого каркаса, и делить его
   * с остальным приложением незачем.
   */
  const [navOpen, setNavOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Перешли в другую папку или в письмо — ящик закрывается сам: иначе он
  // остался бы поверх только что открытого списка.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  /*
   * Клавиши, доступные на любой странице почты: C — написать, / — поиск,
   * ? — справка. Обработчик отдельный от страничного (см. lib/hotkeys.ts):
   * страницы отвечают за письма, каркас — за то, что есть всегда.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = globalHotkeyFor(e, e.target);
      if (!action) return;
      // Отменяем действие браузера до всего остального: без этого «/»
      // в Firefox открывает быстрый поиск по странице, а наш обработчик
      // сработал бы поверх него.
      e.preventDefault();
      if (action === 'compose') {
        openCompose();
        return;
      }
      if (action === 'help') {
        setHelpOpen(true);
        return;
      }
      // Поле поиска стоит в шапке при любой ширине экрана — своего вида для
      // телефона у него нет, поэтому запасного пути здесь не нужно.
      const input = document.querySelector<HTMLInputElement>(`[${SEARCH_INPUT_ATTR}]`);
      input?.focus();
      input?.select();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openCompose]);

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
          {/*
            Строка состояния стоит ВНУТРИ карточки контента, под <Outlet/>:
            так она лежит на непрозрачной белой подложке при любой теме,
            включая «обойную», где всё вокруг карточки — фотография
            пользователя, и посчитать контраст текста на ней невозможно.
          */}
          <main className={styles.content}>
            <Outlet />
            <Footer />
          </main>
        </div>

        {/*
          Телефон: полоса главных папок внизу и плавающая кнопка написания.
          На широком экране и то и другое скрыто стилями — там колонка папок
          и кнопка «Написать письмо» и так на виду.
        */}
        <BottomNav
          navOpen={navOpen}
          onToggleNav={() => setNavOpen((open) => !open)}
          drawerId={NAV_DRAWER_ID}
        />
        <button
          type="button"
          className={bottomStyles.fab}
          aria-label="Написать письмо"
          onClick={() => openCompose()}
        >
          <IconCompose size={24} />
        </button>

        {/* Справка по клавишам — по «?» */}
        {helpOpen && <HotkeysHelp onClose={() => setHelpOpen(false)} />}
        {/* Окна написания письма — поверх любой страницы */}
        <ComposeWindows />
        {/* Сообщение об отказе — поверх всего */}
        <Notice />
      </div>
    </SearchProvider>
  );
}
