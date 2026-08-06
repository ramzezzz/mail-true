/**
 * Хуки сохранённых запросов.
 *
 * Состояние возможности спрашивается один раз и до всего остального: пока
 * сервер не сказал `available`, ни кнопки «Сохранить запрос», ни группы в
 * левой колонке не появляется. Правило общее для продукта — так же устроены
 * метки, отложенные письма и помощник ИИ.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import {
  SAVED_SEARCHES_UNAVAILABLE,
  savedSearchesApi,
  type SavedSearch,
  type SavedSearchDraft,
  type SavedSearchesState,
} from './savedSearchesApi';

export const savedSearchesQueryKey = ['saved-searches'] as const;

/**
 * Состояние возможности и список запросов.
 *
 * Повторов нет намеренно (`retry: false`): список не настолько важен, чтобы
 * трижды стучаться в лежащий сервер, а до ответа интерфейс просто не
 * показывает группы — это честнее, чем показать её и потерять.
 */
export function useSavedSearches(): SavedSearchesState {
  const query = useQuery({
    queryKey: savedSearchesQueryKey,
    queryFn: () => savedSearchesApi.getSavedSearches(),
    // Список меняет только сам человек и только отсюда же.
    staleTime: 30 * 60_000,
    retry: false,
  });
  return query.data ?? SAVED_SEARCHES_UNAVAILABLE;
}

function useInvalidate(): () => void {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: savedSearchesQueryKey });
}

export function useCreateSavedSearch() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  // Тип ошибки задан явно (Error), как и в остальных хуках: без него он
  // выводится как unknown, и страница не может показать текст.
  return useMutation<SavedSearch, Error, SavedSearchDraft>({
    mutationFn: (draft) => savedSearchesApi.createSavedSearch(draft),
    onSuccess: (saved) => {
      invalidate();
      showNotice(`Запрос «${saved.name}» сохранён`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось сохранить запрос', error)),
  });
}

export function useDeleteSavedSearch() {
  const invalidate = useInvalidate();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<{ ok: boolean; id: string; name: string }, Error, string>({
    mutationFn: (id) => savedSearchesApi.deleteSavedSearch(id),
    onSuccess: (result) => {
      invalidate();
      /*
       * Итог называет имя, а не «готово»: сохранённых запросов бывает
       * с десяток, и человек имеет право убедиться, что ушёл именно тот.
       * Письма при этом не трогаются вовсе — запрос был только строкой.
       */
      showNotice(`Запрос «${result.name}» убран. Письма не тронуты`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось убрать запрос', error)),
  });
}
