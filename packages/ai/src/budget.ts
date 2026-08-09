/**
 * Ограничение расходов.
 *
 * Требование спецификации: при исчерпании предела вызов отклоняется
 * с понятным сообщением, а не молча.
 *
 * ПОЧЕМУ РЕЗЕРВИРОВАНИЕ, А НЕ «ПРОВЕРИТЬ И ПОТОМ ЗАПИСАТЬ».
 *
 * Раньше проверка читала счётчики, а расход записывался ПОСЛЕ ответа
 * модели — то есть через секунды. В этот промежуток счётчики не менялись,
 * и двадцать одновременных запросов при пределе «два обращения» проходили
 * все двадцать: каждый видел ноль израсходованного. Предел, поставленный
 * администратором, при любой параллельной работе просто не действовал —
 * а счёт от поставщика приходил настоящий.
 *
 * Теперь порядок обратный: {@link BudgetTracker.reserve} УВЕЛИЧИВАЕТ
 * счётчики до обращения к модели и отказывает, если вышли за предел
 * (откатывая собственную прибавку), а {@link BudgetTracker.settle}
 * заменяет резерв фактическим расходом. Пока модель думает, резерв уже
 * занят — второй запрос его видит.
 *
 * В резерв входит и ответ: раньше оценивался только текст запроса, а
 * ответ (до maxOutputTokens) не учитывался вовсе, и предел по токенам
 * прорывался ровно на длину ответа, помноженную на число вызовов.
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

export type BudgetDecision =
  /** Резерв взят: столько токенов сейчас записано в расход авансом. */
  { allowed: true; reserved: number } | { allowed: false; error: AiError };

/**
 * Хранилище расхода. Абстрактно: в памяти на одном узле, в Redis —
 * на нескольких. Ключ обычно — идентификатор аккаунта или домена.
 */
export interface BudgetTracker {
  /**
   * Занимает бюджет ДО обращения к модели: увеличивает счётчики на
   * оценку (запрос + потолок ответа) и одно обращение. Отказ означает,
   * что счётчики остались нетронутыми.
   */
  reserve(key: string, estimatedTokens: number): Promise<BudgetDecision>;
  /**
   * Поправка по факту. `usage: null` — вызов не состоялся вовсе
   * (модель ничего не сделала), резерв снимается целиком вместе
   * с занятым обращением.
   */
  settle(key: string, reserved: number, usage: TokenUsage | null): Promise<void>;
  snapshot(key: string): Promise<BudgetSnapshot>;
  /** Сброс учёта (например, при смене тарифа). */
  reset(key: string): Promise<void>;
}

interface Window {
  startedAt: number;
  tokens: number;
  requests: number;
}

/**
 * Хватает ли места под резерв. Счётчики к этому моменту УЖЕ увеличены,
 * поэтому сравнения нестрогие: собственный резерв входит в значения.
 */
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
        `Запрос слишком велик: примерно ${String(estimatedTokens)} токенов вместе с ответом при пределе ${String(limits.maxTokensPerRequest)} на один вызов`,
        { retryable: false },
      ).error,
    };
  }
  if (limits.maxRequestsPerPeriod !== null && window.requests > limits.maxRequestsPerPeriod) {
    return {
      allowed: false,
      error: aiFail(
        'budget-exceeded',
        `Исчерпан предел обращений к ИИ: ${String(limits.maxRequestsPerPeriod)} за период. Обратитесь к администратору или дождитесь начала нового периода`,
        { retryable: false },
      ).error,
    };
  }
  if (limits.maxTokensPerPeriod !== null && window.tokens > limits.maxTokensPerPeriod) {
    return {
      allowed: false,
      error: aiFail(
        'budget-exceeded',
        `Исчерпан предел расходов на ИИ: израсходовано ${String(Math.max(0, window.tokens - estimatedTokens))} из ${String(limits.maxTokensPerPeriod)} токенов за период`,
        { retryable: false },
      ).error,
    };
  }
  return { allowed: true, reserved: estimatedTokens };
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

