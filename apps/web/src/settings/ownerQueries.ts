/**
 * Хуки трёх разделов владельца ящика.
 *
 * Повторов при отказе нет (`retry: false`) ни у одного: разделы не
 * настолько важны, чтобы трижды стучаться в лежащий сервер, а до ответа
 * интерфейс их просто не показывает — то же правило, что у меток.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCESS_UNAVAILABLE,
  EXPORT_UNAVAILABLE,
  RECOVERY_UNAVAILABLE,
  isExportLive,
  ownerApi,
  type AccessLogState,
  type ExportPageState,
  type RecoveryPageState,
} from './ownerApi';

export const ownerKeys = {
  access: ['owner', 'access-log'] as const,
  exports: ['owner', 'exports'] as const,
  recovery: ['owner', 'recovery'] as const,
};

/* --- Вход и действия --------------------------------------------------- */

export function useAccessLog(): AccessLogState & { loading: boolean } {
  const query = useQuery({
    queryKey: ownerKeys.access,
    queryFn: () => ownerApi.getAccessLog(),
    // История — не то, что должно жить в кэше долго: человек открывает
    // раздел именно чтобы увидеть, что было ТОЛЬКО ЧТО.
    staleTime: 15_000,
    retry: false,
  });
  return { ...(query.data ?? ACCESS_UNAVAILABLE), loading: query.isLoading };
}

/* --- Выгрузка ящика ---------------------------------------------------- */

/**
 * Состояние выгрузок с опросом на время работы.
 *
 * Опрос включается ТОЛЬКО когда есть живое задание и гаснет сразу, как
 * оно закончилось. Постоянный опрос раз в две секунды на странице, где
 * обычно ничего не происходит, — это запрос к серверу каждые две секунды
 * у каждого открывшего настройки.
 *
 * Живых обновлений (WebSocket) здесь нарочно нет: канал занят почтой, а
 * выгрузку человек заказывает раз в год и смотрит на неё минуту.
 */
export function useExports(): ExportPageState & { loading: boolean } {
  const query = useQuery({
    queryKey: ownerKeys.exports,
    queryFn: () => ownerApi.getExports(),
    retry: false,
    refetchInterval: (q) => {
      const data = q.state.data as ExportPageState | undefined;
      return data?.jobs.some(isExportLive) ? 2_000 : false;
    },
  });
  return { ...(query.data ?? EXPORT_UNAVAILABLE), loading: query.isLoading };
}

function useInvalidateExports(): () => void {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: ownerKeys.exports });
}

export function useStartExport() {
  const invalidate = useInvalidateExports();
  return useMutation({
    mutationFn: (options: { includeSpam: boolean; includeTrash: boolean }) =>
      ownerApi.startExport(options),
    onSuccess: invalidate,
  });
}

export function useCancelExport() {
  const invalidate = useInvalidateExports();
  return useMutation({
    mutationFn: (id: number) => ownerApi.cancelExport(id),
    onSuccess: invalidate,
  });
}

/* --- Восстановление писем ---------------------------------------------- */

export function useRecovery(): RecoveryPageState & { loading: boolean } {
  const query = useQuery({
    queryKey: ownerKeys.recovery,
    queryFn: () => ownerApi.getRecovery(),
    retry: false,
  });
  return { ...(query.data ?? RECOVERY_UNAVAILABLE), loading: query.isLoading };
}

function useInvalidateRecovery(): () => void {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ownerKeys.recovery });
    /*
     * Письма и папки перечитываются вместе с разделом: восстановленное
     * письмо появляется в корзине, и её счётчик обязан это показать.
     * Без этого человек возвращал письмо и не находил его до перезагрузки
     * страницы — то есть считал, что возврат не сработал.
     */
    void client.invalidateQueries({ queryKey: ['folders'] });
    void client.invalidateQueries({ queryKey: ['messages'] });
  };
}

export function useSetRecoveryDays() {
  const invalidate = useInvalidateRecovery();
  return useMutation({
    mutationFn: (days: number) => ownerApi.setRecoveryDays(days),
    onSuccess: invalidate,
  });
}

export function useRestoreMessages() {
  const invalidate = useInvalidateRecovery();
  return useMutation({
    mutationFn: (ids: number[]) => ownerApi.restoreMessages(ids),
    onSuccess: invalidate,
  });
}

export function usePurgeMessages() {
  const invalidate = useInvalidateRecovery();
  return useMutation({
    mutationFn: (ids: number[] | 'all') => ownerApi.purgeMessages(ids),
    onSuccess: invalidate,
  });
}
