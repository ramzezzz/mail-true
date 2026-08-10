/** Хуки @tanstack/react-query для раздела настроек. */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Folder } from '@mail-true/shared';
import { settingsApi } from './index';
import { queryKeys } from './queries';
import { useUiStore } from '../app/store';
import { resetSenderLogos } from '../mail/senderLogos';
import type { FilterRule } from '../lib/filterRules';
import type {
  CollectorAccount,
  CollectorDraft,
  FolderDraft,
  GeneralSettings,
} from './settingsTypes';

export const settingsKeys = {
  general: ['settings', 'general'] as const,
  filters: ['settings', 'filters'] as const,
  collectors: ['settings', 'collectors'] as const,
};

/**
 * Предупреждение сервера о том, что правила сохранены, но не применены.
 *
 * Раскладывать почту, отвечать в отпуске и заглушать переписки умеет файл
 * правил в ящике (Sieve). Сохранение в базе и запись этого файла — разные
 * действия, и второе может не удаться: выключен транспорт, недоступен
 * контейнер Dovecot, не скомпилировался скрипт, отказала запись.
 *
 * Сервер такую неудачу не считает отказом всего запроса (настройка ведь
 * сохранена) и присылает её отдельным полем. Раньше поля не было вовсе, и
 * человек видел зелёное «Настройки сохранены», уезжал в отпуск — а
 * отвечать было некому.
 */
function noticeSieveWarning(result: unknown): void {
  const warning = (result as { sieveWarning?: unknown } | null)?.sieveWarning;
  if (typeof warning === 'string' && warning !== '') {
    useUiStore.getState().showNotice(warning);
  }
}

/* --- Общие настройки -------------------------------------------------- */

export function useGeneralSettings(): UseQueryResult<GeneralSettings> {
  return useQuery({ queryKey: settingsKeys.general, queryFn: () => settingsApi.getGeneral() });
}

export function useSaveGeneralSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: GeneralSettings) => settingsApi.saveGeneral(settings),
    // Кладём ответ сервера прямо в кэш: сохранение — единственный источник
    // правды о том, что реально записалось (сервер мог нормализовать поля).
    onSuccess: (saved) => {
      client.setQueryData(settingsKeys.general, saved);
      noticeSieveWarning(saved);
      /*
       * Реестр логотипов запоминает ответ сервера «выключено» на весь сеанс,
       * чтобы не спрашивать зря. После сохранения настроек этот ответ мог
       * устареть в любую сторону — сбрасываем, иначе только что включённая
       * настройка выглядела бы сломанной до перезагрузки страницы.
       */
      resetSenderLogos();
    },
  });
}

/* --- Правила фильтрации ------------------------------------------------ */

export function useFilterRules(): UseQueryResult<FilterRule[]> {
  return useQuery({ queryKey: settingsKeys.filters, queryFn: () => settingsApi.getFilterRules() });
}

function useInvalidateFilters() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: settingsKeys.filters });
}

export function useSaveFilterRule() {
  const invalidate = useInvalidateFilters();
  return useMutation({
    mutationFn: (rule: FilterRule) => settingsApi.saveFilterRule(rule),
    onSuccess: (saved) => {
      invalidate();
      noticeSieveWarning(saved);
    },
  });
}

export function useDeleteFilterRule() {
  const invalidate = useInvalidateFilters();
  return useMutation({
    mutationFn: (id: string) => settingsApi.deleteFilterRule(id),
    onSuccess: (result) => {
      invalidate();
      noticeSieveWarning(result);
    },
  });
}

export function useReorderFilterRules() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => settingsApi.reorderFilterRules(ids),
    onSuccess: (rules) => client.setQueryData(settingsKeys.filters, rules),
  });
}

/* --- Папки ------------------------------------------------------------- */

/** После любой правки папок перечитываем список — его же рисует левое меню. */
function useInvalidateFolders() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.folders });
    void client.invalidateQueries({ queryKey: ['messages'] });
  };
}

export function useCreateFolder() {
  const invalidate = useInvalidateFolders();
  return useMutation<Folder, Error, FolderDraft>({
    mutationFn: (draft) => settingsApi.createFolder(draft),
    onSuccess: invalidate,
  });
}

export function useRenameFolder() {
  const invalidate = useInvalidateFolders();
  return useMutation<Folder, Error, { id: string; name: string }>({
    mutationFn: ({ id, name }) => settingsApi.renameFolder(id, name),
    onSuccess: invalidate,
  });
}

export function useDeleteFolder() {
  const invalidate = useInvalidateFolders();
  return useMutation<void, Error, string>({
    mutationFn: (id) => settingsApi.deleteFolder(id),
    onSuccess: invalidate,
  });
}

export function useClearFolder() {
  const invalidate = useInvalidateFolders();
  return useMutation<{ removed: number }, Error, string>({
    mutationFn: (id) => settingsApi.clearFolder(id),
    onSuccess: invalidate,
  });
}

/* --- Сбор почты с других ящиков ---------------------------------------- */

export function useCollectors(): UseQueryResult<CollectorAccount[]> {
  return useQuery({
    queryKey: settingsKeys.collectors,
    queryFn: () => settingsApi.getCollectors(),
    /*
     * Пока хоть один ящик синхронизируется — перечитываем список.
     *
     * Сбор идёт на сервере и переживает ответ на нажатие «Проверить»
     * (первая синхронизация большого ящика длится минуты). Без опроса
     * «Идёт синхронизация…» висело бы до перезагрузки страницы, а итог
     * — и число собранных писем, и отказ — человек не увидел бы вовсе.
     */
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.status === 'syncing') === true ? 5_000 : false,
  });
}

function useInvalidateCollectors() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: settingsKeys.collectors });
}

export function useAddCollector() {
  const invalidate = useInvalidateCollectors();
  return useMutation<CollectorAccount, Error, CollectorDraft>({
    mutationFn: (draft) => settingsApi.addCollector(draft),
    onSuccess: invalidate,
  });
}

export function useUpdateCollector() {
  const invalidate = useInvalidateCollectors();
  return useMutation<CollectorAccount, Error, { id: string; patch: Partial<CollectorAccount> }>({
    mutationFn: ({ id, patch }) => settingsApi.updateCollector(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteCollector() {
  const invalidate = useInvalidateCollectors();
  return useMutation<void, Error, string>({
    mutationFn: (id) => settingsApi.deleteCollector(id),
    onSuccess: invalidate,
  });
}

export function useSyncCollector() {
  const invalidate = useInvalidateCollectors();
  return useMutation<CollectorAccount, Error, string>({
    mutationFn: (id) => settingsApi.syncCollector(id),
    onSuccess: invalidate,
  });
}
