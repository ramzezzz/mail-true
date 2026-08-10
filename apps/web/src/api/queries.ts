/** Хуки @tanstack/react-query поверх клиента API. */

import { useCallback, useMemo } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Account, Folder, MessageListQuery, MessageSummary } from '@mail-true/shared';
import { api, useMocks } from './index';
import { apiFetch } from './http';
import { MESSAGES_PAGE_SIZE } from './client';
import type {
  FlagsRequest,
  FlagsResponse,
  MessageFull,
  MessagesPage,
  MoveRequest,
  MoveResponse,
  ScheduledMessage,
  SendFailureNotice,
  SendRequest,
} from './types';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import { dedupeById, nextPageOffset, totalCount } from '../lib/paging';

export const queryKeys = {
  account: ['account'] as const,
  session: ['session'] as const,
  folders: ['folders'] as const,
  messages: (query: MessageListQuery) => ['messages', query] as const,
  /**
   * Список папки целиком: страницы подгружаются под одним ключом.
   *
   * Отбор по метке входит в ключ, потому что отбирает СЕРВЕР: список
   * с меткой — это другой ответ, а не подмножество прежнего. Без метки
   * в ключе подгруженные страницы полного списка достались бы отбору
   * как свои.
   */
  messageList: (folderId: string, filter: string, threaded: boolean, label?: string | null) =>
    ['messages', 'list', folderId, filter, threaded, label ?? null] as const,
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
  /** Версия работающего сервера — для нижней строки состояния. */
  version: ['version'] as const,
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

/**
 * Версия сервера приложения (`GET /api/version`) — для строки состояния.
 *
 * Запрашивается один раз за жизнь вкладки: версия не меняется, пока
 * работает тот же процесс, а перезапуск сервера всё равно перезагружает
 * страницу через отвалившийся WebSocket. Отсюда `staleTime: Infinity`
 * и отсутствие повторов: строчка мелким шрифтом внизу не стоит того,
 * чтобы ради неё стучаться в лежащий сервер трижды.
 *
 * На заглушках запрос не идёт вовсе: своей версии у них нет, а подставить
 * чужую значило бы показать поддержке выдуманное число.
 */
export function useServerVersion(): UseQueryResult<{ version: string | null }> {
  return useQuery({
    queryKey: queryKeys.version,
    queryFn: () => apiFetch<{ version: string | null }>('/api/version'),
    enabled: !useMocks,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Перечитать почту по просьбе человека (кнопка «Обновить» в строке
 * состояния). Ровно то же, что делается после изменения писем, — списки
 * и счётчики папок; отдельного «обновить всё» в клиенте не было.
 */
export function useRefreshMail(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['messages'] }),
      client.invalidateQueries({ queryKey: queryKeys.folders }),
    ]);
  };
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
  /**
   * Отбор по своей метке. Уходит на сервер, а не отсеивает загруженные
   * строки: у человека с сотней помеченных писем в папке на двадцать
   * тысяч отбор по загруженному показывал бы горстку.
   */
  label: string | null = null,
): FolderMessages {
  const result = useInfiniteQuery({
    queryKey: queryKeys.messageList(folderId, filter, threaded, label),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.getMessages({
        folderId,
        offset: pageParam,
        limit: MESSAGES_PAGE_SIZE,
        threaded,
        filter,
        ...(label ? { label } : {}),
      }),
    getNextPageParam: (_last, pages) => nextPageOffset(pages),
  });

  const pages = result.data?.pages ?? [];
  /**
   * Склеенные страницы — ОДИН И ТОТ ЖЕ массив, пока не приехали новые
   * данные, и повторов в нём нет.
   *
   * Про повторы — см. `dedupeById`. Про постоянство ссылки: раньше здесь
   * стоял голый `pages.flatMap`, то есть новый массив на каждый рендер.
   * Список писем на него смотрит как на «письма изменились» и заново
   * считает строки, счётчики переписок, состояния выделения — и заодно
   * доводит прокрутку до строки под клавиатурным курсором. Человек уезжал
   * колесом вниз читать темы, а список отпрыгивал обратно от любой
   * мелочи: щелчка по галочке соседа, возврата в окно, события по сокету.
   */
  const items = useMemo(
    () => dedupeById((result.data?.pages ?? []).flatMap((page) => page.items)),
    [result.data],
  );

  /*
   * Действия списка — постоянные функции. `loadMore` уезжает в эффект
   * «долистали до конца» внутри списка: новая функция на каждый рендер
   * заставляла бы этот эффект срабатывать снова и снова.
   */
  const { hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = result;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const retry = useCallback(() => void refetch(), [refetch]);
  const refresh = useCallback(() => refetch(), [refetch]);

  return {
    items,
    total: pages.length > 0 ? totalCount(pages) : 0,
    // Именно строки списка, а не сумма длин страниц: подпись «Выделить
    // загруженные (N из M)» обещает выделить ровно то, что видно, а после
    // снятия повторов это разные числа.
    loaded: items.length,
    isPending: result.isPending,
    isError: result.isError,
    error: result.error,
    hasMore: Boolean(result.hasNextPage),
    isLoadingMore: result.isFetchingNextPage,
    isRefreshing: result.isFetching && !result.isPending && !result.isFetchingNextPage,
    loadMore,
    retry,
    refresh,
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

/**
 * Тело письма С НАСТОЯЩИМИ адресами картинок — для цитаты.
 *
 * В режиме чтения внешние картинки заменены прозрачным пикселем, а их
 * адреса лежат в data-атрибуте, который при отправке вырезается. Значит
 * пересылать или цитировать нужно другое тело — то, где адреса на месте.
 * Отдельный хук, а не флаг у useMessage: цитата берётся ОДИН раз, в
 * момент нажатия, и не должна ни менять того, что человек видит на
 * экране, ни разблокировать ему картинки задним числом.
 */
export function fetchMessageForQuote(client: QueryClient, id: string): Promise<MessageFull> {
  return client.fetchQuery({
    queryKey: queryKeys.message(id, true),
    queryFn: () => api.getMessage(id, { images: true }),
  });
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

/**
 * После любых изменений писем перечитываем списки, ОТКРЫТОЕ ПИСЬМО и
 * счётчики папок.
 *
 * Ключа три, и третий здесь не для красоты. Список лежит под
 * `['messages']`, а показанное письмо — под своим `['message', id, images]`.
 * Пока сбрасывался только список, флажок, поставленный на странице письма,
 * не доходил до самого письма: пункт меню продолжал называться «Пометить
 * флажком», второе нажатие снова слало `flagged: true` — снять флажок из
 * просмотра было нельзя вообще. То же и с «прочитано»: `seen: true` уходил
 * заново при каждом возврате к письму. Соседи (useLabels, useAwaitReply)
 * сбрасывают оба ключа с самого начала — здесь про второй забыли.
 */
function useInvalidateMail() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['messages'] });
    void client.invalidateQueries({ queryKey: ['message'] });
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

/**
 * Отзыв письма, которое ещё лежит в очереди отмены на сервере.
 *
 * Списки перечитываются в любом случае — и когда отменить удалось, и когда
 * письмо успело уйти: во втором случае оно только что появилось
 * в «Отправленных», и список обязан это показать.
 */
/**
 * Письма, которые отправить не удалось.
 *
 * Спрашивается при открытии почты — этим и держится обещание «человек
 * узнает, даже если закрыл вкладку». Событие по сокету поверх этого
 * только ускоряет показ (см. SendFailureBanner).
 *
 * `staleTime: 0` намеренно: список коротких и почти всегда пустой, а
 * пропустить извещение об отказе дороже любого лишнего запроса.
 */
export function useSendFailures(): UseQueryResult<SendFailureNotice[]> {
  return useQuery({
    queryKey: ['send-failures'],
    queryFn: () => api.getSendFailures(),
    staleTime: 0,
  });
}

export function useAckSendFailure() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.ackSendFailure(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['send-failures'] }),
  });
}

