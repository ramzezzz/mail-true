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

import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAiState } from '../api/aiQueries';
import { ChatPanel } from '../ai/ChatPanel';
import { aiFeatureVisible } from '../ai/aiVisibility';
import { IconButton, Tooltip } from '../components';
import { cx } from '../lib/cx';
import { IconSettings } from '../mail/icons';
import { SEARCH_PATH } from '../search/searchParams';
import { AccountMenu } from './AccountMenu';
import { SearchBar } from './SearchBar';
import { ThemeMenu } from './ThemeMenu';
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

export function Header({ navOpen, onToggleNav }: HeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: aiState } = useAiState();
  const [chatOpen, setChatOpen] = useState(false);

  /*
   * Кнопки разговора нет, пока возможность не разрешена администратором
   * и не включена самим человеком: правило видимости одно на весь
   * помощник (aiVisibility), и обходить его здесь нельзя. Кнопка,
   * ведущая к отказу, хуже отсутствующей кнопки.
   */
  const chatVisible = aiFeatureVisible(aiState, 'chat');

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
            {/* Узкий экран получает только знак: полное начертание с надписью
                «MAIL.TRUE» отъедало у поиска половину строки — поймано на
                снимке от заказчика. Знак читается и в 28 точек. */}
            <img className={styles.logoMark} src="/brand/mark.svg" alt="" />
          </a>
        </div>
      )}

      <SearchBar />

      <div className={styles.rightZone}>
        {chatVisible && (
          <Tooltip text="Разговор с помощником">
            <IconButton
              label="Разговор с помощником"
              className={styles.headerButton}
              onClick={() => setChatOpen(true)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M10 2.5c4.14 0 7.5 2.8 7.5 6.25 0 3.45-3.36 6.25-7.5 6.25-.7 0-1.38-.08-2.02-.23l-3.3 1.6a.6.6 0 0 1-.86-.62l.36-2.5C2.85 12.1 2.5 10.72 2.5 8.75 2.5 5.3 5.86 2.5 10 2.5Zm-3 5.4a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Zm3 0a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Zm3 0a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Z"
                  fill="currentColor"
                />
              </svg>
            </IconButton>
          </Tooltip>
        )}

        <Tooltip text="Настройки">
          <IconButton
            label="Настройки"
            className={styles.headerButton}
            onClick={() => void navigate('/settings')}
          >
            <IconSettings size={20} />
          </IconButton>
        </Tooltip>

        <ThemeMenu buttonClassName={styles.headerButton} />

        <AccountMenu />
      </div>

      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
    </header>
  );
}
