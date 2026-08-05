/**
 * Ограничение расходов.
 *
 * Требование спецификации: при исчерпании предела вызов отклоняется
 * с понятным сообщением, а не молча. Поэтому проверка идёт ДО отправки
 * запроса, а фактический расход записывается после ответа сервиса.
 */

import type { BudgetLimits } from './config.js';
import type { AiError, TokenUsage } from './types.js';
import { aiFail } from './types.js';

export interface BudgetSnapshot {
  /** Начало текущего окна учёта (мс от эпохи). */
  windowStartedAt: number;
  periodMs: number;
  tokensUsed: number;
  requestsUsed: number;
  limits: BudgetLimits;
  /** Сколько токенов осталось; null — предела нет. */
  tokensLeft: number | null;
  /** Сколько вызовов осталось; null — предела нет. */
  requestsLeft: number | null;
}

export type BudgetDecision = { allowed: true } | { allowed: false; error: AiError };

/**
 * Хранилище расхода. Абстрактно: в памяти на одном узле, в Redis —
 * на нескольких. Ключ обычно — идентификатор аккаунта или домена.
 */
export interface BudgetTracker {
  /** Проверка перед вызовом. Оценка токенов запроса — приблизительная. */
  check(key: string, estimatedTokens: number): Promise<BudgetDecision>;
  /** Запись фактического расхода после ответа сервиса. */
  record(key: string, usage: TokenUsage): Promise<void>;
  snapshot(key: string): Promise<BudgetSnapshot>;
  /** Сброс учёта (например, при смене тарифа). */
  reset(key: string): Promise<void>;
}

interface Window {
  startedAt: number;
  tokens: number;
  requests: number;
}

function decisionFor(
  limits: BudgetLimits,
  window: Window,
  estimatedTokens: number,
): BudgetDecision {
  if (limits.maxTokensPerRequest !== null && estimatedTokens > limits.maxTokensPerRequest) {
    return {
      allowed: false,
      error: aiFail(
        'budget-exceeded',
        `Запрос слишком велик: примерно ${String(estimatedTokens)} токенов при пределе ${String(limits.maxTokensPerRequest)} на один вызов`,
        { retryable: false },
      ).error,
    };
  }
  if (limits.maxRequestsPerPeriod !== null && window.requests >= limits.maxRequestsPerPeriod) {
    return {
      allowed: false,
      error: aiFail(
        'budget-exceeded',
        `Исчерпан предел обращений к ИИ: ${String(limits.maxRequestsPerPeriod)} за период. Обратитесь к администратору или дождитесь начала нового периода`,
        { retryable: false },
      ).error,
    };
  }
  if (
    limits.maxTokensPerPeriod !== null &&
    window.tokens + estimatedTokens > limits.maxTokensPerPeriod
  ) {
    return {
      allowed: false,
      error: aiFail(
        'budget-exceeded',
        `Исчерпан предел расходов на ИИ: израсходовано ${String(window.tokens)} из ${String(limits.maxTokensPerPeriod)} токенов за период`,
        { retryable: false },
      ).error,
    };
  }
  return { allowed: true };
}

function snapshotFrom(limits: BudgetLimits, window: Window): BudgetSnapshot {
  return {
    windowStartedAt: window.startedAt,
    periodMs: limits.periodMs,
    tokensUsed: window.tokens,
    requestsUsed: window.requests,
    limits,
    tokensLeft:
      limits.maxTokensPerPeriod === null
        ? null
        : Math.max(0, limits.maxTokensPerPeriod - window.tokens),
    requestsLeft:
      limits.maxRequestsPerPeriod === null
        ? null
        : Math.max(0, limits.maxRequestsPerPeriod - window.requests),
  };
}

/** Учёт расхода в памяти одного процесса. Годится для одного узла и тестов. */
export class InMemoryBudgetTracker implements BudgetTracker {
  readonly #limits: BudgetLimits;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();

  constructor(limits: BudgetLimits, now?: () => number) {
    this.#limits = limits;
    this.#now = now ?? (() => Date.now());
  }

  #window(key: string): Window {
    const now = this.#now();
    const existing = this.#windows.get(key);
    if (existing && now - existing.startedAt < this.#limits.periodMs) return existing;
    const fresh: Window = { startedAt: now, tokens: 0, requests: 0 };
    this.#windows.set(key, fresh);
    return fresh;
  }

