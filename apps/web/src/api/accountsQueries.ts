/** Хуки @tanstack/react-query поверх клиента «Ящиков». */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { accountsApi } from './index';
import type {
  AccountsOverview,
  LinkedListResponse,
  UnreadEntry,
  UnreadReport,
} from './accountsTypes';
import { useFolders } from './queries';

export const accountsKeys = {
  /** Список ящиков. */
  all: ['accounts'] as const,
  /** Счётчик непрочитанных по всем ящикам. */
  unread: ['accounts', 'unread'] as const,
};

export function useAccounts(): UseQueryResult<AccountsOverview> {
  return useQuery({ queryKey: accountsKeys.all, queryFn: () => accountsApi.getAccounts() });
}

/**
 * Непрочитанные по всем ящикам.
 *
 * Сервер ради этого ответа ходит IMAP-ом в каждый ящик, поэтому запрос
 * не должен повторяться на каждый чих: обновляем раз в минуту и по
 * событию о новом письме (см. `app/session.tsx`).
 */
export function useAccountsUnread(): UseQueryResult<UnreadReport> {
  return useQuery({
    queryKey: accountsKeys.unread,
    queryFn: () => accountsApi.getUnread(),
    staleTime: 60_000,
  });
}

/** Непрочитанные по всем ящикам — одним числом и по строкам. */
export interface UnreadTotal {
  total: number;
  byAccount: UnreadEntry[];
}

/**
 * ЕДИНСТВЕННЫЙ источник числа непрочитанных для шапки и заголовка вкладки.
 *
 * Пока ответ /api/accounts/unread не пришёл (или раздел ящиков на сервере
 * не поднят — тогда запрос отказывает), показываем непрочитанные текущего
 * ящика из уже загруженных папок. Иначе счётчик на секунду пропадал бы, а
 * на сервере без миграции ящиков исчезал бы совсем.
 */
export function useUnreadTotal(): UnreadTotal {
  const { data } = useAccountsUnread();
  const { data: folders } = useFolders();
  if (data) return { total: data.total, byAccount: data.accounts };
  const inbox = folders?.find((f) => f.role === 'inbox')?.unreadCount ?? 0;
  return { total: inbox, byAccount: [] };
}

/** После связывания и отвязки список ящиков и счётчики перечитываем. */
function useInvalidateAccounts() {
  const client = useQueryClient();
  // Ключ счётчика начинается с 'accounts', поэтому один сброс задевает оба.
  return () => void client.invalidateQueries({ queryKey: accountsKeys.all });
}

export interface LinkAccountVariables {
  email: string;
  password: string;
  label?: string | null;
}

export function useLinkAccount(): UseMutationResult<
  LinkedListResponse,
  unknown,
  LinkAccountVariables
> {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: ({ email, password, label }: LinkAccountVariables) =>
      accountsApi.linkAccount(email, password, label ?? null),
    onSuccess: invalidate,
  });
}

export function useUnlinkAccount(): UseMutationResult<LinkedListResponse, unknown, string> {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (email: string) => accountsApi.unlinkAccount(email),
    onSuccess: invalidate,
  });
}
