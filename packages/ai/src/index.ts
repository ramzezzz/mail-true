/**
 * @mail-true/ai — помощник на основе ИИ для почтового сервера Mail.True.
 *
 * Пакет самостоятельный: не создаёт соединений, не читает переменные
 * окружения, не знает про HTTP-маршруты. Всё приходит извне —
 * настройки, кэш, журнал, учёт расходов.
 *
 * Главный принцип (см. docs/ai-spec.md): помощник выключен по умолчанию,
 * честно показывает, что именно уходит наружу, и умеет работать
 * на локальной модели, чтобы письма не покидали сервер.
 *
 * Короткий путь для подключения к API:
 *
 * ```ts
 * const created = MailAssistant.create({
 *   provider: { enabled: true, baseUrl, apiKey, model, providerLabel, local },
 *   limits: { maxTokensPerPeriod: 200_000 },
 *   deps: { cache: new RedisAiCache(redis), audit: new LoggerAuditLog(logger) },
 * });
 * if (!created.ok) return; // кнопки ИИ не показываем
 * const result = await created.assistant.summarizeMessage(message, { accountId });
 * if (result.ok) render(result.value, result.disclosure);
 * else showQuietly(result.error.message);
 * ```
 */

// --- Основной интерфейс ----------------------------------------------------

export { MailAssistant, disabledAssistant } from './assistant.js';
export type {
  AiCallContext,
  CreateAssistantResult,
  MailAssistantDeps,
  MailAssistantInit,
} from './assistant.js';

// --- Результаты и ошибки ---------------------------------------------------

export { ZERO_USAGE, addUsage, aiFail, aiOk, isOk } from './types.js';
export type {
  AiError,
  AiErrorKind,
  AiFailureResult,
  AiFeature,
  AiOutcome,
  AiSourceAddress,
  AiSourceAttachment,
  AiSourceMessage,
  AiSuccess,
  OutboundDisclosure,
  OutboundField,
  RemovedKind,
  RemovedPart,
  TokenUsage,
} from './types.js';

// --- Настройки -------------------------------------------------------------

export {
  assistantOptionsSchema,
  budgetLimitsSchema,
  chatEndpoint,
  parseProviderConfig,
  providerConfigSchema,
} from './config.js';
export type {
  AssistantOptions,
  AssistantOptionsInput,
  BudgetLimits,
  BudgetLimitsInput,
  ProviderConfig,
  ProviderConfigInput,
} from './config.js';

// --- Типы результатов возможностей -----------------------------------------

export {
  categoryTitles,
  classificationSchema,
  continuationSchema,
  extractionSchema,
  mailCategories,
  replyTones,
  replyVariantsSchema,
  requisiteKinds,
  rewriteModeTitles,
  rewriteModes,
  rewriteSchema,
  searchQuerySchema,
  summarySchema,
  toneTitles,
  translationSchema,
} from './schemas.js';
export type {
  Classification,
  Continuation,
  ExtractedAmount,
  ExtractedEvent,
  ExtractedRequisite,
  ExtractedTask,
  ExtractedTracking,
  Extraction,
  MailCategory,
  ParsedSearchQuery,
  ReplyTone,
  ReplyVariant,
  ReplyVariants,
  RewriteMode,
  RewriteResult,
  Summary,
  Translation,
} from './schemas.js';

// --- Подготовка данных перед отправкой наружу ------------------------------

export {
  DEFAULT_MAX_BODY_CHARS,
  describeOutbound,
  describePlainText,
  prepareMessage,
  renderPrepared,
  stripQuotedText,
  stripSignatureBlock,
  truncateBody,
} from './sanitize.js';
export type {
  DisclosureContext,
  PreparedMessage,
  SanitizeOptions,
  StripResult,
  TruncateResult,
} from './sanitize.js';
export { decodeEntities, htmlToText, normalizeWhitespace, preview } from './text.js';
export { estimateMessagesTokens, estimateTokens } from './tokens.js';

// --- Поставщик -------------------------------------------------------------

export {
  CompatibleChatProvider,
  parseChatCompletion,
  parseSseBlock,
  readUsage,
} from './provider.js';
export type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatResult,
  ChatRole,
  ProviderDeps,
  StreamEvent,
} from './provider.js';

// --- Кэш -------------------------------------------------------------------

export {
  MemoryAiCache,
  NoopAiCache,
  RedisAiCache,
  buildCacheKey,
  fingerprint,
  messageKeyMarker,
} from './cache.js';
export type { AiCacheStore, CacheKeyParts, RedisCacheClient } from './cache.js';

// --- Ограничение расходов --------------------------------------------------

export { InMemoryBudgetTracker, RedisBudgetTracker, UnlimitedBudgetTracker } from './budget.js';
export type { BudgetDecision, BudgetSnapshot, BudgetTracker, RedisLike } from './budget.js';

// --- Журнал обращений ------------------------------------------------------

export { InMemoryAuditLog, LoggerAuditLog, NoopAuditLog, sumEntries } from './audit.js';
export type {
  AiAuditEntry,
  AiAuditFilter,
  AiAuditLog,
  AiAuditTotals,
  AuditLogger,
} from './audit.js';

// --- Формулировки запросов -------------------------------------------------

export { PROMPT_VERSIONS } from './prompts.js';

// --- Разбор ответа модели --------------------------------------------------

export { extractJsonText, parseJsonLoose, parseWithSchema } from './json.js';
export type { LooseParseFail, LooseParseOk } from './json.js';
