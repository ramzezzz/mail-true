/**
 * Хуки «отложить письмо до срока».
 *
 * Состояние возможности спрашивается у сервера ОДИН раз и до всего
 * остального: пока он не сказал `available`, кнопки «Отложить» в почте
 * не появляется вовсе. Это общее правило продукта — кнопка появляется
 * вместе с поведением, — и здесь оно особенно уместно: без базы или без
 * служебного доступа Dovecot откладывание либо невозможно, либо
 * возвращает письма только вручную, и обещать человеку не то, что будет,
 * нельзя.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queries';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import {
  SNOOZE_UNAVAILABLE,
  formatWakeAt,
  snoozeApi,
  type SnoozeRequest,
  type SnoozedState,
} from './snoozeApi';

export const snoozeQueryKey = ['messages', 'snoozed'] as const;

/**
 * Состояние возможности и содержимое «Отложенных».
 *
 * Пока ответа нет — и если запрос не удался — считается, что возможности
 * нет: кнопка «Отложить» не появляется. Это правильный порядок ошибки.
 * Кнопка, за которой ничего не стоит, — ровно та мёртвая кнопка, от
 * которых продукт избавляется; отсутствие кнопки хотя бы честно.
 * Повторов нет намеренно (`retry: false`): раздел не настолько важен,
 * чтобы трижды стучаться в лежащий сервер.
 */
export function useSnoozeState(): SnoozedState {
  const query = useQuery({
    queryKey: snoozeQueryKey,
    queryFn: () => snoozeApi.fetchSnoozed(),
    // Список «Отложенных» меняется сам собой — работник сервера в срок
    // вынимает оттуда письма. Держать его свежим дольше минуты значит
    // показывать письмо, которое уже вернулось.
    staleTime: 60_000,
    retry: false,
  });
  return query.data ?? SNOOZE_UNAVAILABLE;
}

/** После откладывания и возврата меняются: список папки, счётчики, «Отложенные». */
function useInvalidate(): () => void {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['messages'] });
    void client.invalidateQueries({ queryKey: queryKeys.folders });
  };
}

export function useSnoozeMessages() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation({
    mutationFn: (request: SnoozeRequest) => snoozeApi.snoozeMessages(request),
    onSuccess: (result, request) => {
      invalidate();
      /*
       * Подтверждение обязательно, и в нём обязателен ЧАС.
       *
       * Письмо исчезает из списка — со стороны это неотличимо от удаления.
       * Человек должен сразу узнать, что оно вернётся и когда именно.
       * Время берётся из ответа СЕРВЕРА (он его и считал), а не считается
       * здесь заново: два расчёта одного и того же разъедутся, и человек
       * увидит один час, а письмо приедет в другой.
       */
      const when = formatWakeAt(result.wakeAt);
      const count = request.ids.length;
      showNotice(
        count > 1
          ? `Письма (${String(count)}) вернутся ${when}`
          : `Письмо вернётся ${when}`,
      );
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось отложить письмо', error)),
  });
}

export function useUnsnoozeMessages() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation({
    mutationFn: (ids: string[]) => snoozeApi.unsnoozeMessages(ids),
    onSuccess: (result) => {
      invalidate();
      showNotice(
        result.returned > 1
          ? `Письма (${String(result.returned)}) вернулись во «Входящие»`
          : 'Письмо вернулось на место',
      );
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось вернуть письмо', error)),
  });
}
