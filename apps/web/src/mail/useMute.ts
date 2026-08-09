/**
 * Хуки «заглушить цепочку».
 *
 * Состояние возможности спрашивается у сервера до всего остального: пока
 * он не сказал `available` И `delivery`, кнопки «Заглушить» в почте не
 * появляется вовсе. Второе условие здесь не менее важно первого — заглушка,
 * которая не работает при доставке, обещает человеку то, чего не будет.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queries';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import { MUTE_UNAVAILABLE, muteApi, type MutedState } from './muteApi';

export const mutedQueryKey = ['threads', 'muted'] as const;

/**
 * Состояние возможности и подборка «Заглушённые».
 *
 * Пока ответа нет — и если запрос не удался — считается, что возможности
 * нет. Это правильный порядок ошибки: кнопка, за которой ничего не стоит,
 * хуже отсутствующей кнопки.
 */
export function useMutedState(): MutedState {
  const query = useQuery({
    queryKey: mutedQueryKey,
    queryFn: () => muteApi.fetchMuted(),
    // Список меняет только сам человек — держать его свежим полчаса
    // безопасно и заметно дешевле.
    staleTime: 30 * 60_000,
    retry: false,
  });
  return query.data ?? MUTE_UNAVAILABLE;
}

/**
 * После заглушения меняются: список папки (письма уехали), счётчики папок
 * и сама подборка.
 */
function useInvalidate(): () => void {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['messages'] });
    void client.invalidateQueries({ queryKey: queryKeys.folders });
    void client.invalidateQueries({ queryKey: mutedQueryKey });
  };
}

export function useMuteThreads() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation({
    mutationFn: (ids: string[]) => muteApi.mute(ids),
    onSuccess: (result) => {
      invalidate();
      /*
       * Подтверждение обязательно и обязано сказать, КУДА делись письма:
       * они исчезают из списка, а со стороны это неотличимо от удаления.
       *
       * И отдельно — про доставку. Если сервер сказал, что правило не
       * записалось, человек обязан узнать об этом СРАЗУ, а не через неделю
       * по продолжающим приходить письмам.
       */
      if (result.deliveryError) {
        showNotice(
          `Переписка заглушена, но правило доставки не записалось: ${result.deliveryError}`,
        );
        return;
      }
      const threads = result.muted;
      showNotice(
        threads > 1
          ? `Заглушено переписок: ${String(threads)}. Продолжение уйдёт в «Заглушённые»`
          : 'Переписка заглушена: продолжение уйдёт в «Заглушённые»',
      );
    },
    onError: (error: unknown) =>
      showNotice(actionErrorText('Не удалось заглушить переписку', error)),
  });
}

export function useUnmuteThreads() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation({
    /*
     * Принимаем ПИСЬМА, а не ключи: кнопка обещает «снять заглушку с
     * переписок выделенных писем», и снимать надо ровно их. Ключи всей
     * подборки, которые браузер подставлял раньше, возвращали во
     * «Входящие» всё сразу.
     */
    mutationFn: (ids: string[]) => muteApi.unmuteByMessages(ids),
    onSuccess: (result) => {
      invalidate();
      // Про уже пришедшее сказано прямо: оно остаётся в «Заглушённых»,
      // и человек не должен искать его во «Входящих».
      showNotice(
        result.lifted > 1
          ? `Заглушка снята с переписок: ${String(result.lifted)}. Новые письма снова пойдут во «Входящие»`
          : 'Заглушка снята: новые письма снова пойдут во «Входящие»',
      );
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось снять заглушку', error)),
  });
}