/**
 * Учёт расхода в памяти одного процесса.
 *
 * Годится для одного узла и для тестов. Счёт живёт до перезапуска
 * процесса — об этом должен честно говорить тот, кто такой учёт выбрал
 * (см. apps/api/src/ai/index.ts).
 *
 * Резерв здесь атомарен сам собой: JavaScript однопоточный, а вся правка
 * счётчиков идёт одним синхронным куском без await посередине.
 */
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

  reserve(key: string, estimatedTokens: number): Promise<BudgetDecision> {
    const window = this.#window(key);
    window.tokens += estimatedTokens;
    window.requests += 1;
    const decision = decisionFor(this.#limits, window, estimatedTokens);
    if (!decision.allowed) {
      // Не поместились — забираем свою прибавку обратно, чтобы отказ
      // не расходовал предел сам по себе.
      window.tokens -= estimatedTokens;
      window.requests -= 1;
    }
    return Promise.resolve(decision);
  }

  settle(key: string, reserved: number, usage: TokenUsage | null): Promise<void> {
    const window = this.#window(key);
    if (usage === null) {
      window.tokens = Math.max(0, window.tokens - reserved);
      window.requests = Math.max(0, window.requests - 1);
      return Promise.resolve();
    }
    window.tokens = Math.max(0, window.tokens - reserved + usage.totalTokens);
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
 *
 * Резерв берётся командой INCRBY: она атомарна на стороне Redis, поэтому
 * два узла, начавшие вызов одновременно, получают разные значения
 * счётчика и второй честно упирается в предел. Не поместившийся резерв
 * возвращается обратным INCRBY.
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

  async reserve(key: string, estimatedTokens: number): Promise<BudgetDecision> {
    // Предел на один вызов от счётчиков не зависит — проверяем до INCRBY,
    // чтобы заведомо неподъёмный запрос не трогал общий счёт.
    if (
      this.#limits.maxTokensPerRequest !== null &&
      estimatedTokens > this.#limits.maxTokensPerRequest
    ) {
      return decisionFor(this.#limits, { startedAt: 0, tokens: 0, requests: 0 }, estimatedTokens);
    }

    const keys = this.#keys(key);
    try {
      const requests = await this.#redis.incrby(keys.requests, 1);
      await this.#redis.expire(keys.requests, keys.ttlSeconds);
      const tokens = await this.#redis.incrby(keys.tokens, estimatedTokens);
      await this.#redis.expire(keys.tokens, keys.ttlSeconds);

      const decision = decisionFor(
        this.#limits,
        { startedAt: this.#windowIndex() * this.#limits.periodMs, tokens, requests },
        estimatedTokens,
      );
      if (!decision.allowed) {
        await this.#redis.incrby(keys.requests, -1);
        await this.#redis.incrby(keys.tokens, -estimatedTokens);
      }
      return decision;
    } catch {
      /*
       * Redis недоступен. Выбор здесь между двумя неправдами, и обе плохи:
       * отказать — значит выключить помощника из-за подсобного хранилища,
       * разрешить — значит на время потерять предел. Выбрано «разрешить»,
       * потому что предел защищает от счёта поставщика, а отказ ломает
       * работу человека прямо сейчас; при этом недоступность Redis видна
       * в логе сервера (см. apps/api/src/ai/index.ts), то есть молчаливой
       * не остаётся. По той же причине settle ниже не пытается ничего
       * спасать: инкремент, который некуда записать, всё равно потерян.
       */
      return { allowed: true, reserved: estimatedTokens };
    }
  }

  async settle(key: string, reserved: number, usage: TokenUsage | null): Promise<void> {
    const keys = this.#keys(key);
    try {
      if (usage === null) {
        await this.#clampToZero(keys.tokens, await this.#redis.incrby(keys.tokens, -reserved));
        await this.#clampToZero(keys.requests, await this.#redis.incrby(keys.requests, -1));
        return;
      }
      const delta = usage.totalTokens - reserved;
      if (delta !== 0) {
        await this.#clampToZero(keys.tokens, await this.#redis.incrby(keys.tokens, delta));
      }
    } catch {
      // см. комментарий в reserve: учёт — не критичный путь, почта важнее.
    }
  }

  /**
   * Счётчик ушёл в минус — значит резерв брали в прошлом окне, а поправку
   * записали уже в новое: ключ другой, вычитать из него нечего. Ставим
   * ноль, иначе отрицательный остаток тихо расширил бы предел нового окна.
   */
  async #clampToZero(key: string, value: number): Promise<void> {
    if (value >= 0) return;
    await this.#redis.set(key, '0', 'EX', Math.ceil((this.#limits.periodMs * 2) / 1000));
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
