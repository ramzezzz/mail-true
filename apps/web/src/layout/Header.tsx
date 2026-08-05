/**
 * Портальная шапка, высота 62px: логотип в зоне левой колонки,
 * строка поиска, справа — переключатель темы и аватар.
 * Реальный поиск и меню проектов появятся позже — сейчас заглушки
 * с правильной геометрией и цветами.
 *
 * Аватар открывает меню ящика (`AccountMenu`): список привязанных ящиков
 * с непрочитанными, переключение, добавление и выход.
 *
 * До 1024px слева появляется кнопка-гамбургер: колонка папок там спрятана
 * в выдвижной ящик (см. AppLayout). На ширине ≤480px логотип уступает
 * место строке поиска — иначе на неё оставалось четыре пикселя.
 */

import { useLocation, useNavigate } from 'react-router-dom';
import { useUiStore, type ThemeName } from '../app/store';
import { Dropdown, IconButton, MenuItem, Tooltip } from '../components';
import { cx } from '../lib/cx';
import { IconSettings } from '../mail/icons';
import { SEARCH_PATH } from '../search/searchParams';
import { AccountMenu } from './AccountMenu';
import { SearchBar } from './SearchBar';
import styles from './Header.module.css';

/**
 * id выдвижного ящика с папками. Живёт здесь, а не в AppLayout: на него
 * ссылается aria-controls кнопки-гамбургера, а обратный импорт замкнул бы
 * модули в кольцо.
 */
export const NAV_DRAWER_ID = 'mt-nav-drawer';

export interface HeaderProps {
  /** Открыт ли ящик с папками (только на узком экране). */
  navOpen: boolean;
  onToggleNav(): void;
}

const THEME_TITLES: Record<ThemeName, string> = {
  light: 'Светлая',
  dark: 'Тёмная',
  wallpaper: 'С фоновой картинкой',
};

export function Header({ navOpen, onToggleNav }: HeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  // В режиме поиска логотип уступает место кнопке «‹ Сбросить поиск»
  const inSearch = location.pathname.startsWith(SEARCH_PATH.replace(/\/$/u, ''));

  return (
    <header className={cx(styles.header, inSearch && styles.headerSearch)}>
      {/* Гамбургер: на широком экране скрыт — колонка папок и так на месте */}
      <IconButton
        label={navOpen ? 'Скрыть папки' : 'Показать папки'}
        className={cx(styles.headerButton, styles.menuButton)}
        aria-expanded={navOpen}
        aria-controls={NAV_DRAWER_ID}
        onClick={onToggleNav}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M3 5.5h14a.9.9 0 0 1 0 1.8H3a.9.9 0 0 1 0-1.8Zm0 3.6h14a.9.9 0 0 1 0 1.8H3a.9.9 0 0 1 0-1.8Zm0 3.6h14a.9.9 0 0 1 0 1.8H3a.9.9 0 0 1 0-1.8Z"
            fill="currentColor"
          />
        </svg>
      </IconButton>

      {!inSearch && (
        <div className={styles.logoZone}>
          <a className={styles.logo} href="/" aria-label="Mail.True — почта">
            {/* Два начертания вместо переключения в коде: тему меняет атрибут
                data-theme на корне, и CSS сам показывает нужное. Так логотип
                не мигает при смене темы и не зависит от порядка отрисовки. */}
            <img className={styles.logoLight} src="/brand/logo-full.svg" alt="" />
            <img className={styles.logoDark} src="/brand/logo-full-dark.svg" alt="" />
          </a>
        </div>
      )}

      <SearchBar />

      <div className={styles.rightZone}>
        <Tooltip text="Настройки">
          <IconButton
            label="Настройки"
            className={styles.headerButton}
            onClick={() => void navigate('/settings')}
          >
            <IconSettings size={20} />
          </IconButton>
        </Tooltip>

        <Dropdown
          align="right"
          trigger={({ toggle }) => (
            <Tooltip text={`Тема: ${THEME_TITLES[theme]}`}>
              <IconButton label="Тема оформления" onClick={toggle} className={styles.headerButton}>
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                  <path
                    d="M10 2a8 8 0 1 0 0 16c.94 0 1.35-.62 1.35-1.19 0-.32-.12-.6-.31-.85a1.5 1.5 0 0 1 1.17-2.46h1.61A4.18 4.18 0 0 0 18 9.32 7.7 7.7 0 0 0 10 2Zm-4.5 8.75a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm2.75-4a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm4.5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"
                    fill="currentColor"
                  />
                </svg>
              </IconButton>
            </Tooltip>
          )}
        >
          {(Object.keys(THEME_TITLES) as ThemeName[]).map((name) => (
            <MenuItem key={name} onClick={() => setTheme(name)}>
              {THEME_TITLES[name]}
              {name === theme ? ' ✓' : ''}
            </MenuItem>
          ))}
        </Dropdown>

        <AccountMenu />
      </div>
    </header>
  );
}
