/**
 * Хуки раздела «Одноразовые адреса».
 *
 * Повторов при отказе нет (`retry: false`) — то же правило, что у прочих
 * разделов владельца ящика: до ответа сервера раздела просто нет, и
 * стучаться трижды в лежащий сервер незачем.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import {
  DISPOSABLE_UNAVAILABLE,
  disposableApi,
  type DisposableAlias,
  type DisposableDraft,
  type DisposableState,
} from './disposableApi';

export const disposableKey = ['owner', 'disposable'] as const;

export function useDisposable(): DisposableState & { loading: boolean } {
  const query = useQuery({
    queryKey: disposableKey,
    queryFn: () => disposableApi.getAliases(),
    /*
     * Сводка по журналу («сколько писем, кто писал») собирается на
     * сервере проходом по postfix.log, поэтому кэш держится ощутимо:
     * человек открывает раздел, чтобы выключить адрес, а не следить за
     * счётчиком в реальном времени.
     */
    staleTime: 60_000,
    retry: false,
  });
  return { ...(query.data ?? DISPOSABLE_UNAVAILABLE), loading: query.isLoading };
}

function useInvalidate() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: disposableKey });
}

export function useCreateDisposable() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<DisposableAlias, Error, DisposableDraft>({
    mutationFn: (draft) => disposableApi.createAlias(draft),
    onSuccess: (alias) => {
      invalidate();
      showNotice(`Адрес ${alias.address} заведён`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось завести адрес', error)),
  });
}

export function useSetDisposableActive() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<DisposableAlias, Error, { id: number; active: boolean }>({
    mutationFn: ({ id, active }) => disposableApi.setActive(id, active),
    onSuccess: (alias) => {
      invalidate();
      /*
       * Сообщение говорит, что теперь БУДЕТ с письмами, а не «готово».
       * Человек выключает адрес впервые в жизни и вправе знать, что
       * отправитель получит отказ, а не тишину.
       */
      showNotice(
        alias.active
          ? `Адрес ${alias.address} снова принимает почту`
          : `Адрес ${alias.address} выключен: письма на него больше не принимаются, отправитель получает отказ`,
      );
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось переключить адрес', error)),
  });
}

export function useSetDisposableNote() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<DisposableAlias, Error, { id: number; note: string }>({
    mutationFn: ({ id, note }) => disposableApi.setNote(id, note),
    onSuccess: () => invalidate(),
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось сохранить пометку', error)),
  });
}

export function useDeleteDisposable() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<{ ok: boolean }, Error, { id: number; address: string }>({
    mutationFn: ({ id }) => disposableApi.deleteAlias(id),
    onSuccess: (_data, { address }) => {
      invalidate();
      showNotice(`Адрес ${address} удалён — имя снова свободно`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось удалить адрес', error)),
  });
}
