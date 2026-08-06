/**
 * Хуки своих меток.
 *
 * Справочник спрашивается один раз и до всего остального: пока сервер не
 * сказал `available`, ни раздела настроек, ни пункта «Метки» в меню не
 * появляется. Правило общее для продукта (так же устроены отложенные
 * письма и помощник ИИ) и здесь особенно уместно: без базы справочника
 * нет, а метка без имени и цвета — это просто непонятное слово в письме.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import {
  labelsApi,
  type ApplyLabelsRequest,
  type ApplyLabelsResult,
  type LabelDeleteResult,
  type LabelDraft,
  type LabelsState,
  type MailLabel,
} from './labelsApi';

export const labelsQueryKey = ['labels'] as const;

/** Возможности нет, пока сервер не сказал обратного. */
const LABELS_UNAVAILABLE: LabelsState = { available: false, reason: null, items: [] };

/**
 * Состояние возможности и справочник ящика.
 *
 * Повторов нет намеренно (`retry: false`): раздел не настолько важен,
 * чтобы трижды стучаться в лежащий сервер, а до ответа интерфейс просто
 * не показывает меток — это честнее, чем показать их и потерять.
 */
export function useLabelsState(): LabelsState {
  const query = useQuery({
    queryKey: labelsQueryKey,
    queryFn: () => labelsApi.getLabels(),
    // Справочник меняет только сам человек и только в настройках, поэтому
    // держать его свежим полчаса безопасно и заметно дешевле.
    staleTime: 30 * 60_000,
    retry: false,
  });
  return query.data ?? LABELS_UNAVAILABLE;
}

/** Только список меток — им пользуются строки списка и открытое письмо. */
export function useLabelDictionary(): MailLabel[] {
  return useLabelsState().items;
}

/*
 * Метки СТРОКИ списка хука не имеют и иметь не должны: у переписки это
 * объединение по разговору, и считает его сервер в сводке (`thread.labels`).
 * Показ берёт готовое поле — см. rowLabelKeys в mail/threadList.ts.
 *
 * Раньше здесь жил хук, который отдельным запросом добирал метки писем,
 * не попавших в список. Он стоил лишнего оборота к серверу на каждый показ
 * списка и отвечал ровно тем, что список и так получает вместе с флагами.
 */

function useInvalidateDictionary(): () => void {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: labelsQueryKey });
}

/**
 * После простановки метки перечитываются ПИСЬМА, а не справочник: метка
 * живёт в письме, и пока письма не перезапросили, пилюля не появится.
 * Справочник при этом не менялся.
 *
 * Ключа ДВА, и это не перестраховка. Список писем лежит под `['messages']`,
 * а открытое письмо — под `['message', id]` (см. api/queries.ts). Пока
 * сбрасывался только первый, метка, поставленная из меню «⋯» на открытом
 * письме, не появлялась на нём самом до перезагрузки страницы: сервер
 * её ставил, список её знал, а показанное письмо — нет. Найдено на стенде.
 */
function useInvalidateMessages(): () => void {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['messages'] });
    void client.invalidateQueries({ queryKey: ['message'] });
  };
}

export function useCreateLabel() {
  const invalidate = useInvalidateDictionary();
  const showNotice = useUiStore((s) => s.showNotice);
  // Тип ошибки задан явно (Error), как и в остальных хуках настроек:
  // без него он выводится как unknown, и страница не может показать текст.
  return useMutation<MailLabel, Error, LabelDraft>({
    mutationFn: (draft) => labelsApi.createLabel(draft),
    onSuccess: (label) => {
      invalidate();
      showNotice(`Метка «${label.name}» создана`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось создать метку', error)),
  });
}

export function useUpdateLabel() {
  const invalidate = useInvalidateDictionary();
  const invalidateMessages = useInvalidateMessages();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<MailLabel, Error, { key: string; patch: Partial<LabelDraft> }>({
    mutationFn: ({ key, patch }) => labelsApi.updateLabel(key, patch),
    onSuccess: () => {
      invalidate();
      // Имя и цвет видны прямо в строках писем — их надо перерисовать
      invalidateMessages();
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось изменить метку', error)),
  });
}

export function useDeleteLabel() {
  const invalidate = useInvalidateDictionary();
  const invalidateMessages = useInvalidateMessages();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<LabelDeleteResult, Error, { key: string; purge: boolean }>({
    mutationFn: ({ key, purge }) => labelsApi.deleteLabel(key, purge),
    onSuccess: (result) => {
      invalidate();
      invalidateMessages();
      /*
       * Итог называется числом писем, а не словом «готово». Удаление со
       * снятием необратимо, и человек имеет право увидеть его размер:
       * «сняли с 43 писем» — это ответ, а «готово» — умолчание.
       */
      showNotice(
        result.purged
          ? `Метка удалена, снята с писем: ${String(result.removedFromMessages)}`
          : 'Метка удалена из справочника, в письмах она осталась',
      );
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось удалить метку', error)),
  });
}

/** Поставить или снять метки на письмах. */
export function useApplyLabels() {
  const invalidateMessages = useInvalidateMessages();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<ApplyLabelsResult, Error, ApplyLabelsRequest>({
    mutationFn: (request) => labelsApi.applyLabels(request),
    onSuccess: () => invalidateMessages(),
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось изменить метки', error)),
  });
}
