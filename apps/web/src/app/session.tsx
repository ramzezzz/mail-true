/**
 * Текущая сессия ящика: загрузка при старте, вход, выход, реакция на 401.
 *
 * Раньше в почте не было ни экрана входа, ни кнопки «Выйти», а ответ 401
 * никто не перехватывал: пользователь с истёкшей сессией видел пустое меню
 * и невнятную ошибку вместо просьбы войти. Устройство повторяет админку
 * (`apps/admin/src/app/session.tsx`) — одинаковые вещи должны работать
 * одинаково.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { accountsApi, api } from '../api';
import { accountsKeys } from '../api/accountsQueries';
import { setUnauthorizedHandler } from '../api/http';
import type { SessionInfo } from '../api/types';
import { forgetAppearance, syncAppearance } from '../appearance/sync';
import { disablePush } from '../notifications/subscribe';
import { publishMailEvent } from './mailEvents';
import { useUiStore } from './store';

interface SessionState {
  session: SessionInfo | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  /** Переключиться на связанный ящик: сервер выдаёт новую сессию. */
  switchMailbox(email: string): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();
  /*
   * Чей это был сеанс. Переживает обрыв сессии — в отличие от session,
   * который обнуляется на первом же 401. Нужен, чтобы при следующем входе
   * отличить «тот же человек вернулся» от «сел другой».
   */
  const lastAccount = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const info = await api.getSession();
      setSession(info.authenticated ? info : null);
      /*
       * Оформление принадлежит УЧЁТНОЙ ЗАПИСИ, а не браузеру (требование
       * заказчика: «тема оформления должна запоминаться для каждого
       * юзера»). Здесь — единственное место, где почта узнаёт, чей это
       * сеанс: и при старте, и при входе, и при смене ящика всё сходится
       * в refresh. Ошибок наружу не выбрасывает, ответа не ждём —
       * тема из кэша уже применена в main.tsx.
       */
      if (info.authenticated) void syncAppearance(info.email);
    } catch {
      // 401 здесь — обычное дело: просто ещё не вошли
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Любой 401 в любом запросе означает, что сессии больше нет
  useEffect(
    () =>
      setUnauthorizedHandler(() => {
        setSession(null);
        setLoading(false);
      }),
    [],
  );

  /**
   * Живые обновления подключаем только при живой сессии: WebSocket сервера
   * тоже требует входа, и без сессии переподключение било бы в закрытую
   * дверь. Отписка при выходе закрывает сокет и прекращает попытки.
   */
  useEffect(() => {
    if (!session) return;
    return api.subscribe((event) => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      // Общий счётчик по ящикам живёт своей жизнью (сервер ради него ходит
      // IMAP-ом в каждый ящик), поэтому его тоже надо освежить.
      void queryClient.invalidateQueries({ queryKey: accountsKeys.unread });
      // Событие раздаём дальше: на нём живут уведомления о новой почте.
      publishMailEvent(event);
    });
  }, [session, queryClient]);

  const login = useCallback(
    async (email: string, password: string) => {
      const info = await api.login(email, password);
      setSession(info);
      // Данные прошлого ящика новому владельцу сессии не показываем
      queryClient.clear();
      /*
       * ОКНА НАПИСАНИЯ ОТ ПРЕЖНЕГО ЯЩИКА ЗАКРЫВАЕМ ЗДЕСЬ.
       *
       * Выход и смена ящика это уже делали, а третий путь — «сессия
       * отвалилась сама» — оставался открытым. Отваливается она обычно:
       * истёк срок, перезапустили сервер, администратор закрыл сессии.
       * Любой 401 просто уводит на страницу входа, а окна написания живут
       * ВНЕ кэша запросов, в хранилище на уровне модуля, и размонтирование
       * страницы их не трогает.
       *
       * Дальше на общем компьютере вошедший следующим видел чужое
       * недописанное письмо — с адресатами, темой и телом, — и «Отправить»
       * ушло бы уже от ЕГО адреса, а «Сохранить» — в его черновики.
       *
       * Закрываем именно при входе ПОД ДРУГИМ адресом, а не в обработчике
       * 401: тот же человек, у которого просто истёк срок, войдёт заново и
       * допишет своё письмо. Закрыть окна там значило бы чинить утечку
       * ценой потери работы — а это тот же дефект, только с другой
       * стороны.
       */
      const previous = lastAccount.current;
      lastAccount.current = info.email;
      if (previous !== null && previous !== info.email) {
        useUiStore.getState().closeAllCompose();
        forgetAppearance();
      }
      await refresh();
    },
    [refresh, queryClient],
  );

  const logout = useCallback(async () => {
    /*
     * Подписка на уведомления снимается ПЕРВОЙ, пока сессия ещё жива.
     *
     * Без этого выход её не трогал вовсе, а наблюдатель на сервере видел
     * живую подписку и продолжал работать ещё сутки — с паролем вышедшего
     * человека в памяти. На общем компьютере это значило, что посторонний
     * до суток получает уведомления о чужих новых письмах, а при
     * включённом «класть содержимое в push» — прямо с темой и
     * отправителем: показывает их Service Worker, ни о чём не спрашивая
     * сервер.
     */
    await disablePush().catch(() => undefined);
    await api.logout().catch(() => undefined);
    setSession(null);
    queryClient.clear();
    /*
     * Окна написания живут ВНЕ кэша запросов, поэтому clear() их не
     * трогает, а сам компонент монтируется заново для любой сессии. На
     * общем компьютере следующий вошедший видел недописанное письмо
     * предыдущего — с адресатами и текстом.
     */
    useUiStore.getState().closeAllCompose();
    // Тема и фон — такие же данные ящика, как письма: оставить их
    // следующему нельзя. На общем компьютере вошедший после увидел бы
    // оформление предыдущего (см. appearance/sync.ts).
    forgetAppearance();
  }, [queryClient]);

  /**
   * Переключение на связанный ящик.
   *
   * Живёт здесь, рядом со входом и выходом, по одной причине: смена ящика —
   * это смена сессии, а значит и всего кэша запросов. Разложи её по
   * компонентам — и рано или поздно найдётся путь, где кэш не почистили, и
   * под новым адресом в шапке висели бы письма, папки и настройки прежнего
   * ящика. `queryClient.clear()` делает это ровно так же, как при входе.
   */
  const switchMailbox = useCallback(
    async (email: string) => {
      const result = await accountsApi.switchAccount(email);
      queryClient.clear();
      /*
       * И окна написания — по той же причине, что кэш. Оставшееся окно
       * отправило бы письмо уже от НОВОГО адреса, а «Сохранить» ушло бы в
       * черновики нового ящика по номеру, под которым там лежит совсем
       * другое письмо.
       */
      useUiStore.getState().closeAllCompose();
      setSession({ authenticated: true, email: result.email });
      await refresh();
    },
    [queryClient, refresh],
  );

  const value = useMemo<SessionState>(
    () => ({ session, loading, login, logout, refresh, switchMailbox }),
    [session, loading, login, logout, refresh, switchMailbox],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession вызван вне SessionProvider');
  return ctx;
}
