/**
 * Хуки разбора ящика.
 *
 * Осмотр ящика стоит дорого (сервер читает заголовки и размеры тысяч
 * писем), поэтому спрашивается он ТОЛЬКО когда окно разбора открыто —
 * отсюда `enabled`. Держать его наготове «на всякий случай» значило бы
 * платить осмотром ящика за каждое открытие почты.
 *
 * Кнопка при этом появляется без всякого запроса: за разбором не стоит
 * ни базы, ни миграции, ни служебного доступа — он работает везде, где
 * работает почта. Единственное место, где его нет, — режим заглушек, и
 * там его нет честно (см. mailingsApi.ts).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queries';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import { useMocks } from '../api/mockFlag';
import {
  CLEANUP_UNAVAILABLE,
  MAILINGS_UNAVAILABLE,
  mailingsApi,
  messagesWord,
  type CleanupState,
  type MailingsState,
  type SweepRequest,
  type SweepResult,
  type UnsubscribeResult,
} from './mailingsApi';

export const mailingsQueryKey = ['mailings'] as const;
export const cleanupQueryKey = ['cleanup'] as const;

/**
 * Есть ли разбор вообще. Не запрос, а один признак: разбору нечего
 * спрашивать у сервера, чтобы узнать о себе, — он либо работает, либо мы
 * на заглушках.
 */
export function useMailboxReviewAvailable(): boolean {
  return !useMocks;
}

/**
 * Разбор рассылок. Спрашивается только при открытом окне.
 *
 * Повторов нет намеренно (`retry: false`): осмотр ящика дорог, и трижды
 * повторять его при лежащем сервере значило бы держать человека перед
 * крутилкой втрое дольше без единого шанса на успех.
 */
export function useMailingsState(enabled: boolean): {
  data: MailingsState;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  refresh: () => void;
} {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: mailingsQueryKey,
    queryFn: () => mailingsApi.getMailings(),
    enabled,
    // Снимок ящика живёт на сервере пять минут; держать его здесь дольше
    // значило бы показывать числа, которых на сервере уже нет.
    staleTime: 4 * 60_000,
    retry: false,
  });
  return {
    data: query.data ?? MAILINGS_UNAVAILABLE,
    isPending: query.isPending && enabled,
    isFetching: query.isFetching,
    error: query.error,
    refresh: () => {
      /*
       * «Обновить» обязано именно ПЕРЕСОБРАТЬ разбор на сервере, а не
       * перечитать тот же снимок: человек нажимает эту кнопку ровно
       * тогда, когда подозревает, что числа устарели.
       */
      void client.fetchQuery({
        queryKey: mailingsQueryKey,
        queryFn: () => mailingsApi.getMailings(true),
        staleTime: 0,
      });
      void client.invalidateQueries({ queryKey: cleanupQueryKey });
    },
  };
}

/** Уборка: квота, самое тяжёлое и залежавшиеся рассылки. */
export function useCleanupState(enabled: boolean): {
  data: CleanupState;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
} {
  const query = useQuery({
    queryKey: cleanupQueryKey,
    queryFn: () => mailingsApi.getCleanup(),
    enabled,
    staleTime: 4 * 60_000,
    retry: false,
  });
  return {
    data: query.data ?? CLEANUP_UNAVAILABLE,
    isPending: query.isPending && enabled,
    isFetching: query.isFetching,
    error: query.error,
  };
}

/**
 * После уборки меняется всё: список писем, счётчики папок и сам разбор.
 * Сервер свой снимок уже выбросил — здесь надо выбросить свой.
 *
 * Наружу вынесено ради удаления тяжёлых писем: оно ходит обычным переносом
 * в корзину (useMoveMessages), а тот про разбор ящика ничего не знает.
 */
export function useInvalidateAfterSweep(): () => void {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['messages'] });
    void client.invalidateQueries({ queryKey: queryKeys.folders });
    void client.invalidateQueries({ queryKey: mailingsQueryKey });
    void client.invalidateQueries({ queryKey: cleanupQueryKey });
  };
}

/**
 * Отписка от рассылки целиком.
 *
 * Итог называется словами, а не «готово»: отписка бывает трёх исходов, и
 * они РАЗНЫЕ для человека. Запрос с сервера — дело сделано. Письмо на
 * `mailto:` — просьба отправлена, ответ придёт не сразу. Ссылка — дальше
 * нужен человек, и страницу открывает интерфейс.
 */
export function useUnsubscribeMailing() {
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<UnsubscribeResult, Error, string>({
    mutationFn: (key) => mailingsApi.unsubscribe(key),
    onSuccess: (result) => {
      if (result.ok && result.method === 'one-click') {
        showNotice(`Отписались от «${result.title}»`);
        return;
      }
      if (result.ok && result.method === 'mailto') {
        showNotice(`Просьба об отписке отправлена на ${result.address}`);
        return;
      }
      if (result.url) {
        /*
         * Страницу отписки открываем НОВОЙ вкладкой и с `noopener`:
         * это чужая страница, и давать ей ссылку на наше окно нельзя.
         */
        window.open(result.url, '_blank', 'noopener,noreferrer');
        showNotice(`Открыли страницу отписки «${result.title}»`);
        return;
      }
      showNotice(`Отписаться от «${result.title}» нечем`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось отписаться', error)),
  });
}

/**
 * Посчитать отбор, ничего не трогая.
 *
 * Отдельно от выполнения намеренно: предпросмотр вызывается на каждое
 * изменение условий, и он обязан быть заведомо безобидным. Сервер это
 * тоже знает — без `dryRun: false` он ничего не двигает.
 */
export function useSweepPreview() {
  return useMutation<SweepResult, Error, Omit<SweepRequest, 'dryRun'>>({
    mutationFn: (request) => mailingsApi.sweep({ ...request, dryRun: true }),
  });
}

/** Выполнить уборку. Отметку разбора обязан прислать вызывающий. */
export function useSweepRun() {
  const invalidate = useInvalidateAfterSweep();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<SweepResult, Error, Omit<SweepRequest, 'dryRun'>>({
    mutationFn: (request) => mailingsApi.sweep({ ...request, dryRun: false }),
    onSuccess: (result) => {
      invalidate();
      /*
       * Итог называется ЧИСЛОМ и МЕСТОМ, а не словом «готово». Человек
       * только что согласился на массовое действие и имеет право узнать
       * его настоящий размер — тем более что уехать могло меньше
       * обещанного (часть писем успели убрать с телефона).
       */
      if (result.moved === 0) {
        showNotice('Убирать оказалось нечего');
        return;
      }
      const where = result.targetFolderId === 'trash' ? 'в корзину' : 'в папку';
      showNotice(`Убрали ${where}: ${messagesWord(result.moved)}`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось убрать письма', error)),
  });
}
