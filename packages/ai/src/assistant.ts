/**
 * Помощник: все возможности в одном программном интерфейсе.
 *
 * Каждый метод возвращает {@link AiOutcome} и никогда не бросает исключений —
 * отказ сервиса ИИ не должен ломать почту. Каждый успешный ответ несёт
 * опись отправленного (или null, если ответ взят из кэша и наружу
 * ничего не уходило).
 */

import {
  InMemoryAuditLog,
  NoopAuditLog,
  type AiAuditEntry,
  type AiAuditFilter,
  type AiAuditLog,
  type AiAuditTotals,
} from './audit.js';
import {
  InMemoryBudgetTracker,
  UnlimitedBudgetTracker,
  type BudgetSnapshot,
  type BudgetTracker,
} from './budget.js';
import {
  MemoryAiCache,
  buildCacheKey,
  fingerprint,
  type AiCacheStore,
} from './cache.js';
import {
  assistantOptionsSchema,
  budgetLimitsSchema,
  chatEndpoint,
  parseProviderConfig,
  type AssistantOptions,
  type AssistantOptionsInput,
  type BudgetLimitsInput,
  type ProviderConfig,
  type ProviderConfigInput,
} from './config.js';
import { parseWithSchema } from './json.js';
import {
  CompatibleChatProvider,
  type ChatMessage,
  type ChatProvider,
  type ProviderDeps,
  type StreamEvent,
} from './provider.js';
import {
  PROMPT_VERSIONS,
  classifyPrompt,
  continuePrompt,
  extractPrompt,
  replyVariantsPrompt,
  rewritePrompt,
  searchQueryPrompt,
  summarizeMessagePrompt,
  summarizeThreadPrompt,
  translatePrompt,
} from './prompts.js';
import {
  classificationSchema,
  continuationSchema,
  extractionSchema,
  replyVariantsSchema,
  rewriteSchema,
  searchQuerySchema,
  summarySchema,
  translationSchema,
  type Classification,
  type Continuation,
  type Extraction,
  type ParsedSearchQuery,
  type ReplyTone,
  type ReplyVariants,
  type RewriteMode,
  type RewriteResult,
  type Summary,
  type Translation,
} from './schemas.js';
import {
  describeOutbound,
  describePlainText,
  prepareMessage,
  renderPrepared,
  type DisclosureContext,
  type PreparedMessage,
} from './sanitize.js';
import { estimateMessagesTokens } from './tokens.js';
import {
  ZERO_USAGE,
  aiFail,
  aiOk,
  type AiFailureResult,
  type AiFeature,
  type AiOutcome,
  type AiSourceMessage,
  type OutboundDisclosure,
  type TokenUsage,
} from './types.js';
import type { z } from 'zod';

/** Кто и в каком контексте вызывает помощника. */
export interface AiCallContext {
  /** Ящик, которому засчитывается расход. Обязателен для журнала и лимитов. */
  accountId: string;
  /** Язык ответа; по умолчанию берётся из настроек помощника. */
  language?: string;
  /** Отмена запроса снаружи (пользователь ушёл со страницы). */
  signal?: AbortSignal;
  /** Не читать и не писать кэш для этого вызова. */
  skipCache?: boolean;
}

export interface MailAssistantDeps {
  cache?: AiCacheStore;
  budget?: BudgetTracker;
  audit?: AiAuditLog;
  provider?: ChatProvider;
  providerDeps?: ProviderDeps;
  now?: () => number;
}

export interface MailAssistantInit {
  provider: ProviderConfigInput;
  limits?: BudgetLimitsInput;
  options?: AssistantOptionsInput;
  deps?: MailAssistantDeps;
}

export type CreateAssistantResult =
  | { ok: true; assistant: MailAssistant }
  | { ok: false; message: string; issues: string[] };

interface RunParams<S extends z.ZodTypeAny> {
  feature: AiFeature;
  /** Идентификатор письма или цепочки для кэша и журнала. */
  messageId: string | null;
  system: string;
  user: string;
  disclosure: OutboundDisclosure;
  schema: S;
  /** Всё, что влияет на результат помимо текста: тон, язык, режим. */
  variant: Record<string, unknown>;
  ctx: AiCallContext;
  temperature?: number;
  /**
   * Нижняя граница предела длины ответа для этой возможности.
   * Именно нижняя: max_tokens — это потолок, а не расход, и слишком
   * маленький потолок обрывает модели с «размышлением» до того,
   * как они дойдут до полезного ответа.
   */
  minOutputTokens?: number;
}

