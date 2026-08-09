/**
 * Сборка помощника из настроек трёх уровней.
 *
 * Здесь сходится всё: настройки домена (администратор), настройки
 * пользователя (согласие и включённые возможности) и запрошенное действие.
 * Ни один маршрут не создаёт помощника сам — только через этот модуль,
 * поэтому проверку «а можно ли вообще» невозможно случайно обойти.
 *
 * Помощник собирается на каждый запрос заново. Это дёшево (разбор настроек
 * и создание объектов, без соединений) и даёт важное свойство: кэш
 * результатов привязан к конкретному ящику. Благодаря этому отзыв согласия
 * действительно удаляет созданные резюме и метки ИМЕННО этого пользователя,
 * не задевая чужие.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import {
  InMemoryBudgetTracker,
  LoggerAuditLog,
  MailAssistant,
  RedisAiCache,
  RedisBudgetTracker,
  budgetLimitsSchema,
  messageKeyMarker,
  type AiAuditLog,
  type BudgetDecision,
  type BudgetSnapshot,
  type BudgetTracker,
  type ProviderConfigInput,
  type TokenUsage,
} from '@mail-true/ai';
import type { AiConfig } from './config.js';
import type { AiDomainSettings, AiRedis, AiSettingsStore, AiUserSettings } from './db.js';
import {
  AI_FEATURES,
  AI_FEATURE_INFO,
  NEVER_SENT,
  defaultFeatures,
  type AiUserFeature,
} from './features.js';
import { AiKeyBoxError, type AiKeyBox } from './secret.js';
import { errorInfo } from '../log.js';
import {
  AiConsentRequiredError,
  AiDisabledError,
  AiFeatureOffError,
  AiUnavailableError,
} from './errors.js';

/** Почему помощник недоступен. Для диагностики и для честного ответа. */
export type AiBlockReason =
  /** Выключен общим рубильником сервера (AI_ENABLED=false). */
  | 'server-off'
  /** Нет подключения к базе или не применена миграция 0004. */
  | 'no-database'
  /** Администратор домена не разрешил. */
  | 'domain-off'
  /** Разрешён, но настройки неполные или ключ не расшифровывается. */
  | 'misconfigured';

export interface AiAvailability {
  /** Помощника можно показывать пользователю. */
  available: boolean;
  reason: AiBlockReason | null;
  /** Подробность для журнала сервера; пользователю не показывается. */
  detail: string | null;
  domain: AiDomainSettings | null;
  assistant: MailAssistant | null;
}

/** Описание сервиса для экрана согласия. */
export interface AiProviderInfo {
  label: string;
  model: string;
  endpoint: string;
  /** Модель поднята внутри периметра: письма не покидают сервер. */
  local: boolean;
}

export interface AiFeatureState {
  key: AiUserFeature;
  title: string;
  description: string;
  sends: string;
  /** Разрешена администратором домена. */
  allowed: boolean;
  /** Включена самим пользователем. */
  enabled: boolean;
}

export interface AiConsentState {
  given: boolean;
  at: string | null;
  /**
   * Согласие дано на тот же сервис, что настроен сейчас.
   * Если администратор сменил адрес или модель, спрашиваем заново:
   * человек соглашался отправлять письма конкретному адресату.
   */
  matchesProvider: boolean;
  consentedEndpoint: string | null;
  consentedModel: string | null;
}

export interface AiStateDto {
  /**
   * Главное поле. false — интерфейс не показывает ничего, связанного с ИИ.
   * Именно «не показывает», а не «показывает и получает отказ».
   */
  enabled: boolean;
  provider: AiProviderInfo | null;
  consent: AiConsentState;
  features: AiFeatureState[];
  /** Что не отправляется никогда — для экрана согласия. */
  neverSent: readonly string[];
  budget: AiBudgetDto | null;
}

export interface AiBudgetDto {
  periodMs: number;
  windowStartedAt: number;
  tokensUsed: number;
  requestsUsed: number;
  tokensLimit: number | null;
  requestsLimit: number | null;
  tokensLeft: number | null;
  requestsLeft: number | null;
}

