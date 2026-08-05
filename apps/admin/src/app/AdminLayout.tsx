/** Каркас админки: шапка с текущим администратором, меню по правам, содержимое. */
import { NavLink, Outlet } from 'react-router-dom';
import { Button, Spinner } from '@web/components';
import { cx } from '@web/lib/cx';
import { visibleNav } from '../lib/access';
import { useSession } from './session';
import styles from './AdminLayout.module.css';

export function AdminLayout() {
  const { session, logout } = useSession();
  const items = visibleNav(session?.permissions);

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <span className={styles.brand}>
          Mail.True <span className={styles.brandMuted}>· администрирование</span>
        </span>
        <span className={styles.spacer} />
        <span className={styles.who}>
          <span className={styles.whoLogin}>{session?.login}</span>
          <span>· {session?.roleLabel}</span>
        </span>
        <Button mode="secondary" size="s" onClick={() => void logout()}>
          Выйти
        </Button>
      </header>

      <nav className={styles.sidebar}>
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

      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
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