/**
 * Письма, отложенные на будущее.
 *
 * Обновляется вместе с остальной почтой и раз в минуту сама: срок у
 * письма наступает без участия человека, и строка «уйдёт сегодня в 18:00»
 * должна исчезнуть, когда письмо действительно уйдёт, а не висеть до
 * перезагрузки вкладки.
 */
export function useScheduledMessages(): UseQueryResult<ScheduledMessage[]> {
  return useQuery({
    queryKey: ['scheduled'],
    queryFn: () => api.getScheduled(),
    staleTime: 0,
    refetchInterval: 60_000,
  });
}

export function useUndoSend() {
  const invalidate = useInvalidateMail();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pendingId: string) => api.undoSend(pendingId),
    onSuccess: () => {
      // Очередь тоже перечитываем: отменённое письмо ушло из неё, а
      // отменённое отложенное — ещё и появилось в «Черновиках».
      void client.invalidateQueries({ queryKey: ['scheduled'] });
      invalidate();
    },
  });
}

/**
 * Ответ на просьбу уведомить о прочтении.
 *
 * После ответа письмо перечитывается: сервер ставит на нём ключевое слово
 * `$MDNSent`, и без обновления плашка с вопросом осталась бы на экране —
 * то есть выглядела бы так, будто нажатие ничего не сделало.
 */
export function useSendReadReceipt(messageId: string | undefined) {
  const client = useQueryClient();
  const onError = useNotifyFailure('Не удалось отправить уведомление о прочтении');
  return useMutation({
    mutationFn: (send: boolean) => api.sendReadReceipt(messageId ?? '', send),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['message', messageId] });
      void client.invalidateQueries({ queryKey: ['messages'] });
    },
    onError,
  });
}

export function useSaveDraft() {
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: (request: SendRequest) => api.saveDraft(request),
    onSuccess: invalidate,
  });
}
