/**
 * Каркас раздела настроек.
 *
 * Настройки в привычных почтовых интерфейсах оформлены ИНАЧЕ, чем почта (docs/features-reference.md):
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
import { useLabelsState } from '../mail/useLabels';
import { useTemplatesState } from '../mail/useTemplates';
import { useDisposable } from './disposableQueries';
import { useAccessLog, useExports, useRecovery } from './ownerQueries';
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
  { to: '/settings/notifications', title: 'Уведомления' },
  { to: '/settings/appearance', title: 'Оформление' },
  { to: '/settings/filters', title: 'Фильтры' },
  { to: '/settings/folders', title: 'Папки' },
  { to: '/settings/collector', title: 'Почта с других ящиков' },
];

/**
 * Метки стоят рядом с папками намеренно: это второй способ разложить почту,
 * и человек ищет их там же, где искал бы папку. Пункт условный — см. ниже.
 */
const LABELS_ITEM: NavItem = { to: '/settings/labels', title: 'Метки' };
const LABELS_AFTER = '/settings/folders';

/**
 * Шаблоны стоят сразу за «Общими» — там же, где живут подписи, с которыми
 * у них одна работа: заготовленный кусок письма. Пункт условный по тому же
 * правилу, что и метки: нет хранилища на сервере — нет и раздела.
 */
const TEMPLATES_ITEM: NavItem = { to: '/settings/templates', title: 'Шаблоны писем' };
const TEMPLATES_AFTER = '/settings/general';

/**
 * «Восстановление писем» стоит сразу за папками: очищают корзину именно
 * там, и возвращать очищенное человек идёт туда же, где очищал.
 */
const RECOVERY_ITEM: NavItem = { to: '/settings/recovery', title: 'Восстановление писем' };
const RECOVERY_AFTER = '/settings/folders';

/**
 * «Вход и действия» и «Выгрузка ящика» стоят последними и вместе: оба про
 * ящик целиком, а не про то, как он выглядит и как раскладывает почту.
 * в привычных почтовых интерфейсах «Лог действий» лежит там же — в самом низу списка.
 */
const ACCESS_ITEM: NavItem = { to: '/settings/access-log', title: 'Вход и действия' };
const EXPORT_ITEM: NavItem = { to: '/settings/export', title: 'Выгрузка ящика' };

/**
 * «Одноразовые адреса» стоят сразу за «Почтой с других ящиков»: оба пункта
 * про АДРЕСА, с которых и на которые ходит почта, а не про то, как она
 * раскладывается по папкам. в привычных почтовых интерфейсах «Анонимайзер» лежит там же — рядом с
 * настройками сбора почты, а не среди правил.
 */
const DISPOSABLE_ITEM: NavItem = { to: '/settings/disposable', title: 'Одноразовые адреса' };
const DISPOSABLE_AFTER = '/settings/collector';

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
  const labels = useLabelsState();
  const templates = useTemplatesState();
  const access = useAccessLog();
  const exports = useExports();
  const recovery = useRecovery();
  const disposable = useDisposable();

  /*
   * Разделы, которых может не быть.
   *
   * Помощника нет в списке, пока администратор его не разрешил, — это
   * работало и раньше. Метки жили в списке всегда, хотя своё правило у них
   * записано там же, где хук: «пока сервер не сказал available, ни раздела
   * настроек, ни пункта „Метки“ в меню не появляется». Правило не
   * выполнялось: на сервере без применённой миграции (и на заглушечных
   * данных) пункт вёл на страницу, которая умеет сказать только «метки
   * недоступны».
   */
  const withLabels = labels.available
    ? NAV.flatMap((item) => (item.to === LABELS_AFTER ? [item, LABELS_ITEM] : [item]))
    : NAV;
  const withTemplates = templates.available
    ? withLabels.flatMap((item) => (item.to === TEMPLATES_AFTER ? [item, TEMPLATES_ITEM] : [item]))
    : withLabels;
  /*
   * Три раздела владельца ящика — по тому же правилу, что метки и шаблоны:
   * пока сервер не сказал `available`, пункта в меню нет. Ему есть чего не
   * сказать: у каждого своя миграция, а выгрузке нужен ещё и служебный
   * доступ к почтовому хранилищу. Пункт, ведущий на страницу «раздел
   * недоступен», — это кнопка без поведения.
   */
  const withRecovery = recovery.available
    ? withTemplates.flatMap((item) => (item.to === RECOVERY_AFTER ? [item, RECOVERY_ITEM] : [item]))
    : withTemplates;
  /*
   * Одноразовые адреса — по тому же правилу: нет применённой миграции
   * 0028 (или базы вовсе) — нет и пункта. Раздел, который умеет сказать
   * только «недоступно», в меню не показывается.
   */
  const withDisposable = disposable.available
    ? withRecovery.flatMap((item) =>
        item.to === DISPOSABLE_AFTER ? [item, DISPOSABLE_ITEM] : [item],
      )
    : withRecovery;
  const withOwner = [
    ...withDisposable,
    ...(access.available ? [ACCESS_ITEM] : []),
    ...(exports.available ? [EXPORT_ITEM] : []),
  ];
  const nav = aiVisible(aiState)
    ? [...withOwner, { to: AI_SETTINGS_PATH, title: 'Помощник на основе ИИ' }]
    : withOwner;

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
          как `/settings` в привычных почтовых интерфейсах (эталонные снимки интерфейса). Общей
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
