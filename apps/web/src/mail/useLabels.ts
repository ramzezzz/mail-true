/**
 * Хуки своих меток.
 *
 * Справочник спрашивается один раз и до всего остального: пока сервер не
 * сказал `available`, ни раздела настроек, ни пункта «Метки» в меню не
 * появляется. Правило общее для продукта (так же устроены отложенные
 * письма и помощник ИИ) и здесь особенно уместно: без базы справочника
 * нет, а метка без имени и цвета — это просто непонятное слово в письме.
 */

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageSummary } from '@mail-true/shared';
import { useUiStore } from '../app/store';
import { userLabelKeys } from '../lib/categories';
import { actionErrorText } from '../lib/errorText';
import {
  labelsApi,
  type ApplyLabelsRequest,
  type ApplyLabelsResult,
  type LabelDeleteResult,
  type LabelDraft,
  type LabelsByMessage,
  rowLabelUnion,
  type LabelsState,
  type MailLabel,
} from './labelsApi';
import { chunkIds, threadMessageIds } from './threadList';

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

/**
 * Метки СТРОКИ списка, когда строка — это переписка.
 *
 * Правило то же, что у флажка и скрепки в сводке переписки: метка стоит
 * на разговоре, если стоит хоть на одном его письме. Иначе пометка
 * «оплатить» пропадала бы из списка от первого же ответа собеседника —
 * строку рисует последнее письмо, а новое письмо ключевого слова не несёт.
 *
 * Запрос идёт только за теми письмами, которых в списке НЕТ (все, кроме
 * показанного строкой): их метки взять больше неоткуда. У строки-письма
 * (папки без группировки, разговор из одного письма) спрашивать нечего,
 * и запроса не будет вовсе.
 */
export function useRowLabels(
  messages: readonly MessageSummary[],
): ReadonlyMap<string, readonly string[]> {
  const { available } = useLabelsState();

  /** Письма переписок, которых нет в списке. Порядок постоянный — он ключ. */
  const hiddenIds = useMemo(() => {
    const out: string[] = [];
    for (const message of messages) {
      if (!message.thread || message.thread.count <= 1) continue;
      for (const id of threadMessageIds(message)) {
        if (id !== message.id) out.push(id);
      }
    }
    return out;
  }, [messages]);

  const query = useQuery({
    queryKey: ['labels', 'of', hiddenIds.join(',')],
    // Запросов столько, сколько нужно: маршрут принимает пятьсот писем за
    // раз, а сотня строк-переписок — это легко больше.
    queryFn: async (): Promise<LabelsByMessage> => {
      const merged: LabelsByMessage = {};
      for (const chunk of chunkIds(hiddenIds)) {
        Object.assign(merged, await labelsApi.labelsOfMessages(chunk));
      }
      return merged;
    },
    enabled: available && hiddenIds.length > 0,
    // Метки меняет только человек, и после каждой правки кэш сбрасывается
    // явно (useInvalidateMessages). Минуты хватает, чтобы прокрутка списка
    // туда-обратно не била в сервер.
    staleTime: 60_000,
    // Список обязан рисоваться и без этого запроса: метки — украшение
    // строки, а не её содержание. Поэтому без повторов.
    retry: false,
  });

  const hidden = query.data;

  return useMemo(() => {
    const rows = new Map<string, readonly string[]>();
    for (const message of messages) {
      // Метки самого показанного письма известны всегда — они пришли
      // в списке; служебные слова из них отсеиваются здесь же. Остальные
      // письма разговора добавляются, когда ответ приехал.
      const union = rowLabelUnion(
        {
          id: message.id,
          labels: userLabelKeys(message.labels),
          ...(hidden && message.thread && message.thread.count > 1
            ? { threadIds: threadMessageIds(message) }
            : {}),
        },
        hidden ?? {},
      );
      if (union.length > 0) rows.set(message.id, union);
    }
    return rows;
  }, [messages, hidden]);
}

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
    // Метки скрытых писем переписки лежат отдельно: без сброса пилюля
    // на строке-разговоре отставала бы на минуту от собственного нажатия.
    void client.invalidateQueries({ queryKey: ['labels', 'of'] });
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
