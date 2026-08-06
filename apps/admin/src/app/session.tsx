/**
 * Текущая админская сессия: загрузка при старте, вход, выход.
 * Держим в контексте, чтобы права были доступны любому компоненту.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from '../api/client';
import type { AdminSession, Permission } from '../api/types';
import { adoptServerTheme, forgetAdminTheme } from '../appearance/themeStore';
import { can as hasPermission } from '../lib/access';

interface SessionState {
  session: AdminSession | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Есть ли право у текущей сессии (для показа кнопок). */
  can: (permission: Permission) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.session();
      setSession(fresh);
      /*
       * Оформление принадлежит учётной записи, а не браузеру: до ответа
       * панель покрашена по кэшу, а здесь — по тому, что помнит сервер.
       * Если за тем же компьютером вошёл другой администратор, кэш чужой,
       * и adoptServerTheme его не примет.
       */
      adoptServerTheme(fresh.login, fresh.theme ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) setSession(null);
      else setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (loginName: string, password: string) => {
      await api.login(loginName, password);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setSession(null);
    // Кэш темы уходит вместе с сеансом: следующий администратор за этим
    // компьютером обязан увидеть СВОЮ расцветку, а не расцветку предыдущего.
    forgetAdminTheme();
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      session,
      loading,
      login,
      logout,
      refresh,
      can: (permission) => hasPermission(session?.permissions, permission),
    }),
    [session, loading, login, logout, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession вызван вне SessionProvider');
  return ctx;
}