  check(key: string, estimatedTokens: number): Promise<BudgetDecision> {
    return Promise.resolve(decisionFor(this.#limits, this.#window(key), estimatedTokens));
  }

  record(key: string, usage: TokenUsage): Promise<void> {
    const window = this.#window(key);
    window.tokens += usage.totalTokens;
    window.requests += 1;
    return Promise.resolve();
  }

  snapshot(key: string): Promise<BudgetSnapshot> {
    return Promise.resolve(snapshotFrom(this.#limits, this.#window(key)));
  }

  reset(key: string): Promise<void> {
    this.#windows.delete(key);
    return Promise.resolve();
  }
}

/** Минимальная часть клиента Redis, нужная для учёта. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  pexpire?(key: string, ms: number): Promise<unknown>;
}

/**
 * Учёт расхода в Redis — общий для всех узлов.
 * Окно фиксированное: ключ содержит номер окна, TTL снимает старые.
 */
export class RedisBudgetTracker implements BudgetTracker {
  readonly #redis: RedisLike;
  readonly #limits: BudgetLimits;
  readonly #prefix: string;
  readonly #now: () => number;

  constructor(
    redis: RedisLike,
    limits: BudgetLimits,
    options?: { prefix?: string; now?: () => number },
  ) {
    this.#redis = redis;
    this.#limits = limits;
    this.#prefix = options?.prefix ?? 'ai:budget';
    this.#now = options?.now ?? (() => Date.now());
  }

  #windowIndex(): number {
    return Math.floor(this.#now() / this.#limits.periodMs);
  }

  #keys(key: string): { tokens: string; requests: string; ttlSeconds: number } {
    const index = this.#windowIndex();
    return {
      tokens: `${this.#prefix}:${key}:${String(index)}:tokens`,
      requests: `${this.#prefix}:${key}:${String(index)}:requests`,
      ttlSeconds: Math.ceil((this.#limits.periodMs * 2) / 1000),
    };
  }

  async #read(key: string): Promise<Window> {
    const keys = this.#keys(key);
    const [tokensRaw, requestsRaw] = await Promise.all([
      this.#redis.get(keys.tokens),
      this.#redis.get(keys.requests),
    ]);
    return {
      startedAt: this.#windowIndex() * this.#limits.periodMs,
      tokens: Number.parseInt(tokensRaw ?? '0', 10) || 0,
      requests: Number.parseInt(requestsRaw ?? '0', 10) || 0,
    };
  }

  async check(key: string, estimatedTokens: number): Promise<BudgetDecision> {
    try {
      return decisionFor(this.#limits, await this.#read(key), estimatedTokens);
    } catch {
      // Redis недоступен — не блокируем почту из-за учёта, но и не молчим:
      // журнал получит запись о фактическом расходе, когда Redis вернётся.
      return { allowed: true };
    }
  }

  async record(key: string, usage: TokenUsage): Promise<void> {
    const keys = this.#keys(key);
    try {
      await this.#redis.incrby(keys.tokens, usage.totalTokens);
      await this.#redis.expire(keys.tokens, keys.ttlSeconds);
      await this.#redis.incrby(keys.requests, 1);
      await this.#redis.expire(keys.requests, keys.ttlSeconds);
    } catch {
      // Учёт — не критичный путь: молча пропускаем, почта работает.
    }
  }

  async snapshot(key: string): Promise<BudgetSnapshot> {
    try {
      return snapshotFrom(this.#limits, await this.#read(key));
    } catch {
      return snapshotFrom(this.#limits, {
        startedAt: this.#windowIndex() * this.#limits.periodMs,
        tokens: 0,
        requests: 0,
      });
    }
  }

  async reset(key: string): Promise<void> {
    const keys = this.#keys(key);
    try {
      await this.#redis.del(keys.tokens, keys.requests);
    } catch {
      // см. выше
    }
  }
}

/** Учёт без ограничений — когда администратор предела не задал. */
export class UnlimitedBudgetTracker implements BudgetTracker {
  readonly #limits: BudgetLimits;
  #tokens = 0;
  #requests = 0;

  constructor(limits: BudgetLimits) {
    this.#limits = limits;
  }

  check(): Promise<BudgetDecision> {
    return Promise.resolve({ allowed: true });
  }

  record(_key: string, usage: TokenUsage): Promise<void> {
    this.#tokens += usage.totalTokens;
    this.#requests += 1;
    return Promise.resolve();
  }

  snapshot(): Promise<BudgetSnapshot> {
    return Promise.resolve(
      snapshotFrom(this.#limits, { startedAt: 0, tokens: this.#tokens, requests: this.#requests }),
    );
  }

  reset(): Promise<void> {
    this.#tokens = 0;
    this.#requests = 0;
    return Promise.resolve();
  }
}