interface CachedSettings {
  value: AiDomainSettings | null;
  at: number;
}

/**
 * Ключ ящика для имён в Redis. Хэш, а не адрес: в шаблоне поиска Redis
 * символы `*`, `?` и `[` имеют особый смысл, а адрес пришёл извне.
 */
export function accountKey(email: string): string {
  return createHash('sha256').update(email.toLowerCase(), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Учёт расходов ПО ДОМЕНУ.
 *
 * Пакет @mail-true/ai ведёт учёт по переданному ключу и передаёт туда
 * идентификатор вызывающего — адрес ящика. Но предел задан в настройках
 * домена и подписан как доменный, поэтому ключ подменяется на имя домена:
 * все ящики домена расходуют один общий предел.
 *
 * Обёртка, а не правка пакета: пакет остаётся общего назначения (учёт по
 * произвольному ключу), а решение «ключ — домен» принимается там же, где
 * читаются доменные настройки.
 */
export class DomainBudgetTracker implements BudgetTracker {
  readonly #inner: BudgetTracker;
  readonly #domain: string;

  constructor(inner: BudgetTracker, domain: string) {
    this.#inner = inner;
    this.#domain = domain.toLowerCase();
  }

  /** Имя ключа учёта. Публично — чтобы это можно было проверить тестом. */
  get key(): string {
    return `domain:${this.#domain}`;
  }

  reserve(_key: string, estimatedTokens: number, requestTokens?: number): Promise<BudgetDecision> {
    return this.#inner.reserve(this.key, estimatedTokens, requestTokens);
  }

  settle(_key: string, reserved: number, usage: TokenUsage | null): Promise<void> {
    return this.#inner.settle(this.key, reserved, usage);
  }

  snapshot(_key: string): Promise<BudgetSnapshot> {
    return this.#inner.snapshot(this.key);
  }

  reset(_key: string): Promise<void> {
    return this.#inner.reset(this.key);
  }
}

export class AiService {
  readonly #config: AiConfig;
  readonly #db: AiSettingsStore | null;
  readonly #redis: AiRedis | null;
  readonly #keyBox: AiKeyBox | null;
  readonly #keyBoxReason: string | null;
  readonly #logger: Logger;
  readonly #audit: AiAuditLog;
  readonly #settingsCache = new Map<string, CachedSettings>();
  /**
   * Счётчики расхода по доменам, когда Redis нет. Живут на сервисе,
   * а не на помощнике: помощник собирается заново на каждый запрос.
   */
  readonly #memoryBudgets = new Map<
    string,
    { signature: string; tracker: InMemoryBudgetTracker }
  >();

  constructor(init: {
    config: AiConfig;
    db: AiSettingsStore | null;
    redis: AiRedis | null;
    keyBox: AiKeyBox | null;
    keyBoxReason: string | null;
    logger: Logger;
    /** Журнал обращений. По умолчанию — только в лог сервера, без чтения. */
    audit?: AiAuditLog;
  }) {
    this.#config = init.config;
    this.#db = init.db;
    this.#redis = init.redis;
    this.#keyBox = init.keyBox;
    this.#keyBoxReason = init.keyBoxReason;
    this.#logger = init.logger;
    this.#audit = init.audit ?? new LoggerAuditLog(init.logger);
  }

  get db(): AiSettingsStore | null {
    return this.#db;
  }

  get keyBox(): AiKeyBox | null {
    return this.#keyBox;
  }

  get keyBoxReason(): string | null {
    return this.#keyBoxReason;
  }

  get audit(): AiAuditLog {
    return this.#audit;
  }

  /** Сбрасывает кэш настроек: вызывается после записи из админки. */
  forgetSettings(): void {
    this.#settingsCache.clear();
  }

  // -------------------------------------------------------------------------
  // Настройки
  // -------------------------------------------------------------------------

  async #domainSettings(email: string): Promise<AiDomainSettings | null> {
    if (!this.#db) return null;
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (domain.length === 0) return null;

    const ttl = this.#config.AI_SETTINGS_CACHE_MS;
    const cached = this.#settingsCache.get(domain);
    if (cached && Date.now() - cached.at < ttl) return cached.value;

    let value: AiDomainSettings | null = null;
    try {
      value = await this.#db.findDomainSettingsByEmail(email);
    } catch (err) {
      // Недоступная база — не авария почты: ИИ просто выключается.
      this.#logger.warn(errorInfo(err, { domain }), 'Не удалось прочитать настройки ИИ домена');
      value = null;
    }
    this.#settingsCache.set(domain, { value, at: Date.now() });
    return value;
  }

  async userSettings(email: string): Promise<AiUserSettings | null> {
    if (!this.#db) return null;
    try {
      return await this.#db.findUserSettings(email);
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Не удалось прочитать настройки ИИ пользователя');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Доступность
  // -------------------------------------------------------------------------

  /**
   * Собирает помощника для ящика. Согласие пользователя здесь НЕ
   * проверяется: состояние помощника нужно показать и до согласия,
   * иначе экран согласия нечем наполнить.
   */
  async availability(email: string): Promise<AiAvailability> {
    const off = (reason: AiBlockReason, detail: string | null): AiAvailability => ({
      available: false,
      reason,
      detail,
      domain: null,
      assistant: null,
    });

    if (!this.#config.AI_ENABLED) return off('server-off', 'AI_ENABLED=false');
    if (!this.#db) {
      return off('no-database', 'Не задан AI_DATABASE_URL/ADMIN_DATABASE_URL/DATABASE_URL');
    }

    const domain = await this.#domainSettings(email);
    if (!domain) return off('no-database', 'Нет строки настроек для домена');
    if (!domain.enabled) {
      return { available: false, reason: 'domain-off', detail: null, domain, assistant: null };
    }

    const built = this.#buildAssistant(domain);
    if (!built.ok) {
      this.#logger.warn(
        { domain: domain.domain, detail: built.detail },
        'ИИ разрешён по домену, но настройки неполные — помощник не собран',
      );
      return {
        available: false,
        reason: 'misconfigured',
        detail: built.detail,
        domain,
        assistant: null,
      };
    }

    return { available: true, reason: null, detail: null, domain, assistant: built.assistant };
  }

  /**
   * Ограничения расходов домена в форме, понятной пакету.
   *
   * Ключ учёта — ДОМЕН, а не ящик. Пакет ведёт учёт по тому ключу, который
   * ему передадут, а передаётся туда идентификатор вызывающего, то есть
   * адрес ящика. Настройка же живёт в настройках домена и подписана как
   * доменная: «200 запросов в сутки» означало 200 запросов КАЖДОМУ ящику,
   * и в домене на сто ящиков предел вырастал в сто раз. Подменяем ключ
   * здесь, у самой границы с пакетом, — тогда ни один вызывающий не может
   * это обойти, даже случайно.
   *
   * БЕЗ REDIS предел раньше не действовал ВООБЩЕ: ставился «учёт без
   * ограничений», а /state и /usage показывали нулевой расход и полный
   * остаток — то есть администратор видел работающий предел там, где его
   * не было. Теперь без Redis считаем в памяти процесса: предел работает,
   * счёт живёт до перезапуска и не общий на несколько узлов. Об этом
   * прямо сказано в сообщении при старте (см. index.ts).
   */
  #limits(domain: AiDomainSettings): BudgetTracker {
    const parsed = budgetLimitsSchema.safeParse({
      periodMs: domain.periodMs,
      maxTokensPerPeriod: domain.maxTokensPerPeriod,
      maxRequestsPerPeriod: domain.maxRequestsPerPeriod,
      maxTokensPerRequest: domain.maxTokensPerRequest,
    });
    const limits = parsed.success ? parsed.data : budgetLimitsSchema.parse({});

    if (this.#redis) {
      return new DomainBudgetTracker(
        new RedisBudgetTracker(this.#redis, limits, {
          prefix: `${this.#config.AI_REDIS_PREFIX}budget`,
        }),
        domain.domain,
      );
    }

    /*
     * Помощник собирается заново на каждый запрос, поэтому счётчик
     * в памяти надо переживать между запросами — иначе он обнулялся бы
     * ещё до того, как кто-нибудь успел упереться в предел.
     *
     * Смена пределов администратором начинает учёт заново: старый
     * счётчик считался по другим правилам, и переносить его в новые
     * было бы обманом в обе стороны.
     */
    const signature = JSON.stringify(limits);
    const key = domain.domain.toLowerCase();
    let kept = this.#memoryBudgets.get(key);
    if (!kept || kept.signature !== signature) {
      kept = { signature, tracker: new InMemoryBudgetTracker(limits) };
      this.#memoryBudgets.set(key, kept);
    }
    return new DomainBudgetTracker(kept.tracker, domain.domain);
  }

  /**
   * Кэш результатов, привязанный к ящику.
   * Префикс с хэшем адреса — то, благодаря чему отзыв согласия удаляет
   * резюме и метки только этого пользователя.
   */
  #cacheFor(email: string): RedisAiCache | undefined {
    if (!this.#redis) return undefined;
    return new RedisAiCache(this.#redis, { prefix: this.#cachePrefix(email) });
  }

  #cachePrefix(email: string): string {
    return `${this.#config.AI_REDIS_PREFIX}u:${accountKey(email)}:`;
  }

  #buildAssistant(
    domain: AiDomainSettings,
    email?: string,
  ): { ok: true; assistant: MailAssistant } | { ok: false; detail: string } {
    if (!domain.baseUrl || !domain.model) {
      return { ok: false, detail: 'Не заданы адрес сервиса или название модели' };
    }

    let apiKey: string | null = null;
    if (domain.apiKeyEnc) {
      if (!this.#keyBox) {
        return {
          ok: false,
          detail: this.#keyBoxReason ?? 'Ключ доступа сохранён, но расшифровать его нечем',
        };
      }
      try {
        apiKey = this.#keyBox.decrypt(domain.apiKeyEnc);
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof AiKeyBoxError ? err.message : 'Ключ доступа не расшифровывается',
        };
      }
    }

    const provider: ProviderConfigInput = {
      enabled: true,
      baseUrl: domain.baseUrl,
      chatPath: domain.chatPath,
      model: domain.model,
      providerLabel: domain.providerLabel,
      /*
       * Признак «модель внутри периметра» отсюда НЕ передаётся: пакет
       * выводит его из baseUrl сам. Раньше сюда шло значение из базы,
       * а туда оно попадало булевым полем запроса — и строка, записанная
       * мимо формы админки, заставляла экран согласия обещать каждому
       * пользователю домена «письма не покидают периметр», пока письма
       * уходили во внешний сервис.
       */
      timeoutMs: domain.timeoutMs,
      maxOutputTokens: domain.maxOutputTokens,
      maxBodyChars: domain.maxBodyChars,
      ...(apiKey === null ? {} : { apiKey }),
    };

    const cache = email === undefined ? undefined : this.#cacheFor(email);
    const created = MailAssistant.create({
      provider,
      limits: {
        periodMs: domain.periodMs,
        maxTokensPerPeriod: domain.maxTokensPerPeriod,
        maxRequestsPerPeriod: domain.maxRequestsPerPeriod,
        maxTokensPerRequest: domain.maxTokensPerRequest,
      },
      deps: {
        budget: this.#limits(domain),
        audit: this.#audit,
        ...(cache ? { cache } : {}),
      },
    });

    if (!created.ok) {
      return { ok: false, detail: `${created.message}: ${created.issues.join('; ')}` };
    }
    return { ok: true, assistant: created.assistant };
  }

  // -------------------------------------------------------------------------
  // Состояние для интерфейса
  // -------------------------------------------------------------------------

  /**
   * Полное состояние помощника для текущего пользователя.
   *
   * Когда `enabled: false`, всё остальное пусто: интерфейсу не из чего
   * рисовать кнопки, даже если он захочет.
   */
  async state(email: string): Promise<AiStateDto> {
    const availability = await this.availability(email);
    const empty: AiStateDto = {
      enabled: false,
      provider: null,
      consent: {
        given: false,
        at: null,
        matchesProvider: false,
        consentedEndpoint: null,
        consentedModel: null,
      },
      features: [],
      neverSent: [],
      budget: null,
    };

    if (!availability.available || !availability.assistant || !availability.domain) {
      return empty;
    }

    const assistant = availability.assistant;
    const domain = availability.domain;
    const user = await this.userSettings(email);

    const provider: AiProviderInfo = {
      label: domain.providerLabel,
      model: assistant.model,
      endpoint: assistant.endpoint,
      local: assistant.local,
    };

    const allowed = domain.featuresAllowed;
    const chosen = user?.features ?? defaultFeatures();
    const features: AiFeatureState[] = AI_FEATURES.map((key) => {
      const info = AI_FEATURE_INFO[key];
      const isAllowed = allowed === null || allowed.includes(key);
      return {
        key,
        title: info.title,
        description: info.description,
        sends: info.sends,
        allowed: isAllowed,
        enabled: isAllowed && chosen.includes(key),
      };
    });

    // Согласие есть тогда и только тогда, когда записана его дата.
    const consentGiven = typeof user?.consentAt === 'string';
    const matchesProvider =
      consentGiven &&
      user?.consentEndpoint === provider.endpoint &&
      user.consentModel === provider.model;

    return {
      enabled: true,
      provider,
      consent: {
        given: consentGiven,
        at: user?.consentAt ?? null,
        matchesProvider,
        consentedEndpoint: user?.consentEndpoint ?? null,
        consentedModel: user?.consentModel ?? null,
      },
      features,
      neverSent: NEVER_SENT,
      budget: await this.budget(email, assistant),
    };
  }

  async budget(email: string, assistant: MailAssistant): Promise<AiBudgetDto> {
    const snapshot: BudgetSnapshot = await assistant.budgetSnapshot(email);
    return {
      periodMs: snapshot.periodMs,
      windowStartedAt: snapshot.windowStartedAt,
      tokensUsed: snapshot.tokensUsed,
      requestsUsed: snapshot.requestsUsed,
      tokensLimit: snapshot.limits.maxTokensPerPeriod,
      requestsLimit: snapshot.limits.maxRequestsPerPeriod,
      tokensLeft: snapshot.tokensLeft,
      requestsLeft: snapshot.requestsLeft,
    };
  }

  // -------------------------------------------------------------------------
  // Разрешение на конкретное действие
  // -------------------------------------------------------------------------

  /**
   * Готовит помощника для конкретной возможности.
   *
   * Порядок проверок повторяет docs/ai-spec.md: сначала администратор
   * (иначе пользователь не должен был увидеть кнопку вообще), потом
   * согласие, потом настройка самого пользователя.
   */
  async forFeature(
    email: string,
    feature: AiUserFeature,
  ): Promise<{ assistant: MailAssistant; domain: AiDomainSettings }> {
    const availability = await this.availability(email);
    if (!availability.available || !availability.domain) {
      if (availability.reason === 'misconfigured' || availability.reason === 'no-database') {
        throw new AiUnavailableError(
          'Помощник на основе ИИ не настроен. Обратитесь к администратору домена',
        );
      }
      throw new AiDisabledError();
    }
    const domain = availability.domain;

    if (domain.featuresAllowed !== null && !domain.featuresAllowed.includes(feature)) {
      throw new AiFeatureOffError(
        `Возможность «${AI_FEATURE_INFO[feature].title}» запрещена администратором домена`,
      );
    }

    const user = await this.userSettings(email);
    if (!user || user.consentAt === null) throw new AiConsentRequiredError();

    // Собираем заново, теперь уже с кэшем, привязанным к ящику.
    const built = this.#buildAssistant(domain, email);
    if (!built.ok) throw new AiUnavailableError('Помощник на основе ИИ не настроен');

    const consentEndpoint = user.consentEndpoint;
    const consentModel = user.consentModel;
    if (consentEndpoint !== built.assistant.endpoint || consentModel !== built.assistant.model) {
      throw new AiConsentRequiredError(
        'Администратор сменил сервис ИИ. Подтвердите согласие заново — ' +
          'письма будут уходить по другому адресу',
      );
    }

    const chosen = user.features ?? defaultFeatures();
    if (!chosen.includes(feature)) {
      throw new AiFeatureOffError(
        `Возможность «${AI_FEATURE_INFO[feature].title}» выключена в ваших настройках помощника`,
      );
    }

    return { assistant: built.assistant, domain };
  }

  // -------------------------------------------------------------------------
  // Согласие
  // -------------------------------------------------------------------------

  async grantConsent(email: string, features: AiUserFeature[]): Promise<void> {
    const availability = await this.availability(email);
    if (!availability.available || !availability.assistant) throw new AiDisabledError();
    if (!this.#db) throw new AiUnavailableError();
    await this.#db.grantConsent(
      email,
      availability.assistant.endpoint,
      availability.assistant.model,
      features,
    );
  }

  /**
   * Отзыв согласия: настройки удаляются, а вместе с ними — ВСЁ, что
   * помощник насчитал для этого ящика: резюме, метки, извлечённые данные,
   * переводы. Это прямое требование docs/ai-spec.md, и выполняется оно
   * не «пометкой удалено», а настоящим удалением записей кэша.
   *
   * Журнал обращений остаётся: это учётная запись администратора о том,
   * что уходило наружу, и пользователь не должен уметь её стереть.
   * Тел писем в журнале нет — только длины и счётчики токенов.
   */
  async revokeConsent(email: string): Promise<{ removedCacheEntries: number }> {
    if (this.#db) await this.#db.revokeConsent(email);
    const removed = await this.purgeAccountCache(email);
    return { removedCacheEntries: removed };
  }

  /** Удаляет все результаты помощника по этому ящику. Возвращает число записей. */
  purgeAccountCache(email: string): Promise<number> {
    return this.#purge(`${this.#cachePrefix(email)}*`);
  }

  /**
   * Забыть всё, что помощник насчитал по одному письму.
   *
   * Требует согласия, но НЕ требует включённой возможности: пользователь,
   * выключивший резюме, всё равно должен уметь удалить то, что уже
   * насчитано. Право удалить созданное не может зависеть от того,
   * пользуется ли человек кнопкой дальше.
   */
  async forgetMessage(email: string, messageId: string): Promise<number> {
    const availability = await this.availability(email);
    if (!availability.available) throw new AiDisabledError();
    const user = await this.userSettings(email);
    if (!user || user.consentAt === null) throw new AiConsentRequiredError();
    return this.#purge(`${this.#cachePrefix(email)}ai:*${messageKeyMarker(messageId)}*`);
  }

  /** Удаляет ключи кэша по шаблону. Ошибка Redis не должна ломать почту. */
  async #purge(pattern: string): Promise<number> {
    const redis = this.#redis;
    if (!redis) return 0;
    let cursor = '0';
    let removed = 0;
    try {
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
          removed += keys.length;
        }
      } while (cursor !== '0');
    } catch (err) {
      this.#logger.warn(errorInfo(err, { pattern }), 'Не удалось удалить записи кэша ИИ');
    }
    return removed;
  }

  async saveFeatures(email: string, features: AiUserFeature[]): Promise<void> {
    if (!this.#db) throw new AiUnavailableError();
    const existing = await this.#db.findUserSettings(email);
    if (!existing || existing.consentAt === null) throw new AiConsentRequiredError();
    await this.#db.saveUserFeatures(email, features);
  }
}
