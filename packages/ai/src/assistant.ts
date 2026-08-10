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
import { InMemoryBudgetTracker, type BudgetSnapshot, type BudgetTracker } from './budget.js';
import { MemoryAiCache, buildCacheKey, fingerprint, type AiCacheStore } from './cache.js';
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
  chatPrompt,
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
  logoHintSchema,
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
  describeBodyOnly,
  describePlainText,
  prepareMessage,
  renderPrepared,
  type DisclosureContext,
  type PreparedMessage,
} from './sanitize.js';
import { estimateMessagesTokens, estimateTokens } from './tokens.js';
import {
  ZERO_USAGE,
  aiFail,
  aiOk,
  type AiError,
  type AiErrorKind,
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
  { ok: true; assistant: MailAssistant } | { ok: false; message: string; issues: string[] };

/**
 * Отказы, при которых модель успела поработать, а значит поставщик уже
 * выставит счёт.
 *
 * `timeout` и `aborted` — ответ генерировался, просто мы его не дождались
 * или отменили; `bad-response` — ответ пришёл целиком, не разобралась
 * только его форма. Всё остальное (сеть, 4xx/5xx до генерации) означает,
 * что до модели не дошло, и занимать чужой предел таким отказом нечестно.
 */
const SPENT_ON_FAILURE = new Set<AiErrorKind>(['timeout', 'aborted', 'bad-response']);

interface RunParams<S extends z.ZodTypeAny> {
  feature: AiFeature;
  /** Идентификатор письма или цепочки для кэша и журнала. */
  messageId: string | null;
  /** Письма, которых результат касается помимо messageId (цепочка). */
  relatedIds?: readonly string[];
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

    return {
      ok: true,
      assistant: new MailAssistant({
        config: parsed.config,
        options: options.data,
        provider:
          deps.provider ?? new CompatibleChatProvider(parsed.config, deps.providerDeps ?? {}),
        cache: deps.cache ?? new MemoryAiCache({ now }),
        /*
         * Учёт в памяти ставится всегда, даже когда пределов нет: он
         * считает честно и без них, а «учёт без ограничений», который
         * стоял здесь раньше, показывал в /state и /usage нули при живом
         * расходе — человек видел полный остаток там, где токены уже
         * потрачены.
         */
        budget: deps.budget ?? new InMemoryBudgetTracker(limits.data, now),
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
      /*
       * Сводка переписки лежит в кэше под идентификатором ЦЕПОЧКИ, а
       * «Забыть результаты по этому письму» ищет по идентификатору
       * ПИСЬМА. Перечисляем письма, из которых сводка собрана: тогда
       * удаление по любому из них её находит. Без этого человек жал
       * «Забыть», получал «Удалено записей: N» — и следующий же «Кратко»
       * возвращал ту же сводку из кэша, живущего 30 суток.
       */
      relatedIds: messages.map((m) => m.id),
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
  async extractData(message: AiSourceMessage, ctx: AiCallContext): Promise<AiOutcome<Extraction>> {
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
      /*
       * Опись перечисляет и ВЫРЕЗАННОЕ: цитаты, подпись, хвост письма
       * длиннее предела. Раньше здесь стояла describePlainText, у которой
       * `removed` пуст по определению, — и панель «Что ушло наружу»
       * говорила «вырезано: ничего». Для перевода это хуже, чем для
       * пересказа: перевод ЗАМЕНЯЕТ письмо на экране, и не попавшая в
       * него часть просто исчезает из виду.
       */
      disclosure: describeBodyOnly('Текст письма', prepared, this.#disclosureContext()),
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
  async parseSearchQuery(query: string, ctx: AiCallContext): Promise<AiOutcome<ParsedSearchQuery>> {
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

  /**
   * Где на сайте домена лежит файл логотипа.
   *
   * Метод живёт здесь, а не в модуле логотипов, по той же причине, что и
   * все остальные: только через #run обращение проходит проверку предела
   * расходов, попадает в журнал обращений и получает опись того, что
   * ушло наружу. Модуль логотипов раньше создавал провайдера сам и звал
   * его напрямую — и обходил всё перечисленное разом, включая согласие
   * пользователя.
   *
   * Наружу уходит ОДНО СЛОВО — доменное имя отправителя. Ни адреса, ни
   * темы, ни текста письма здесь нет и быть не может: сам вызывающий их
   * не знает.
   */
  async logoHint(domain: string, ctx: AiCallContext): Promise<AiOutcome<{ url: string | null }>> {
    const value = domain.trim().toLowerCase();
    if (value === '') {
      return aiFail('invalid-input', 'Домен пуст', { retryable: false });
    }
    return this.#run({
      feature: 'logo.hint',
      messageId: null,
      system:
        'Ты помогаешь почтовому серверу найти файл логотипа компании на её собственном сайте. ' +
        'Верни адрес https, ведущий на файл картинки (png, svg, jpg, webp, ico) ВНУТРИ ' +
        'указанного домена или его поддомена. Не знаешь точного адреса — верни null. ' +
        'Не придумывай адреса на других доменах. ' +
        'Ответь ТОЛЬКО объектом JSON вида {"url": "https://…"} или {"url": null}.',
      user: `Домен: ${value}`,
      disclosure: describePlainText('Домен отправителя', value, this.#disclosureContext()),
      schema: logoHintSchema,
      variant: {},
      ctx,
      // Ноль намеренно: нужен либо известный адрес, либо честное «не знаю».
      temperature: 0,
      minOutputTokens: 200,
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
  ): AsyncGenerator<
    StreamEvent | { type: 'disclosure'; disclosure: OutboundDisclosure },
    void,
    void
  > {
    if (!this.#config.enabled) {
      yield { type: 'error', error: this.#disabled().error };
      return;
    }

    const prepared = this.#prepare(message);
    const language = this.#language(ctx);
    const tone = options?.tone ?? 'short';
    const instruction = options?.instruction?.trim() ?? '';
    /*
     * Опись СТРОИТСЯ ДО ОТПРАВКИ И ВКЛЮЧАЕТ ВСЁ, что уйдёт наружу.
     *
     * Пожелание к ответу дописывается в текст запроса ниже, а опись
     * отдавалась клиенту до этого — то есть человеку и администратору
     * показывалось меньше, чем ушло к сервису ИИ, и `outboundChars` в
     * журнале тоже считался без него. Обещание модуля («опись строится из
     * тех же полей, из которых собирается запрос, поэтому не может
     * разойтись с содержимым») здесь нарушалось. В соседнем, не потоковом
     * пути это поле в опись добавляют явно — значит был пропуск, а не
     * решение.
     */
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
    yield { type: 'disclosure', disclosure };

    const system = [
      replyVariantsPrompt(language, [tone]),
      'ВАЖНО: в этом режиме ответь обычным текстом письма, без JSON.',
    ].join(' ');
    const user =
      instruction.length > 0
        ? `${renderPrepared(prepared)}\n\nПожелание к ответу: ${instruction}`
        : renderPrepared(prepared);

    const promptTokens = estimateMessagesTokens([system, user]);
    const decision = await this.#budget.reserve(
      ctx.accountId,
      promptTokens + this.#config.maxOutputTokens,
      promptTokens,
    );
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
    const reserved = decision.reserved;

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

    /*
     * УЧЁТ ЗАКРЫВАЕТСЯ РОВНО ОДИН РАЗ И ПРИ ЛЮБОМ ИСХОДЕ.
     *
     * Раньше расход записывался только по событию `done`. Но при обрыве
     * (человек закрыл вкладку, маршрут дёрнул abort) поставщик отдаёт
     * `error`, а `done` не наступает вовсе — и не росли ни токены, ни
     * счётчик обращений, хотя модель текст уже сгенерировала и поставщик
     * его тарифицировал. Повторяя обрыв, можно было тратить бюджет
     * домена без единого следа в учёте и в журнале обращений.
     *
     * Поэтому закрытие вынесено в функцию, и она же зовётся из finally:
     * генератор может быть брошен потребителем на середине, и тогда
     * события `error` не будет тоже.
     */
    let text = '';
    let settled = false;
    const settle = async (usage: TokenUsage | null, error: AiError | null): Promise<void> => {
      if (settled) return;
      settled = true;
      await this.#budget.settle(ctx.accountId, reserved, usage);
      await this.#record({
        ctx,
        feature: 'reply.variants',
        messageId: message.id,
        usage: usage ?? ZERO_USAGE,
        cached: false,
        outboundChars: disclosure.totalChars,
        durationMs: this.#now() - started,
        ok: error === null,
        errorKind: error?.kind ?? null,
      });
    };

    /** Сколько израсходовано, когда поставщик так и не сказал этого сам. */
    const guessedUsage = (): TokenUsage => ({
      promptTokens,
      completionTokens: estimateTokens(text),
      totalTokens: promptTokens + estimateTokens(text),
      estimated: true,
    });

    try {
      for await (const event of this.#provider.stream(request, ctx.signal)) {
        if (event.type === 'delta') {
          text += event.text;
        } else if (event.type === 'done') {
          await settle(event.usage, null);
        } else {
          /*
           * Сгенерированный до ошибки текст оплачен, поэтому в учёт идёт
           * оценка по нему. Отказ, при котором модель ничего не делала
           * (сеть, отклонённый ключ), резерв возвращает целиком.
           */
          const spent = SPENT_ON_FAILURE.has(event.error.kind) || text.length > 0;
          await settle(spent ? guessedUsage() : null, event.error);
        }
        yield event;
      }
    } finally {
      // Поток бросили на середине: событий больше не будет, но модель
      // работала — расход обязан попасть и в предел, и в журнал.
      await settle(
        text.length > 0 ? guessedUsage() : null,
        aiFail('aborted', 'Поток черновика прерван').error,
      );
    }
  }

  /**
   * Свободный разговор с потоковой выдачей.
   *
   * ------------------------------------------------------------------
   * ЧЕМ ОТЛИЧАЕТСЯ ОТ ОСТАЛЬНЫХ ВОЗМОЖНОСТЕЙ
   * ------------------------------------------------------------------
   * У всех прочих на входе письмо: его разбирают, вырезают лишнее,
   * составляют опись отправляемого. Здесь письма нет вовсе — уходит
   * ровно то, что человек написал сам, и опись это честно называет.
   * Ни ящик, ни настройки сервера сюда не попадают, и никаких средств
   * до них добраться у модели нет.
   *
   * ------------------------------------------------------------------
   * ПОЧЕМУ ИСТОРИЯ ПРИХОДИТ ЦЕЛИКОМ
   * ------------------------------------------------------------------
   * Разговор без памяти бесполезен, а хранить его на сервере — значит
   * завести ещё одно место, где лежит переписка человека. История живёт
   * у клиента и присылается с каждым вопросом: сервер её не запоминает,
   * и закрытая вкладка стирает разговор насовсем.
   *
   * Обратная сторона — расход: каждый вопрос оплачивается вместе со
   * всей историей. Поэтому её длину ограничивает вызывающий, а учёт
   * считает ровно то, что ушло.
   *
   * `systemExtra` — добавка к правилам для админского разговора: там
   * модели рассказывают об устройстве этого сервера. Ничего исполняемого
   * в ней нет и быть не может — это текст.
   */
  async *streamChat(
    history: readonly { role: 'user' | 'assistant'; content: string }[],
    ctx: AiCallContext,
    options?: { systemExtra?: string },
  ): AsyncGenerator<
    StreamEvent | { type: 'disclosure'; disclosure: OutboundDisclosure },
    void,
    void
  > {
    if (!this.#config.enabled) {
      yield { type: 'error', error: this.#disabled().error };
      return;
    }
    const turns = history.filter((item) => item.content.trim() !== '');
    if (turns.length === 0) {
      yield {
        type: 'error',
        error: aiFail('invalid-input', 'Нечего спрашивать: сообщение пустое').error,
      };
      return;
    }

    const system = chatPrompt(this.#language(ctx), options?.systemExtra);
    const chars = turns.reduce((sum, item) => sum + item.content.length, 0);

    /*
     * Опись для разговора проще письменной, но нужна ровно так же:
     * человек имеет право видеть, что именно уходит наружу и куда. Поля
     * перечисляют его собственные реплики — их он и отправляет.
     */
    const disclosure: OutboundDisclosure = {
      endpoint: this.endpoint,
      model: this.#config.model,
      providerLabel: this.#config.providerLabel,
      local: this.#config.local,
      fields: [
        {
          field: 'chat',
          label: turns.length === 1 ? 'Ваш вопрос' : 'Ваш вопрос и предыдущие реплики разговора',
          value: turns[turns.length - 1]?.content ?? '',
          chars,
        },
      ],
      removed: [],
      attachmentsExcluded: [],
      totalChars: chars,
      approxTokens: estimateMessagesTokens([system, ...turns.map((item) => item.content)]),
    };
    yield { type: 'disclosure', disclosure };

    const promptTokens = disclosure.approxTokens;
    const decision = await this.#budget.reserve(
      ctx.accountId,
      promptTokens + this.#config.maxOutputTokens,
      promptTokens,
    );
    if (!decision.allowed) {
      await this.#record({
        ctx,
        feature: 'chat',
        messageId: null,
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
    const reserved = decision.reserved;

    const started = this.#now();
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...turns.map((item) => ({ role: item.role, content: item.content })),
    ];

    let text = '';
    let settled = false;
    const settle = async (usage: TokenUsage | null, error: AiError | null): Promise<void> => {
      if (settled) return;
      settled = true;
      await this.#budget.settle(ctx.accountId, reserved, usage);
      await this.#record({
        ctx,
        feature: 'chat',
        messageId: null,
        usage: usage ?? ZERO_USAGE,
        cached: false,
        outboundChars: disclosure.totalChars,
        durationMs: this.#now() - started,
        ok: error === null,
        errorKind: error?.kind ?? null,
      });
    };

    const guessedUsage = (): TokenUsage => ({
      promptTokens,
      completionTokens: estimateTokens(text),
      totalTokens: promptTokens + estimateTokens(text),
      estimated: true,
    });

    try {
      for await (const event of this.#provider.stream(
        { messages, temperature: 0.7, maxTokens: this.#config.maxOutputTokens },
        ctx.signal,
      )) {
        if (event.type === 'delta') {
          text += event.text;
        } else if (event.type === 'done') {
          await settle(event.usage, null);
        } else {
          const spent = SPENT_ON_FAILURE.has(event.error.kind) || text.length > 0;
          await settle(spent ? guessedUsage() : null, event.error);
        }
        yield event;
      }
    } finally {
      // Разговор бросили на середине — модель всё равно работала.
      await settle(
        text.length > 0 ? guessedUsage() : null,
        aiFail('aborted', 'Разговор прерван').error,
      );
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
      ...(params.relatedIds === undefined ? {} : { relatedIds: params.relatedIds }),
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
    //
    // Резервируем запрос ВМЕСТЕ с потолком ответа: пока модель думает,
    // счётчик уже занят, и параллельные вызовы видят его. Раньше расход
    // записывался после ответа, и двадцать одновременных запросов при
    // пределе «два» проходили все — каждый успевал прочитать нули.
    const maxTokens = Math.max(this.#config.maxOutputTokens, params.minOutputTokens ?? 0);
    const estimated = estimateMessagesTokens([params.system, params.user]);
    const decision = await this.#budget.reserve(
      params.ctx.accountId,
      estimated + maxTokens,
      estimated,
    );
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
      maxTokens,
    };
    const response = await this.#provider.chat(request, params.ctx.signal);

    if (!response.ok) {
      // Резерв снимаем в любом случае, но по-разному: отказ, при котором
      // модель успела поработать, расход занимает, а обрыв связи — нет.
      await this.#budget.settle(
        params.ctx.accountId,
        decision.reserved,
        SPENT_ON_FAILURE.has(response.error.kind)
          ? {
              promptTokens: estimated,
              completionTokens: 0,
              totalTokens: estimated,
              estimated: true,
            }
          : null,
      );
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
    // Поправка по факту: резерв заменяется настоящим расходом.
    await this.#budget.settle(params.ctx.accountId, decision.reserved, usage);

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
      await this.#cache.set(cacheKey, JSON.stringify(parsed.value), this.#options.cacheTtlSeconds);
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
