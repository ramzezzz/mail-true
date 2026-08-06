/**
 * Хуки «напомнить, если не ответили».
 *
 * Пока сервер не сказал `available` И `scheduledCheck`, кнопки не
 * появляется вовсе: срок, который некому проверить, — это обещание,
 * которого не будет.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queries';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import {
  AWAIT_UNAVAILABLE,
  awaitReplyApi,
  type AwaitReplyRequest,
  type AwaitingState,
} from './awaitReplyApi';
import { formatWakeAt } from './snoozeApi';

export const awaitingQueryKey = ['messages', 'awaiting'] as const;

export function useAwaitingState(): AwaitingState {
  const query = useQuery({
    queryKey: awaitingQueryKey,
    queryFn: () => awaitReplyApi.fetchAwaiting(),
    // Подборка меняется сама собой: работник сервера закрывает записи,
    // на которые ответили. Дольше минуты держать её свежей — значит
    // показывать ожидание, которого уже нет.
    staleTime: 60_000,
    retry: false,
  });
  return query.data ?? AWAIT_UNAVAILABLE;
}

function useInvalidate(): () => void {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['messages'] });
    void client.invalidateQueries({ queryKey: ['message'] });
    void client.invalidateQueries({ queryKey: queryKeys.folders });
    void client.invalidateQueries({ queryKey: awaitingQueryKey });
  };
}

export function useAwaitReply() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation({
    mutationFn: (request: AwaitReplyRequest) => awaitReplyApi.wait(request),
    onSuccess: (result, request) => {
      invalidate();
      /*
       * В подтверждении обязательно «если не ответят» — иначе человек
       * прочтёт его как обычное напоминание и будет ждать письма в срок
       * независимо от ответа. Час берётся из ответа СЕРВЕРА: он его и
       * считал, а второй расчёт здесь разошёлся бы с первым.
       */
      const when = formatWakeAt(result.dueAt);
      const count = request.ids.length;
      showNotice(
        count > 1
          ? `Напомним ${when}, если на письма (${String(count)}) не ответят`
          : `Напомним ${when}, если не ответят`,
      );
    },
    onError: (error: unknown) =>
      showNotice(actionErrorText('Не удалось поставить ожидание ответа', error)),
  });
}

export function useCancelAwaitReply() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation({
    mutationFn: (ids: string[]) => awaitReplyApi.cancel(ids),
    onSuccess: () => {
      invalidate();
      showNotice('Больше не ждём ответа на это письмо');
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось отменить ожидание', error)),
  });
}
