/**
 * Типы контракта помощника на основе ИИ (`/api/ai/*`).
 *
 * Пакет `@mail-true/ai` в зависимостях веб-клиента не значится (и не должен:
 * это серверный пакет с zod и обращениями к сети), поэтому формы ответов
 * описаны здесь заново — ровно те поля, которые отдаёт сервер.
 *
 * Главное поле всего этого файла — `AiState.enabled`. Пока оно false,
 * интерфейс не показывает НИ ОДНОЙ кнопки помощника: не «показывает и
 * получает отказ», а именно не показывает.
 */

/** Возможность помощника в терминах интерфейса. */
export type AiFeatureKey = 'summary' | 'classify' | 'reply' | 'extract' | 'translate' | 'search';

/** Кто именно получит данные. */
export interface AiProviderInfo {
  label: string;
  model: string;
  endpoint: string;
  /** true — модель поднята внутри периметра, письма не покидают сервер. */
  local: boolean;
}

export interface AiConsentState {
  given: boolean;
  at: string | null;
  /**
   * Согласие дано на тот же сервис, что настроен сейчас.
   * false при данном согласии — администратор сменил сервис, спрашиваем заново.
   */
  matchesProvider: boolean;
  consentedEndpoint: string | null;
  consentedModel: string | null;
}

export interface AiFeatureState {
  key: AiFeatureKey;
  title: string;
  description: string;
  /** Что именно уходит наружу при этой возможности. Без тумана. */
  sends: string;
  /** Разрешена администратором домена. */
  allowed: boolean;
  /** Включена самим пользователем. */
  enabled: boolean;
}

export interface AiBudget {
  periodMs: number;
  windowStartedAt: number;
  tokensUsed: number;
  requestsUsed: number;
  tokensLimit: number | null;
  requestsLimit: number | null;
  tokensLeft: number | null;
  requestsLeft: number | null;
}

/** GET /api/ai/state — с него начинается вся работа интерфейса. */
export interface AiState {
  /** false — интерфейс не показывает ничего, связанного с ИИ. */
  enabled: boolean;
  provider: AiProviderInfo | null;
  consent: AiConsentState;
  features: AiFeatureState[];
  /** Что не отправляется никогда. */
  neverSent: string[];
  budget: AiBudget | null;
}

/** DELETE /api/ai/consent — состояние плюс число удалённых записей. */
export interface AiConsentRevokeResult extends AiState {
  removedCacheEntries: number;
}

/* --- Опись отправленного -------------------------------------------- */

export interface AiOutboundField {
  field: string;
  label: string;
  /** Полное значение — ровно то, что уходит наружу. */
  value: string;
  chars: number;
}

export type AiRemovedKind =
  | 'signature'
  | 'quote'
  | 'attachment'
  | 'headers'
  | 'truncated'
  | 'html-markup';

export interface AiRemovedPart {
  kind: AiRemovedKind;
  count: number;
  chars: number;
  note: string;
}

/** Что именно ушло (или уйдёт) наружу. */
export interface AiOutboundDisclosure {
  endpoint: string;
  model: string;
  providerLabel: string;
  local: boolean;
  fields: AiOutboundField[];
  removed: AiRemovedPart[];
  attachmentsExcluded: string[];
  totalChars: number;
  approxTokens: number;
}

export interface AiTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true — сервис не вернул счётчики, значения оценены по длине текста. */
  estimated: boolean;
}

/** Общий конверт ответа любой возможности. */
export interface AiEnvelope<T> {
  value: T;
  /** Ответ взят из сохранённого ранее — наружу ничего не отправлялось. */
  cached: boolean;
  usage: AiTokenUsage;
  /** null — ответ из кэша. */
  disclosure: AiOutboundDisclosure | null;
  durationMs: number;
}

/* --- Результаты возможностей ---------------------------------------- */

export interface AiSummary {
  summary: string;
  bullets: string[];
  actionRequired: boolean;
}

export type AiMailCategory =
  | 'invoice'
  | 'delivery'
  | 'meeting'
  | 'contract'
  | 'personal'
  | 'account'
  | 'travel'
  | 'newsletter'
  | 'support'
  | 'other';

export interface AiClassification {
  category: AiMailCategory;
  confidence: number;
  reason: string;
  labels: string[];
}

