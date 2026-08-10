/**
 * Хуки react-query для помощника на основе ИИ.
 *
 * Единственный запрос, который выполняется сам, — состояние помощника
 * (`useAiState`). Всё остальное — мутации: помощник работает по нажатию,
 * а не «сам на всякий случай», иначе текст писем уходил бы наружу без
 * ведома пользователя.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from './index';
import { queryKeys } from './queries';
import type {
  AiClassification,
  AiConsentRevokeResult,
  AiContinuation,
  AiContinueRequest,
  AiEnvelope,
  AiExtraction,
  AiFeatureKey,
  AiParsedSearchQuery,
  AiRepliesRequest,
  AiReplyVariants,
  AiRewriteRequest,
  AiRewriteResult,
  AiState,
  AiSummarizeRequest,
  AiSummary,
  AiTranslateRequest,
  AiTranslation,
  AiUsageReport,
} from './aiTypes';

/**
 * Состояние помощника. Пока не загрузилось — `data` равна undefined,
 * и интерфейс не показывает кнопок: молчание безопаснее догадок.
 */
export function useAiState(): UseQueryResult<AiState> {
  return useQuery({
    queryKey: queryKeys.aiState,
    queryFn: () => api.getAiState(),
    // Состояние меняет администратор, а не пользователь: перечитывать
    // на каждом переключении вкладки незачем.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function useAiUsage(enabled: boolean): UseQueryResult<AiUsageReport> {
  return useQuery({
    queryKey: queryKeys.aiUsage,
    queryFn: () => api.aiUsage(),
    enabled,
    retry: false,
  });
}

/** Ответ маршрутов согласия — это то же состояние; кладём его в кэш сразу. */
function useStoreState() {
  const client = useQueryClient();
  return (state: AiState) => {
    client.setQueryData(queryKeys.aiState, state);
    void client.invalidateQueries({ queryKey: queryKeys.aiUsage });
  };
}

export function useAiConsent(): UseMutationResult<AiState, Error, AiFeatureKey[] | undefined> {
  const store = useStoreState();
  return useMutation({
    mutationFn: (features: AiFeatureKey[] | undefined) => api.giveAiConsent(features),
    onSuccess: store,
  });
}

export function useAiRevokeConsent(): UseMutationResult<AiConsentRevokeResult, Error, void> {
  const store = useStoreState();
  return useMutation({
    mutationFn: () => api.revokeAiConsent(),
    onSuccess: store,
  });
}

export function useAiFeatures(): UseMutationResult<AiState, Error, AiFeatureKey[]> {
  const store = useStoreState();
  return useMutation({
    mutationFn: (features: AiFeatureKey[]) => api.setAiFeatures(features),
    onSuccess: store,
  });
}

/** После любого обращения к ИИ расход меняется — обновляем состояние. */
function useRefreshBudget() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.aiState });
  };
}

export function useAiSummarize(): UseMutationResult<
  AiEnvelope<AiSummary>,
  Error,
  AiSummarizeRequest
> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (request: AiSummarizeRequest) => api.aiSummarize(request),
    onSuccess: refresh,
  });
}

export function useAiExtract(): UseMutationResult<AiEnvelope<AiExtraction>, Error, string> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (messageId: string) => api.aiExtract(messageId),
    onSuccess: refresh,
  });
}

export function useAiClassify(): UseMutationResult<AiEnvelope<AiClassification>, Error, string> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (messageId: string) => api.aiClassify(messageId),
    onSuccess: refresh,
  });
}

export function useAiTranslate(): UseMutationResult<
  AiEnvelope<AiTranslation>,
  Error,
  AiTranslateRequest
> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (request: AiTranslateRequest) => api.aiTranslate(request),
    onSuccess: refresh,
  });
}

export function useAiReplies(): UseMutationResult<
  AiEnvelope<AiReplyVariants>,
  Error,
  AiRepliesRequest
> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (request: AiRepliesRequest) => api.aiReplies(request),
    onSuccess: refresh,
  });
}

export function useAiContinue(): UseMutationResult<
  AiEnvelope<AiContinuation>,
  Error,
  AiContinueRequest
> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (request: AiContinueRequest) => api.aiContinue(request),
    onSuccess: refresh,
  });
}

export function useAiRewrite(): UseMutationResult<
  AiEnvelope<AiRewriteResult>,
  Error,
  AiRewriteRequest
> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (request: AiRewriteRequest) => api.aiRewrite(request),
    onSuccess: refresh,
  });
}

export function useAiSearchQuery(): UseMutationResult<
  AiEnvelope<AiParsedSearchQuery>,
  Error,
  string
> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (query: string) => api.aiSearchQuery(query),
    onSuccess: refresh,
  });
}

export function useAiForgetMessage(): UseMutationResult<{ removed: number }, Error, string> {
  const refresh = useRefreshBudget();
  return useMutation({
    mutationFn: (messageId: string) => api.aiForgetMessage(messageId),
    onSuccess: refresh,
  });
}
