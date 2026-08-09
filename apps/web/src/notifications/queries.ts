/** Хуки @tanstack/react-query для раздела уведомлений. */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { browserClientId, notificationsApi } from './api';
import type { NotificationPrefsPatch, PushState } from './types';

export const notificationKeys = {
  state: ['notifications', 'state'] as const,
};

/**
 * Сообщает Service Worker, чей это браузер.
 *
 * Работник сверяет отпечаток с тем, что приехало внутри push, и не
 * показывает чужую тему на общем компьютере, где сессия предыдущего
 * человека истекла. Делается местно, без сети: «класть содержимое в
 * push» затевалось ровно для случая, когда до сервера не достучаться.
 *
 * Отказ здесь ничего не ломает: без отпечатка работник спросит сервер, а
 * не сможет — покажет безымянное «Новое письмо».
 */
function tellWorker(accountKey: string): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) => {
      registration.active?.postMessage({ type: 'mt-own-key', key: accountKey });
    })
    .catch(() => undefined);
}

export function usePushState(): UseQueryResult<PushState> {
  return useQuery({
    queryKey: notificationKeys.state,
    queryFn: async () => {
      const state = await notificationsApi.getState(browserClientId());
      tellWorker(state.accountKey);
      return state;
    },
    // Состояние раздела меняется от действий человека в этой же вкладке,
    // а не само по себе: перезапрашивать его по возвращению фокуса незачем.
    refetchOnWindowFocus: false,
  });
}

export function useSaveNotificationPrefs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: NotificationPrefsPatch) => notificationsApi.savePrefs(patch),
    // Ответ сервера кладём прямо в кэш: он единственный знает, что
    // на самом деле записалось (значения могли нормализоваться).
    onSuccess: (prefs) => {
      client.setQueryData<PushState>(notificationKeys.state, (previous) =>
        previous ? { ...previous, prefs } : previous,
      );
    },
  });
}

/** Обновить состояние целиком — после подписки или отписки. */
export function useRefreshPushState(): () => void {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: notificationKeys.state });
}