export type AiReplyTone = 'short' | 'detailed' | 'formal';

export interface AiReplyVariant {
  tone: AiReplyTone;
  body: string;
}

export interface AiReplyVariants {
  variants: AiReplyVariant[];
}

export interface AiContinuation {
  continuation: string;
}

export type AiRewriteMode = 'shorten' | 'soften' | 'fix';

export interface AiRewriteResult {
  text: string;
  changes: string[];
}

export interface AiExtractedEvent {
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  source: string;
}

export interface AiExtractedAmount {
  amount: string;
  currency: string;
  purpose: string;
  source: string;
}

export type AiRequisiteKind =
  | 'inn'
  | 'kpp'
  | 'bic'
  | 'account'
  | 'iban'
  | 'card'
  | 'invoice-number'
  | 'contract-number'
  | 'other';

export interface AiExtractedRequisite {
  kind: AiRequisiteKind;
  value: string;
  label: string;
}

export interface AiExtractedTask {
  title: string;
  dueAt: string | null;
  assignee: string | null;
  source: string;
}

export interface AiExtractedTracking {
  number: string;
  carrier: string | null;
  url: string | null;
}

export interface AiExtraction {
  events: AiExtractedEvent[];
  amounts: AiExtractedAmount[];
  requisites: AiExtractedRequisite[];
  tasks: AiExtractedTask[];
  tracking: AiExtractedTracking[];
}

export interface AiTranslation {
  text: string;
  /** Код языка оригинала по ISO 639-1. */
  detectedLanguage: string;
}

export interface AiParsedSearchQuery {
  from: string[];
  to: string[];
  subject: string[];
  text: string[];
  dateFrom: string | null;
  dateTo: string | null;
  hasAttachments: boolean | null;
  unreadOnly: boolean | null;
  folder: string | null;
  /** Во что превратился запрос простыми словами — показывать обязательно. */
  explanation: string;
}

/* --- Журнал расхода -------------------------------------------------- */

export interface AiUsageTotals {
  requests: number;
  cachedRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  outboundChars: number;
}

export interface AiUsageEntry {
  at: string;
  messageId: string | null;
  feature: string;
  endpoint: string;
  model: string;
  local: boolean;
  usage: AiTokenUsage;
  cached: boolean;
  outboundChars: number;
  durationMs: number;
  ok: boolean;
}

/** GET /api/ai/usage */
export interface AiUsageReport {
  enabled: boolean;
  budget: AiBudget | null;
  totals: AiUsageTotals | null;
  recent?: AiUsageEntry[] | undefined;
}

/* --- Тела запросов --------------------------------------------------- */

export type AiSummarizeRequest = { messageId: string } | { messageIds: string[] };

export interface AiRepliesRequest {
  messageId: string;
  tones?: AiReplyTone[] | undefined;
  instruction?: string | undefined;
}

export interface AiContinueRequest {
  draft: string;
  messageId?: string | undefined;
}

export interface AiRewriteRequest {
  text: string;
  mode: AiRewriteMode;
}

export type AiTranslateRequest =
  | { messageId: string; targetLanguage: string }
  | { text: string; targetLanguage: string };

/* --- Русские подписи ------------------------------------------------- */

export const aiToneTitles: Record<AiReplyTone, string> = {
  short: 'Коротко',
  detailed: 'Подробно',
  formal: 'Официально',
};

export const aiRewriteTitles: Record<AiRewriteMode, string> = {
  shorten: 'Сократить',
  soften: 'Смягчить',
  fix: 'Исправить ошибки',
};

export const aiCategoryTitles: Record<AiMailCategory, string> = {
  invoice: 'Счета',
  delivery: 'Доставки',
  meeting: 'Встречи',
  contract: 'Договоры',
  personal: 'Личное',
  account: 'Учётные записи',
  travel: 'Билеты и поездки',
  newsletter: 'Рассылки',
  support: 'Поддержка',
  other: 'Прочее',
};

export const aiRequisiteTitles: Record<AiRequisiteKind, string> = {
  inn: 'ИНН',
  kpp: 'КПП',
  bic: 'БИК',
  account: 'Счёт',
  iban: 'IBAN',
  card: 'Карта',
  'invoice-number': 'Номер счёта',
  'contract-number': 'Номер договора',
  other: 'Реквизит',
};
