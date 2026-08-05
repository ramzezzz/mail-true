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

import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAiState } from '../api/aiQueries';
import { AI_SETTINGS_PATH, aiVisible } from '../ai/aiVisibility';
import { cx } from '../lib/cx';
import { IconArrowLeft } from '../mail/icons';
import styles from './SettingsLayout.module.css';

export interface NavItem {
  to: string;
  title: string;
  /** Точное совпадение адреса — нужно для «Главной». */
  end?: boolean;
}

/** Главная настроек — она же единственный пункт с точным совпадением. */
const HOME: NavItem = { to: '/settings', title: 'Главная', end: true };

const NAV: NavItem[] = [
  HOME,
  { to: '/settings/general', title: 'Общие' },
  { to: '/settings/appearance', title: 'Оформление' },
  { to: '/settings/filters', title: 'Фильтры' },
  { to: '/settings/folders', title: 'Папки' },
  { to: '/settings/collector', title: 'Почта с других ящиков' },
];

/**
 * Адрес без хвостовых косых: `/settings/` и `/settings` — одно и то же место.
 *
 * Именно на этом ломалась подсветка «Главной»: в меню стоит `/settings`, а
 * ссылка на раздел из почты ведёт на `/settings/`, и точное сравнение
 * (`end`) их не отождествляло — на самой главной странице настроек ни один
 * пункт меню не был подсвечен.
 */
export function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Активен ли пункт меню при текущем адресе. */
export function isNavItemActive(pathname: string, item: NavItem): boolean {
  const here = normalizePath(pathname);
  const to = normalizePath(item.to);
  return item.end ? here === to : here === to || here.startsWith(`${to}/`);
}

export function SettingsLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
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
          {nav.map((item) => {
            const active = isNavItemActive(pathname, item);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={cx(styles.navItem, active && styles.navItemActive)}
              >
                {item.title}
              </Link>
            );
          })}
        </nav>

        {/*
          Главная настроек — плитка отдельных белых карточек на сером фоне,
          как `/settings` у mail.ru (research/mailru/04-settings.png). Общей
          белой подложки под ней быть не должно: карточки на карточке
          читались одним белым полем, и их приходилось обводить рамкой.
          У остальных разделов подложка своя, белая (05-filters.png).
        */}
        <main className={cx(styles.card, isNavItemActive(pathname, HOME) && styles.cardPlain)}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
