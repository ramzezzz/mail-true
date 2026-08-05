/**
 * Каркас раздела настроек.
 *
 * Настройки у mail.ru оформлены ИНАЧЕ, чем почта (docs/features-mailru.md):
 * светлый фон без фоновой картинки, простая шапка со ссылкой «Вернуться
 * в почту», список разделов слева и белая карточка справа. Заголовки крупнее
 * почтовых: h1 32/36 вес 500, h2 28/32 вес 500.
 *
 * Поэтому это отдельный каркас, а не страница внутри `AppLayout`: общего
 * с почтой у него ровно ноль, включая тему фона.
 */

import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAiState } from '../api/aiQueries';
import { AI_SETTINGS_PATH, aiVisible } from '../ai/aiVisibility';
import { cx } from '../lib/cx';
import { IconArrowLeft } from '../mail/icons';
import styles from './SettingsLayout.module.css';

interface NavItem {
  to: string;
  title: string;
  /** Точное совпадение адреса — нужно для «Главной». */
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/settings', title: 'Главная', end: true },
  { to: '/settings/general', title: 'Общие' },
  { to: '/settings/filters', title: 'Фильтры' },
  { to: '/settings/folders', title: 'Папки' },
  { to: '/settings/collector', title: 'Почта с других ящиков' },
];

export function SettingsLayout() {
  const navigate = useNavigate();
  const { data: aiState } = useAiState();

  // Помощника нет в списке разделов, пока администратор его не разрешил
  const nav = aiVisible(aiState)
    ? [...NAV, { to: AI_SETTINGS_PATH, title: 'Помощник на основе ИИ' }]
    : NAV;

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <button type="button" className={styles.back} onClick={() => void navigate('/inbox/')}>
          <IconArrowLeft size={20} />
          Вернуться в почту
        </button>
      </header>

      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Разделы настроек">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end ?? false}
              className={({ isActive }) => cx(styles.navItem, isActive && styles.navItemActive)}
            >
              {item.title}
            </NavLink>
          ))}
        </nav>

        <main className={styles.card}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
