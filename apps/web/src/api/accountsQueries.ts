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
  ExternalSendRequest,
  ExternalSendResponse,
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

/**
 * Один вариант в поле «От кого».
 *
 * `externalId: null` — наш собственный ящик: письмо уходит обычным путём,
 * с отменой отправки, отложенной отправкой и копией в «Отправленных».
 * Число — подключённый чужой адрес: письмо уйдёт через ЕГО SMTP.
 */
export interface SenderOption {
  address: string;
  label: string | null;
  externalId: number | null;
}

/**
 * Адреса, с которых можно отправить письмо из текущей сессии.
 *
 * Так же устроено «От кого» в mail.ru: свой адрес и подключённые чужие
 * ящики в одном списке. Чужой адрес попадает сюда, только если у него
 * задан SMTP: без него отправлять не с чего, и предлагать выбор, который
 * закончится отказом, — обман.
 *
 * Связанные СВОИ ящики (`linked`) сюда намеренно не входят: у них своя
 * сессия, и отправка из чужой сессии обошла бы проверку пароля. В mail.ru
 * это тоже разные вещи — переключение ящика и выбор отправителя.
 */
export function useSenders(): SenderOption[] {
  const { data } = useAccounts();
  if (!data) return [];
  const own: SenderOption = { address: data.current, label: null, externalId: null };
  const external = data.external
    .filter((a) => a.enabled && a.smtp !== null)
    .map((a) => ({ address: a.address, label: a.label, externalId: a.id }));
  return [own, ...external];
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

export interface ExternalSendVariables {
  id: number;
  request: ExternalSendRequest;
}

/**
 * Отправка с подключённого чужого адреса.
 *
 * Список писем НЕ сбрасываем: копия уходит в «Отправленные» ЧУЖОГО ящика,
 * в нашем ничего не меняется. Обновление здесь только создавало бы
 * впечатление, что письмо появилось у нас.
 */
export function useSendAsExternal(): UseMutationResult<
  ExternalSendResponse,
  unknown,
  ExternalSendVariables
> {
  return useMutation({
    mutationFn: ({ id, request }: ExternalSendVariables) => accountsApi.sendAsExternal(id, request),
  });
}