export class MailAssistant {
  readonly #config: ProviderConfig;
  readonly #options: AssistantOptions;
  readonly #provider: ChatProvider;
  readonly #cache: AiCacheStore;
  readonly #budget: BudgetTracker;
  readonly #audit: AiAuditLog;
  readonly #now: () => number;

  private constructor(init: {
    config: ProviderConfig;
    options: AssistantOptions;
    provider: ChatProvider;
    cache: AiCacheStore;
    budget: BudgetTracker;
    audit: AiAuditLog;
    now: () => number;
  }) {
    this.#config = init.config;
    this.#options = init.options;
    this.#provider = init.provider;
    this.#cache = init.cache;
    this.#budget = init.budget;
    this.#audit = init.audit;
    this.#now = init.now;
  }

  /**
   * Создаёт помощника, проверив настройки.
   * Неверные настройки — не авария: вернётся понятный отказ, и API
   * просто не покажет кнопки ИИ.
   */
  static create(init: MailAssistantInit): CreateAssistantResult {
    const parsed = parseProviderConfig(init.provider);
    if (!parsed.ok) return { ok: false, message: parsed.message, issues: parsed.issues };

    const limits = budgetLimitsSchema.safeParse(init.limits ?? {});
    if (!limits.success) {
      return {
        ok: false,
        message: 'Ограничения расходов заданы неверно',
        issues: limits.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    const options = assistantOptionsSchema.safeParse(init.options ?? {});
    if (!options.success) {
      return {
        ok: false,
        message: 'Настройки помощника заданы неверно',
        issues: options.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    const deps = init.deps ?? {};
    const now = deps.now ?? ((): number => Date.now());
    const hasLimits =
      limits.data.maxRequestsPerPeriod !== null ||
      limits.data.maxTokensPerPeriod !== null ||
      limits.data.maxTokensPerRequest !== null;

    return {
      ok: true,
      assistant: new MailAssistant({
        config: parsed.config,
        options: options.data,
        provider:
          deps.provider ?? new CompatibleChatProvider(parsed.config, deps.providerDeps ?? {}),
        cache: deps.cache ?? new MemoryAiCache({ now }),
        budget:
          deps.budget ??
          (hasLimits
            ? new InMemoryBudgetTracker(limits.data, now)
            : new UnlimitedBudgetTracker(limits.data)),
        audit: deps.audit ?? new InMemoryAuditLog(),
        now,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Сведения о состоянии
  // -------------------------------------------------------------------------

  /** Включён ли помощник. Если нет — интерфейс не должен показывать кнопки. */
  get enabled(): boolean {
    return this.#config.enabled;
  }

  get endpoint(): string {
    return chatEndpoint(this.#config);
  }

  get model(): string {
    return this.#config.model;
  }

  /** Модель поднята внутри периметра: письма не покидают сервер. */
  get local(): boolean {
    return this.#config.local;
  }

  #disclosureContext(): DisclosureContext {
    return {
      endpoint: this.endpoint,
      model: this.#config.model,
      providerLabel: this.#config.providerLabel,
      local: this.#config.local,
    };
  }

  /**
   * Что именно уйдёт наружу для этого письма — БЕЗ отправки.
   * Нужно, чтобы показать пользователю опись до нажатия кнопки.
   */
  previewOutbound(message: AiSourceMessage): OutboundDisclosure {
    const prepared = prepareMessage(message, { maxBodyChars: this.#config.maxBodyChars });
    return describeOutbound(prepared, this.#disclosureContext());
  }

  /** Расход по ящику за текущий период. */
  budgetSnapshot(accountId: string): Promise<BudgetSnapshot> {
    return this.#budget.snapshot(accountId);
  }

  /** Журнал обращений — для проверки администратором. */
  auditList(filter?: AiAuditFilter): Promise<AiAuditEntry[]> {
    return this.#audit.list(filter);
  }

  auditTotals(filter?: AiAuditFilter): Promise<AiAuditTotals> {
    return this.#audit.totals(filter);
  }

  /**
   * Забыть всё, что помощник насчитал по письму.
   * Требование спецификации: пользователь должен уметь удалить
   * созданные резюме и метки.
   */
  forgetMessage(messageId: string): Promise<number> {
    return this.#cache.deleteByMessage(messageId);
  }

  // -------------------------------------------------------------------------
  // Возможности
  // -------------------------------------------------------------------------

  /** Краткое резюме одного письма. */
  async summarizeMessage(
    message: AiSourceMessage,
    ctx: AiCallContext,
  ): Promise<AiOutcome<Summary>> {
    const prepared = this.#prepare(message);
    if (prepared.body.length === 0 && prepared.subject.length === 0) {
      return aiFail('invalid-input', 'В письме нет текста для пересказа', { retryable: false });
    }
    const language = this.#language(ctx);
    return this.#run({
      feature: 'summarize.message',
      messageId: message.id,
      system: summarizeMessagePrompt(language),
      user: renderPrepared(prepared),
      disclosure: describeOutbound(prepared, this.#disclosureContext()),
      schema: summarySchema,
      variant: { language },
      ctx,
    });
  }

  /** Краткое резюме всей цепочки. */
  async summarizeThread(
    messages: readonly AiSourceMessage[],
    ctx: AiCallContext,
  ): Promise<AiOutcome<Summary>> {
    if (messages.length === 0) {
      return aiFail('invalid-input', 'Цепочка пуста', { retryable: false });
    }
    const prepared = messages.map((m) => this.#prepare(m));
    const language = this.#language(ctx);
    const user = prepared
      .map((p, index) => `--- Письмо ${String(index + 1)} ---\n${renderPrepared(p)}`)
      .join('\n\n');
    const threadId = messages[0]?.threadId ?? messages[0]?.id ?? null;

    return this.#run({
      feature: 'summarize.thread',
      messageId: threadId,
      system: summarizeThreadPrompt(language),
      user,
      disclosure: describeOutbound(prepared, this.#disclosureContext()),
      schema: summarySchema,
      variant: { language, count: messages.length },
      ctx,
    });
  }

  /** Разбор письма по смыслу: счета, доставки, встречи, договоры, личное… */
  async classifyMessage(
    message: AiSourceMessage,
    ctx: AiCallContext,
  ): Promise<AiOutcome<Classification>> {
    const prepared = this.#prepare(message, { maxBodyChars: 2000 });
    const language = this.#language(ctx);
    return this.#run({
      feature: 'classify',
      messageId: message.id,
      system: classifyPrompt(language),
      user: renderPrepared(prepared),
      disclosure: describeOutbound(prepared, this.#disclosureContext()),
      schema: classificationSchema,
      variant: { language },
      ctx,
      temperature: 0,
    });
  }

  /** Варианты ответа с разным тоном. */
  async suggestReplies(
    message: AiSourceMessage,
    ctx: AiCallContext,
    options?: { tones?: readonly ReplyTone[]; instruction?: string },
  ): Promise<AiOutcome<ReplyVariants>> {
    const tones = options?.tones ?? (['short', 'detailed', 'formal'] as const);
    if (tones.length === 0) {
      return aiFail('invalid-input', 'Не указан ни один тон ответа', { retryable: false });
    }
    const prepared = this.#prepare(message);
    const language = this.#language(ctx);
    const instruction = options?.instruction?.trim() ?? '';
    const user =
      instruction.length > 0
        ? `${renderPrepared(prepared)}\n\nПожелание к ответу: ${instruction}`
        : renderPrepared(prepared);

    const disclosure = describeOutbound(prepared, this.#disclosureContext());
    if (instruction.length > 0) {
      disclosure.fields.push({
        field: 'instruction',
        label: 'Пожелание к ответу',
        value: instruction,
        chars: instruction.length,
      });
      disclosure.totalChars += instruction.length;
    }

    return this.#run({
      feature: 'reply.variants',
      messageId: message.id,
      system: replyVariantsPrompt(language, tones),
      user,
      disclosure,
      schema: replyVariantsSchema,
      variant: { language, tones: [...tones], instruction },
      ctx,
      temperature: 0.6,
    });
  }

  /** Продолжение начатой пользователем фразы. */
  async continueWriting(
    input: { draft: string; message?: AiSourceMessage | null },
    ctx: AiCallContext,
  ): Promise<AiOutcome<Continuation>> {
    const draft = input.draft;
    if (draft.trim().length === 0) {
      return aiFail('invalid-input', 'Нечего продолжать: текст пуст', { retryable: false });
    }
    const language = this.#language(ctx);
    const context = this.#disclosureContext();

    let user = `Начатый текст:\n${draft}`;
    let disclosure = describePlainText('Начатый текст', draft, context);
    let messageId: string | null = null;

    if (input.message) {
      const prepared = this.#prepare(input.message, { maxBodyChars: 3000 });
      user = `Письмо, на которое отвечает пользователь:\n${renderPrepared(prepared)}\n\nНачатый текст:\n${draft}`;
      disclosure = describeOutbound(prepared, context);
      disclosure.fields.push({
        field: 'draft',
        label: 'Начатый текст',
        value: draft,
        chars: draft.length,
      });
      disclosure.totalChars += draft.length;
      messageId = input.message.id;
    }

    return this.#run({
      feature: 'reply.continue',
      messageId,
      system: continuePrompt(language),
      user,
      disclosure,
      schema: continuationSchema,
      variant: { language, draft: fingerprint(draft) },
      ctx,
      temperature: 0.5,
      minOutputTokens: 256,
    });
  }

  /** Правка текста: сократить, смягчить, исправить ошибки. */
  async rewriteText(
    text: string,
    mode: RewriteMode,
    ctx: AiCallContext,
  ): Promise<AiOutcome<RewriteResult>> {
    if (text.trim().length === 0) {
      return aiFail('invalid-input', 'Текст для правки пуст', { retryable: false });
    }
    const language = this.#language(ctx);
    return this.#run({
      feature: 'rewrite',
      messageId: null,
      system: rewritePrompt(language, mode),
      user: text,
      disclosure: describePlainText('Текст для правки', text, this.#disclosureContext()),
      schema: rewriteSchema,
      variant: { language, mode },
      ctx,
      temperature: mode === 'fix' ? 0 : 0.4,
    });
  }

  /** Извлечение дат, сумм, реквизитов, задач и номеров отслеживания. */
  async extractData(
    message: AiSourceMessage,
    ctx: AiCallContext,
  ): Promise<AiOutcome<Extraction>> {
    const prepared = this.#prepare(message);
    const language = this.#language(ctx);
    return this.#run({
      feature: 'extract',
      messageId: message.id,
      system: extractPrompt(language, this.#today()),
      user: renderPrepared(prepared),
      disclosure: describeOutbound(prepared, this.#disclosureContext()),
      schema: extractionSchema,
      variant: { language, today: this.#today() },
      ctx,
      temperature: 0,
      minOutputTokens: 1500,
    });
  }

  /** Перевод письма с сохранением разметки. */
  async translateMessage(
    message: AiSourceMessage,
    targetLanguage: string,
    ctx: AiCallContext,
  ): Promise<AiOutcome<Translation>> {
    const prepared = this.#prepare(message);
    if (prepared.body.length === 0) {
      return aiFail('invalid-input', 'В письме нет текста для перевода', { retryable: false });
    }
    return this.#run({
      feature: 'translate',
      messageId: message.id,
      system: translatePrompt(targetLanguage),
      user: prepared.body,
      disclosure: describePlainText(
        'Текст письма',
        prepared.body,
        this.#disclosureContext(),
      ),
      schema: translationSchema,
      variant: { targetLanguage },
      ctx,
      temperature: 0.1,
      minOutputTokens: 2000,
    });
  }

  /** Перевод произвольного фрагмента с сохранением разметки. */
  async translateText(
    text: string,
    targetLanguage: string,
    ctx: AiCallContext,
  ): Promise<AiOutcome<Translation>> {
    if (text.trim().length === 0) {
      return aiFail('invalid-input', 'Текст для перевода пуст', { retryable: false });
    }
    return this.#run({
      feature: 'translate',
      messageId: null,
      system: translatePrompt(targetLanguage),
      user: text,
      disclosure: describePlainText('Текст для перевода', text, this.#disclosureContext()),
      schema: translationSchema,
      variant: { targetLanguage },
      ctx,
      temperature: 0.1,
      minOutputTokens: 2000,
    });
  }

  /**
   * Превращает запрос обычными словами в параметры поиска.
   * Поле `explanation` возвращается всегда — интерфейс обязан показать
   * пользователю, во что превратился его запрос.
   */
  async parseSearchQuery(
    query: string,
    ctx: AiCallContext,
  ): Promise<AiOutcome<ParsedSearchQuery>> {
    if (query.trim().length === 0) {
      return aiFail('invalid-input', 'Поисковый запрос пуст', { retryable: false });
    }
    const language = this.#language(ctx);
    return this.#run({
      feature: 'search.query',
      messageId: null,
      system: searchQueryPrompt(language, this.#today()),
      user: query,
      disclosure: describePlainText('Поисковый запрос', query, this.#disclosureContext()),
      schema: searchQuerySchema,
      variant: { language, today: this.#today() },
      ctx,
      temperature: 0,
      minOutputTokens: 600,
    });
  }

  // -------------------------------------------------------------------------
  // Потоковая выдача
  // -------------------------------------------------------------------------

  /**
   * Черновик ответа с потоковой выдачей: текст появляется по мере
   * генерации. Кэш здесь не используется — ответ каждый раз новый.
   *
   * Первое событие — `disclosure`: интерфейс покажет, что уходит наружу,
   * ещё до появления первой буквы ответа.
   */
  async *streamReply(
    message: AiSourceMessage,
    ctx: AiCallContext,
    options?: { tone?: ReplyTone; instruction?: string },
  ): AsyncGenerator<StreamEvent | { type: 'disclosure'; disclosure: OutboundDisclosure }, void, void> {
    if (!this.#config.enabled) {
      yield { type: 'error', error: this.#disabled().error };
      return;
    }

    const prepared = this.#prepare(message);
    const language = this.#language(ctx);
    const tone = options?.tone ?? 'short';
    const instruction = options?.instruction?.trim() ?? '';
    const disclosure = describeOutbound(prepared, this.#disclosureContext());
    yield { type: 'disclosure', disclosure };

    const system = [
      replyVariantsPrompt(language, [tone]),
      'ВАЖНО: в этом режиме ответь обычным текстом письма, без JSON.',
    ].join(' ');
    const user =
      instruction.length > 0
        ? `${renderPrepared(prepared)}\n\nПожелание к ответу: ${instruction}`
        : renderPrepared(prepared);

    const estimated = estimateMessagesTokens([system, user]);
    const decision = await this.#budget.check(ctx.accountId, estimated);
    if (!decision.allowed) {
      await this.#record({
        ctx,
        feature: 'reply.variants',
        messageId: message.id,
        usage: ZERO_USAGE,
        cached: false,
        outboundChars: 0,
        durationMs: 0,
        ok: false,
        errorKind: decision.error.kind,
      });
      yield { type: 'error', error: decision.error };
      return;
    }

    const started = this.#now();
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    const request = {
      messages,
      temperature: 0.6,
      maxTokens: this.#config.maxOutputTokens,
    };

    for await (const event of this.#provider.stream(request, ctx.signal)) {
      if (event.type === 'done') {
        await this.#budget.record(ctx.accountId, event.usage);
        await this.#record({
          ctx,
          feature: 'reply.variants',
          messageId: message.id,
          usage: event.usage,
          cached: false,
          outboundChars: disclosure.totalChars,
          durationMs: this.#now() - started,
          ok: true,
          errorKind: null,
        });
      } else if (event.type === 'error') {
        await this.#record({
          ctx,
          feature: 'reply.variants',
          messageId: message.id,
          usage: ZERO_USAGE,
          cached: false,
          outboundChars: disclosure.totalChars,
          durationMs: this.#now() - started,
          ok: false,
          errorKind: event.error.kind,
        });
      }
      yield event;
    }
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  #prepare(message: AiSourceMessage, options?: { maxBodyChars?: number }): PreparedMessage {
    return prepareMessage(message, {
      maxBodyChars: options?.maxBodyChars ?? this.#config.maxBodyChars,
    });
  }

