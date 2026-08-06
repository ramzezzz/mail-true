/** Каркас админки: шапка с текущим администратором, меню по правам, содержимое. */
import { useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button, Spinner } from '@web/components';
import { cx } from '@web/lib/cx';
import { visibleNav, type NavItem } from '../lib/access';
import { breadcrumbsFor } from '../lib/breadcrumbs';
import { useSession } from './session';
import { ThemeMenu } from './ThemeMenu';
import styles from './AdminLayout.module.css';

export function AdminLayout() {
  const { session, logout } = useSession();
  const items = visibleNav(session?.permissions);

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand} aria-label="Mail.True — панель управления">
          {/* Три начертания вместо выбора в коде: тему задаёт data-theme на
              корне, ширину — медиазапрос, и CSS сам показывает нужное. Так
              логотип не мигает при смене темы и не зависит от порядка
              отрисовки. На узком экране полное написание уступает знаку. */}
          <img className={styles.brandLogoLight} src="/brand/logo-full.svg" alt="" />
          <img className={styles.brandLogoDark} src="/brand/logo-full-dark.svg" alt="" />
          <img className={styles.brandMark} src="/brand/mark.svg" alt="" />
          <span className={styles.brandKicker}>Панель управления</span>
        </Link>

        <span className={styles.spacer} />

        {/* Смена оформления — на виду, а не закопана в настройки: тему
            меняют, увидев экран, а не разыскав раздел */}
        <ThemeMenu className={styles.theme} />

        <div className={styles.account}>
          <span className={styles.accountAvatar} aria-hidden="true">
            {session?.login?.slice(0, 1) ?? '?'}
          </span>
          <span className={styles.accountText}>
            <span className={styles.accountLogin}>{session?.login}</span>
            <span className={styles.accountRole}>{session?.roleLabel}</span>
          </span>
        </div>
        <span className={styles.headerSep} aria-hidden="true" />
        <Button mode="secondary" size="s" className={styles.logout} onClick={() => void logout()}>
          Выйти
        </Button>
      </header>

      <SidebarNav items={items} />

      <main className={styles.content}>
        <Breadcrumbs />
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Левое меню. Выделение активного пункта рисует не сам пункт, а одна общая
 * подложка: она переезжает на новое место переходом transform, поэтому смена
 * раздела читается как сдвиг, а не как мигание двух прямоугольников.
 *
 * Положение снимается с живого DOM обеими координатами: до 720px меню
 * ложится под шапку горизонтальной лентой, и там выделение едет вбок.
 */
interface PointerBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function SidebarNav({ items }: { items: readonly NavItem[] }) {
  const navRef = useRef<HTMLElement>(null);
  const [pointer, setPointer] = useState<PointerBox | null>(null);
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const measure = (): void => {
      const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
      // Пункта нет (роль без прав на текущий раздел) — подложку прячем
      setPointer(
        active
          ? {
              left: active.offsetLeft,
              top: active.offsetTop,
              width: active.offsetWidth,
              height: active.offsetHeight,
            }
          : null,
      );
    };

    measure();
    // Ширина колонки меняет и размеры пунктов, и раскладку ленты на узком экране
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname, items]);

  return (
    <nav ref={navRef} className={styles.sidebar}>
      {pointer && (
        <span
          className={styles.navPointer}
          aria-hidden="true"
          style={{
            transform: `translate(${pointer.left}px, ${pointer.top}px)`,
            width: pointer.width,
            height: pointer.height,
          }}
        />
      )}
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) => cx(styles.navLink, isActive && styles.navLinkActive)}
        >
          <span>{item.title}</span>
          {item.stub && <span className={styles.navStub}>скоро</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/** Цепочка «где я и куда вернуться». На «Дашборде» не показывается. */
export function Breadcrumbs() {
  const { pathname } = useLocation();
  const crumbs = breadcrumbsFor(pathname);
  if (crumbs.length === 0) return null;

  return (
    <nav className={styles.crumbs} aria-label="Хлебные крошки">
      <ol className={styles.crumbsList}>
        {crumbs.map((crumb, index) => (
          <li key={crumb.to ?? crumb.title} className={styles.crumb}>
            {index > 0 && (
              <span className={styles.crumbSep} aria-hidden="true">
                /
              </span>
            )}
            {crumb.to === undefined ? (
              // Текущая страница ссылкой не делается: щелчок по ней никуда
              // не ведёт и только сбивает с толку.
              <span className={styles.crumbCurrent} aria-current="page">
                {crumb.title}
              </span>
            ) : (
              <Link to={crumb.to}>{crumb.title}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h1 className={styles.pageTitle}>{title}</h1>
      {subtitle && <p className={styles.pageSubtitle}>{subtitle}</p>}
    </>
  );
}

export function CenteredSpinner() {
  return (
    <div className={styles.center}>
      <Spinner size={32} />
    </div>
  );
}

export const layoutStyles = styles;
