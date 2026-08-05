/** Хуки @tanstack/react-query поверх клиента API. */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Account, Folder, MessageListQuery, MessageSummary } from '@mail-true/shared';
import { api } from './index';
import { MESSAGES_PAGE_SIZE } from './client';
import type {
  FlagsRequest,
  FlagsResponse,
  MessageFull,
  MessagesPage,
  MoveRequest,
  MoveResponse,
  SendRequest,
} from './types';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import { loadedCount, nextPageOffset, totalCount } from '../lib/paging';

export const queryKeys = {
  account: ['account'] as const,
  session: ['session'] as const,
  folders: ['folders'] as const,
  messages: (query: MessageListQuery) => ['messages', query] as const,
  /** Список папки целиком: страницы подгружаются под одним ключом. */
  messageList: (folderId: string, filter: string, threaded: boolean) =>
    ['messages', 'list', folderId, filter, threaded] as const,
  /**
   * Письмо с картинками и без — это два разных ответа сервера,
   * поэтому и ключи разные: иначе «Показать картинки» доставало бы
   * из кэша прежнее тело с прозрачными пикселями.
   */
  message: (id: string, images = false) => ['message', id, images] as const,
  /** Состояние помощника на основе ИИ — с него начинается весь его интерфейс. */
  aiState: ['ai', 'state'] as const,
  aiUsage: ['ai', 'usage'] as const,
  aiOutbound: (messageId: string) => ['ai', 'outbound', messageId] as const,
};

export function useAccount(): UseQueryResult<Account> {
  return useQuery({ queryKey: queryKeys.account, queryFn: () => api.getAccount() });
}

export function useFolders(): UseQueryResult<Folder[]> {
  return useQuery({ queryKey: queryKeys.folders, queryFn: () => api.getFolders() });
}

/**
 * Оставлять ли прежние данные, пока грузятся новые.
 *
 * Только если это тот же самый список: раньше `placeholderData: (prev) => prev`
 * отдавал данные ЛЮБОГО прошлого ключа, и при переходе в другую папку под
 * новым заголовком висели письма предыдущей — без скелетона, без единого
 * признака, что список ещё не тот.
 */
export function sameMessageList(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[],
): boolean {
  if (!previous) return false;
  const prevQuery = previous[1] as MessageListQuery | undefined;
  const nextQuery = next[1] as MessageListQuery | undefined;
  if (!prevQuery || !nextQuery) return false;
  return (
    prevQuery.folderId === nextQuery.folderId &&
    prevQuery.filter === nextQuery.filter &&
    prevQuery.search === nextQuery.search
  );
}

export function useMessages(query: MessageListQuery): UseQueryResult<MessagesPage> {
  const key = queryKeys.messages(query);
  return useQuery({
    queryKey: key,
    queryFn: () => api.getMessages(query),
    // не мигать при листании страниц — но только внутри одного списка
    placeholderData: (previous, previousQuery) =>
      sameMessageList(previousQuery?.queryKey, key) ? previous : undefined,
  });
}

/** Результат постраничной загрузки списка папки. */
export interface FolderMessages {
  items: MessageSummary[];
  /** Сколько всего писем подходит под запрос (`total` сервера). */
  total: number;
  loaded: number;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** Идёт перезапрос уже показанного списка (кнопка «Обновить» или жест). */
  isRefreshing: boolean;
  loadMore(): void;
  retry(): void;
  /**
   * Перезапросить список. В отличие от `retry` возвращает обещание: жест
   * «потянуть вниз» держит по нему крутилку до конца запроса, иначе она
   * мигала бы и пропадала, ничего не сообщив.
   */
  refresh(): Promise<unknown>;
}

/**
 * Письма папки со всеми подгруженными страницами.
 *
 * Раньше запрашивалась ровно одна страница (`offset: 0, limit: 100`), `total`
 * не использовался, подгрузки не было — в живом ящике на 187 писем восемьдесят
 * семь оказывались недостижимы вовсе.
 */
export function useFolderMessages(
  folderId: string,
  filter: MessageListQuery['filter'],
  threaded = false,
): FolderMessages {
  const result = useInfiniteQuery({
    queryKey: queryKeys.messageList(folderId, filter, threaded),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.getMessages({
        folderId,
        offset: pageParam,
        limit: MESSAGES_PAGE_SIZE,
        threaded,
        filter,
      }),
    getNextPageParam: (_last, pages) => nextPageOffset(pages),
  });

  const pages = result.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);

  return {
    items,
    total: pages.length > 0 ? totalCount(pages) : 0,
    loaded: loadedCount(pages),
    isPending: result.isPending,
    isError: result.isError,
    error: result.error,
    hasMore: Boolean(result.hasNextPage),
    isLoadingMore: result.isFetchingNextPage,
    isRefreshing: result.isFetching && !result.isPending && !result.isFetchingNextPage,
    loadMore: () => {
      if (result.hasNextPage && !result.isFetchingNextPage) void result.fetchNextPage();
    },
    retry: () => void result.refetch(),
    refresh: () => result.refetch(),
  };
}

/** Тот же ключ письма, но, возможно, с другим режимом картинок. */
export function sameMessage(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[],
): boolean {
  if (!previous) return false;
  return previous[0] === next[0] && previous[1] === next[1];
}

export function useMessage(
  id: string | undefined,
  options: { images?: boolean } = {},
): UseQueryResult<MessageFull> {
  const images = options.images ?? false;
  const key = queryKeys.message(id ?? '', images);
  return useQuery({
    queryKey: key,
    queryFn: () => api.getMessage(id!, { images }),
    enabled: Boolean(id),
    // «Показать картинки» — это перезапрос того же письма. Пока новый ответ
    // едет, показываем прежний: иначе письмо на секунду сменялось бы
    // спиннером на весь экран.
    placeholderData: (previous, previousQuery) =>
      sameMessage(previousQuery?.queryKey, key) ? previous : undefined,
  });
}

/** После любых изменений писем перечитываем списки и счётчики папок. */
function useInvalidateMail() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['messages'] });
    void client.invalidateQueries({ queryKey: queryKeys.folders });
  };
}

/**
 * Отказ мутации показываем поверх интерфейса.
 *
 * Ни у одной мутации обработчика отказа не было: не переместилось письмо —
 * тишина, не изменились пометки — тишина. Теперь любой отказ виден.
 */
function useNotifyFailure(action: string) {
  const showNotice = useUiStore((s) => s.showNotice);
  return (error: unknown) => showNotice(actionErrorText(action, error));
}

export function useSetFlags(): UseMutationResult<FlagsResponse, unknown, FlagsRequest> {
  const invalidate = useInvalidateMail();
  const onError = useNotifyFailure('Не удалось изменить пометки');
  return useMutation({
    mutationFn: (request: FlagsRequest) => api.setFlags(request),
    onSuccess: invalidate,
    onError,
  });
}

export function useMoveMessages(): UseMutationResult<MoveResponse, unknown, MoveRequest> {
  const invalidate = useInvalidateMail();
  const onError = useNotifyFailure('Не удалось переместить письма');
  return useMutation({
    mutationFn: (request: MoveRequest) => api.moveMessages(request),
    onSuccess: invalidate,
    onError,
  });
}

export function useSendMessage() {
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: (request: SendRequest) => api.sendMessage(request),
    onSuccess: invalidate,
  });
}

export function useSaveDraft() {
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: (request: SendRequest) => api.saveDraft(request),
    onSuccess: invalidate,
  });
}