  #language(ctx: AiCallContext): string {
    return ctx.language ?? this.#options.defaultLanguage;
  }

  #today(): string {
    return new Date(this.#now()).toISOString().slice(0, 10);
  }

  #disabled(): AiFailureResult {
    return aiFail(
      'disabled',
      'Помощник на основе ИИ выключен. Включить его может администратор домена',
      { retryable: false },
    );
  }

  /** Общий путь всех возможностей: кэш → предел расходов → вызов → журнал. */
  async #run<S extends z.ZodTypeAny>(params: RunParams<S>): Promise<AiOutcome<z.output<S>>> {
    if (!this.#config.enabled) return this.#disabled();

    const started = this.#now();
    const messages: ChatMessage[] = [
      { role: 'system', content: params.system },
      { role: 'user', content: params.user },
    ];

    const cacheKey = buildCacheKey({
      feature: params.feature,
      promptVersion: PROMPT_VERSIONS[params.feature],
      model: this.#config.model,
      messageId: params.messageId,
      variant: params.variant,
      contentFingerprint: fingerprint(`${params.system}\n---\n${params.user}`),
    });

    // 1. Кэш: повторный запрос наружу не идёт.
    if (ctxUsesCache(params.ctx)) {
      const cached = await this.#cache.get(cacheKey);
      if (cached !== null) {
        const restored = parseWithSchema(cached, params.schema);
        if (restored.ok) {
          await this.#record({
            ctx: params.ctx,
            feature: params.feature,
            messageId: params.messageId,
            usage: ZERO_USAGE,
            cached: true,
            outboundChars: 0,
            durationMs: this.#now() - started,
            ok: true,
            errorKind: null,
          });
          return aiOk(restored.value, {
            usage: ZERO_USAGE,
            cached: true,
            disclosure: null,
            durationMs: this.#now() - started,
          });
        }
        // Запись повреждена — выбрасываем и идём обычным путём.
        await this.#cache.delete(cacheKey);
      }
    }

    // 2. Предел расходов — до отправки, а не после.
    const estimated = estimateMessagesTokens([params.system, params.user]);
    const decision = await this.#budget.check(params.ctx.accountId, estimated);
    if (!decision.allowed) {
      await this.#record({
        ctx: params.ctx,
        feature: params.feature,
        messageId: params.messageId,
        usage: ZERO_USAGE,
        cached: false,
        outboundChars: 0,
        durationMs: this.#now() - started,
        ok: false,
        errorKind: decision.error.kind,
      });
      return { ok: false, error: decision.error };
    }

    // 3. Вызов сервиса.
    const request = {
      messages,
      json: true,
      ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
      maxTokens: Math.max(
        this.#config.maxOutputTokens,
        params.minOutputTokens ?? 0,
      ),
    };
    const response = await this.#provider.chat(request, params.ctx.signal);

    if (!response.ok) {
      await this.#record({
        ctx: params.ctx,
        feature: params.feature,
        messageId: params.messageId,
        usage: ZERO_USAGE,
        cached: false,
        outboundChars: params.disclosure.totalChars,
        durationMs: this.#now() - started,
        ok: false,
        errorKind: response.error.kind,
      });
      return response;
    }

    const usage: TokenUsage = response.value.usage;
    await this.#budget.record(params.ctx.accountId, usage);

    // 4. Разбор ответа: искажённый ответ не должен ронять почту.
    const parsed = parseWithSchema(response.value.text, params.schema);
    if (!parsed.ok) {
      await this.#record({
        ctx: params.ctx,
        feature: params.feature,
        messageId: params.messageId,
        usage,
        cached: false,
        outboundChars: params.disclosure.totalChars,
        durationMs: this.#now() - started,
        ok: false,
        errorKind: parsed.error.kind,
      });
      return parsed;
    }

    // 5. Кэш и журнал.
    if (ctxUsesCache(params.ctx)) {
      await this.#cache.set(
        cacheKey,
        JSON.stringify(parsed.value),
        this.#options.cacheTtlSeconds,
      );
    }
    await this.#record({
      ctx: params.ctx,
      feature: params.feature,
      messageId: params.messageId,
      usage,
      cached: false,
      outboundChars: params.disclosure.totalChars,
      durationMs: this.#now() - started,
      ok: true,
      errorKind: null,
    });

    return aiOk(parsed.value, {
      usage,
      cached: false,
      disclosure: params.disclosure,
      durationMs: this.#now() - started,
    });
  }

  async #record(input: {
    ctx: AiCallContext;
    feature: AiFeature;
    messageId: string | null;
    usage: TokenUsage;
    cached: boolean;
    outboundChars: number;
    durationMs: number;
    ok: boolean;
    errorKind: AiAuditEntry['errorKind'];
  }): Promise<void> {
    try {
      await this.#audit.record({
        at: new Date(this.#now()).toISOString(),
        accountId: input.ctx.accountId,
        messageId: input.messageId,
        feature: input.feature,
        promptVersion: PROMPT_VERSIONS[input.feature],
        endpoint: this.endpoint,
        model: this.#config.model,
        local: this.#config.local,
        usage: input.usage,
        cached: input.cached,
        outboundChars: input.outboundChars,
        durationMs: input.durationMs,
        ok: input.ok,
        errorKind: input.errorKind,
      });
    } catch {
      // Журнал не должен ломать основной путь.
    }
  }
}

function ctxUsesCache(ctx: AiCallContext): boolean {
  return ctx.skipCache !== true;
}

/** Помощник, который всегда отвечает «выключено». Удобно, когда ИИ запрещён. */
export function disabledAssistant(): MailAssistant {
  const created = MailAssistant.create({
    provider: {
      enabled: false,
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'disabled',
    },
    deps: { audit: new NoopAuditLog() },
  });
  if (!created.ok) throw new Error(created.message);
  return created.assistant;
}
