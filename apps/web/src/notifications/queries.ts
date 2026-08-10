/** Хуки @tanstack/react-query для раздела уведомлений. */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { browserClientId, notificationsApi } from './api';
import { announceOwnKeyRaw } from './ownKey';
import type { NotificationPrefsPatch, PushState } from './types';

export const notificationKeys = {
  state: ['notifications', 'state'] as const,
};

/**
 * Сообщает Service Worker, чей это браузер.
 *
 * Тот же отпечаток, что сообщается при входе, выходе и смене ящика (см.
 * notifications/ownKey.ts) — здесь он берётся прямо из ответа сервера,
 * потому что ответ уже на руках. Отправитель общий: `serviceWorker.ready`
 * у незарегистрированного работника не разрешается никогда, и своя копия
 * этого вызова означала бы второе место, где можно на нём повиснуть.
 */
function tellWorker(accountKey: string): void {
  void announceOwnKeyRaw(accountKey);
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
    /*
     * Отказ обязан быть виден.
     *
     * Переключатели на странице берут состояние из кэша, а кэш меняется
     * только в onSuccess. Значит при неудачной записи флажок просто не
     * двигался — ни сообщения, ни движения: человек щёлкает, ничего не
     * происходит, и он не знает, сохранилось ли хоть что-то. Ответ
     * сервера перечитываем, чтобы на экране было то, что в базе.
     */
    onError: () => {
      void client.invalidateQueries({ queryKey: notificationKeys.state });
    },
  });
}

/** Обновить состояние целиком — после подписки или отписки. */
export function useRefreshPushState(): () => void {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: notificationKeys.state });
}
