/** Хуки @tanstack/react-query для раздела уведомлений. */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { browserClientId, notificationsApi } from './api';
import type { NotificationPrefsPatch, PushState } from './types';

export const notificationKeys = {
  state: ['notifications', 'state'] as const,
};

export function usePushState(): UseQueryResult<PushState> {
  return useQuery({
    queryKey: notificationKeys.state,
    queryFn: () => notificationsApi.getState(browserClientId()),
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
