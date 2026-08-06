/**
 * Хуки шаблонов писем.
 *
 * Список спрашивается один раз и до всего остального: пока сервер не сказал
 * `available`, ни кнопки «Шаблоны» в окне написания, ни раздела настроек,
 * ни пункта в меню не появляется. Правило общее для продукта (так же
 * устроены метки, отложенные письма и помощник ИИ).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../app/store';
import { actionErrorText } from '../lib/errorText';
import {
  templatesApi,
  TEMPLATES_UNAVAILABLE,
  type MailTemplate,
  type TemplateDraft,
  type TemplatesState,
} from './templatesApi';

export const templatesQueryKey = ['templates'] as const;

/**
 * Состояние возможности и список шаблонов ящика.
 *
 * Повторов нет намеренно (`retry: false`): раздел не настолько важен, чтобы
 * трижды стучаться в лежащий сервер, а до ответа интерфейс просто не
 * показывает кнопки — это честнее, чем показать её и отказать по нажатию.
 */
export function useTemplatesState(): TemplatesState {
  const query = useQuery({
    queryKey: templatesQueryKey,
    queryFn: () => templatesApi.getTemplates(),
    // Список меняет только сам человек и только в настройках или из окна
    // написания, а после каждой правки он всё равно сбрасывается.
    staleTime: 30 * 60_000,
    retry: false,
  });
  return query.data ?? TEMPLATES_UNAVAILABLE;
}

function useInvalidateTemplates(): () => void {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: templatesQueryKey });
}

export function useCreateTemplate() {
  const invalidate = useInvalidateTemplates();
  const showNotice = useUiStore((s) => s.showNotice);
  // Тип ошибки задан явно (Error), как и в остальных хуках настроек: без
  // него он выводится как unknown, и страница не может показать текст.
  return useMutation<MailTemplate, Error, TemplateDraft>({
    mutationFn: (draft) => templatesApi.createTemplate(draft),
    onSuccess: (template) => {
      invalidate();
      showNotice(`Шаблон «${template.name}» сохранён`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось сохранить шаблон', error)),
  });
}

export function useUpdateTemplate() {
  const invalidate = useInvalidateTemplates();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<MailTemplate, Error, { id: number; patch: Partial<TemplateDraft> }>({
    mutationFn: ({ id, patch }) => templatesApi.updateTemplate(id, patch),
    onSuccess: () => invalidate(),
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось изменить шаблон', error)),
  });
}

export function useDeleteTemplate() {
  const invalidate = useInvalidateTemplates();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<{ ok: boolean; id: number; name: string }, Error, number>({
    mutationFn: (id) => templatesApi.deleteTemplate(id),
    onSuccess: (result) => {
      invalidate();
      showNotice(`Шаблон «${result.name}» удалён`);
    },
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось удалить шаблон', error)),
  });
}

/**
 * Порядок в меню.
 *
 * Отдельная правка, а не поле шаблона: порядок — свойство списка целиком.
 * Ошибку показываем обязательно — иначе перетаскивание «получалось» бы на
 * экране и не сохранялось на сервере, а увидел бы это человек только после
 * перезагрузки страницы.
 */
export function useReorderTemplates() {
  const invalidate = useInvalidateTemplates();
  const showNotice = useUiStore((s) => s.showNotice);
  return useMutation<{ items: MailTemplate[] }, Error, number[]>({
    mutationFn: (ids) => templatesApi.reorderTemplates(ids),
    onSuccess: () => invalidate(),
    onError: (error: unknown) => showNotice(actionErrorText('Не удалось изменить порядок', error)),
  });
}
