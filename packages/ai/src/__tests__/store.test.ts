/** Тесты кэша, учёта расходов и журнала, в том числе вариантов на Redis. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryAuditLog, LoggerAuditLog, sumEntries, type AiAuditEntry } from '../audit.js';
import { InMemoryBudgetTracker, RedisBudgetTracker, type RedisLike } from '../budget.js';
import { MemoryAiCache, RedisAiCache, buildCacheKey, type RedisCacheClient } from '../cache.js';
import { budgetLimitsSchema } from '../config.js';

// --- Совместимость с настоящими клиентами (проверка на уровне типов) --------
//
// Пакет намеренно не импортирует ioredis и pino в рабочем коде: клиент
// передаётся снаружи. Но интерфейсы обязаны подходить настоящим клиентам,
// иначе абстракция бесполезна. Эти строки не выполняются — они проверяются
// компилятором при сборке тестов.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AuditLogger } from '../audit.js';

const redisFitsCache: (client: Redis) => RedisCacheClient = (client) => client;
const redisFitsBudget: (client: Redis) => RedisLike = (client) => client;
const pinoFitsAudit: (logger: Logger) => AuditLogger = (logger) => logger;
void redisFitsCache;
void redisFitsBudget;
void pinoFitsAudit;

// --- Поддельный Redis -------------------------------------------------------

class FakeRedis implements RedisCacheClient, RedisLike {
  readonly store = new Map<string, string>();
  failing = false;

  #check(): void {
    if (this.failing) throw new Error('Redis недоступен');
  }

  get(key: string): Promise<string | null> {
    this.#check();
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<unknown> {
    this.#check();
    this.store.set(key, value);
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<unknown> {
    this.#check();
    let n = 0;
    for (const key of keys) if (this.store.delete(key)) n += 1;
    return Promise.resolve(n);
  }

  incrby(key: string, increment: number): Promise<number> {
    this.#check();
    const next = (Number.parseInt(this.store.get(key) ?? '0', 10) || 0) + increment;
    this.store.set(key, String(next));
    return Promise.resolve(next);
  }

  expire(): Promise<unknown> {
    this.#check();
    return Promise.resolve(1);
  }

  scan(
    _cursor: string | number,
    _matchToken: 'MATCH',
    pattern: string,
  ): Promise<[string, string[]]> {
    this.#check();
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return Promise.resolve(['0', [...this.store.keys()].filter((k) => regex.test(k))]);
  }
}

// --- Ключ кэша --------------------------------------------------------------

describe('ключ кэша', () => {
  const parts = {
    feature: 'summarize.message' as const,
    promptVersion: 'v1',
    model: 'gpt-x',
    messageId: 'inbox:42',
    contentFingerprint: 'abc123',
  };

  it('одинаковые входные данные дают одинаковый ключ', () => {
    assert.equal(buildCacheKey(parts), buildCacheKey(parts));
  });

  it('смена версии запроса обесценивает кэш', () => {
    assert.notEqual(buildCacheKey(parts), buildCacheKey({ ...parts, promptVersion: 'v2' }));
  });

  it('смена модели обесценивает кэш', () => {
    assert.notEqual(buildCacheKey(parts), buildCacheKey({ ...parts, model: 'другая' }));
  });

  it('порядок ключей варианта не влияет на результат', () => {
    const a = buildCacheKey({ ...parts, variant: { tone: 'short', language: 'ru' } });
    const b = buildCacheKey({ ...parts, variant: { language: 'ru', tone: 'short' } });
    assert.equal(a, b);
  });

  it('идентификатор письма виден в ключе — по нему чистим', () => {
    assert.ok(buildCacheKey(parts).includes(encodeURIComponent('inbox:42')));
  });
});

// --- Кэш --------------------------------------------------------------------

describe('MemoryAiCache', () => {
  it('запись читается, пока не истекла', async () => {
    let now = 1000;
    const cache = new MemoryAiCache({ now: () => now });
    await cache.set('k', 'v', 10);
    assert.equal(await cache.get('k'), 'v');

    now += 11_000;
    assert.equal(await cache.get('k'), null);
  });

  it('удаление по письму убирает все его записи', async () => {
    const cache = new MemoryAiCache();
    await cache.set(
      buildCacheKey({
        feature: 'summarize.message',
        promptVersion: 'v1',
        model: 'm',
        messageId: 'inbox:7',
        contentFingerprint: 'a',
      }),
      '1',
      60,
    );
    await cache.set(
      buildCacheKey({
        feature: 'classify',
        promptVersion: 'v1',
        model: 'm',
        messageId: 'inbox:7',
        contentFingerprint: 'b',
      }),
      '2',
      60,
    );
    await cache.set(
      buildCacheKey({
        feature: 'classify',
        promptVersion: 'v1',
        model: 'm',
        messageId: 'inbox:8',
        contentFingerprint: 'c',
      }),
      '3',
      60,
    );

    assert.equal(await cache.deleteByMessage('inbox:7'), 2);
    assert.equal(cache.size, 1);
  });
});

describe('RedisAiCache', () => {
  it('пишет и читает через клиент', async () => {
    const redis = new FakeRedis();
    const cache = new RedisAiCache(redis, { prefix: 'mt:' });
    await cache.set('ai:x', 'значение', 60);
    assert.equal(redis.store.get('mt:ai:x'), 'значение');
    assert.equal(await cache.get('ai:x'), 'значение');
  });

  it('недоступный Redis не приводит к исключению', async () => {
    const redis = new FakeRedis();
    const cache = new RedisAiCache(redis);
    redis.failing = true;
    assert.equal(await cache.get('ai:x'), null);
    await cache.set('ai:x', 'v', 60);
    await cache.delete('ai:x');
    assert.equal(await cache.deleteByMessage('inbox:1'), 0);
  });

  it('удаляет все записи письма перебором ключей', async () => {
    const redis = new FakeRedis();
    const cache = new RedisAiCache(redis);
    const key = (feature: 'summarize.message' | 'classify'): string =>
      buildCacheKey({
        feature,
        promptVersion: 'v1',
        model: 'm',
        messageId: 'inbox:9',
        contentFingerprint: feature,
      });
    await cache.set(key('summarize.message'), '1', 60);
    await cache.set(key('classify'), '2', 60);
    await cache.set('ai:другое:v1:x:inbox%3A10:default:z', '3', 60);

    assert.equal(await cache.deleteByMessage('inbox:9'), 2);
    assert.equal(redis.store.size, 1);
  });
});

// --- Учёт расходов ----------------------------------------------------------

const usage = (total: number): AiAuditEntry['usage'] => ({
  promptTokens: total,
  completionTokens: 0,
  totalTokens: total,
  estimated: false,
});

/** Обычный вызов: заняли резерв — получили ответ — записали факт. */
async function spend(
  tracker: InMemoryBudgetTracker | RedisBudgetTracker,
  key: string,
  reserveTokens: number,
  actualTokens: number,
): Promise<boolean> {
  const decision = await tracker.reserve(key, reserveTokens);
  if (!decision.allowed) return false;
  await tracker.settle(key, decision.reserved, usage(actualTokens));
  return true;
}

describe('InMemoryBudgetTracker', () => {
  it('предел по токенам срабатывает и снимается в новом окне', async () => {
    let now = 0;
    const limits = budgetLimitsSchema.parse({ periodMs: 1000, maxTokensPerPeriod: 100 });
    const tracker = new InMemoryBudgetTracker(limits, () => now);

    assert.equal(await spend(tracker, 'a', 50, 90), true);

    const denied = await tracker.reserve('a', 50);
    assert.equal(denied.allowed, false);
    if (!denied.allowed) {
      assert.equal(denied.error.kind, 'budget-exceeded');
      assert.ok(denied.error.message.includes('90'));
    }

    now += 1500;
    assert.equal((await tracker.reserve('a', 50)).allowed, true);
  });

  it('учёт ведётся раздельно по ключам', async () => {
    const limits = budgetLimitsSchema.parse({ maxRequestsPerPeriod: 1 });
    const tracker = new InMemoryBudgetTracker(limits);
    assert.equal(await spend(tracker, 'a', 10, 10), true);
    assert.equal((await tracker.reserve('a', 1)).allowed, false);
    assert.equal((await tracker.reserve('b', 1)).allowed, true);
  });

  it('без пределов вызовы не отклоняются, но расход всё равно считается', async () => {
    // Раньше при отсутствии пределов ставился «учёт без ограничений»,
    // и снимок показывал нули при живом расходе — человек видел полный
    // остаток там, где токены уже потрачены.
    const tracker = new InMemoryBudgetTracker(budgetLimitsSchema.parse({}));
    assert.equal(await spend(tracker, 'a', 1_000_000, 1_000_000), true);
    assert.equal((await tracker.reserve('a', 1_000_000)).allowed, true);
    assert.equal((await tracker.snapshot('a')).tokensUsed >= 1_000_000, true);
  });

  it('снимок показывает остаток', async () => {
    const limits = budgetLimitsSchema.parse({ maxTokensPerPeriod: 500 });
    const tracker = new InMemoryBudgetTracker(limits);
    await spend(tracker, 'a', 200, 120);
    const snapshot = await tracker.snapshot('a');
    assert.equal(snapshot.tokensUsed, 120, 'резерв заменяется фактом, а не складывается с ним');
    assert.equal(snapshot.tokensLeft, 380);
    assert.equal(snapshot.requestsUsed, 1);
    assert.equal(snapshot.requestsLeft, null);
  });

  it('отклонённый вызов предел не расходует', async () => {
    const limits = budgetLimitsSchema.parse({ maxTokensPerPeriod: 100 });
    const tracker = new InMemoryBudgetTracker(limits);
    assert.equal((await tracker.reserve('a', 500)).allowed, false);
    const snapshot = await tracker.snapshot('a');
    assert.equal(snapshot.tokensUsed, 0, 'неудавшийся резерв обязан откатиться');
    assert.equal(snapshot.requestsUsed, 0);
  });

  it('не состоявшийся вызов возвращает и токены, и занятое обращение', async () => {
    const limits = budgetLimitsSchema.parse({ maxRequestsPerPeriod: 2 });
    const tracker = new InMemoryBudgetTracker(limits);
    const decision = await tracker.reserve('a', 300);
    assert.ok(decision.allowed);
    await tracker.settle('a', decision.reserved, null);
    const snapshot = await tracker.snapshot('a');
    assert.equal(snapshot.tokensUsed, 0);
    assert.equal(snapshot.requestsUsed, 0);
  });

  /*
   * ГЛАВНАЯ ПРОВЕРКА ЭТОГО БЛОКА.
   *
   * Проверка предела была неатомарной: read читал счётчики, а запись
   * расхода шла ПОСЛЕ ответа модели — через секунды. Двадцать
   * одновременных запросов при пределе «два» проходили все двадцать,
   * потому что каждый успевал прочитать нули до того, как первый
   * дописал расход.
   */
  it('двадцать одновременных вызовов при пределе «два» проходят ровно два', async () => {
    const limits = budgetLimitsSchema.parse({ maxRequestsPerPeriod: 2 });
    const tracker = new InMemoryBudgetTracker(limits);

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const decision = await tracker.reserve('domain:mail.local', 300);
        if (!decision.allowed) return false;
        // Модель «думает»: между резервом и записью факта проходит время.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await tracker.settle('domain:mail.local', decision.reserved, usage(100));
        return true;
      }),
    );

    assert.equal(results.filter(Boolean).length, 2, 'предел домена обязан отсечь остальные 18');
    assert.equal((await tracker.snapshot('domain:mail.local')).requestsUsed, 2);
  });
});

describe('RedisBudgetTracker', () => {
  it('считает расход через Redis', async () => {
    let now = 0;
    const limits = budgetLimitsSchema.parse({ periodMs: 1000, maxTokensPerPeriod: 100 });
    const redis = new FakeRedis();
    const tracker = new RedisBudgetTracker(redis, limits, { now: () => now });

    assert.equal(await spend(tracker, 'a', 50, 80), true);
    assert.equal((await tracker.reserve('a', 50)).allowed, false);

    now += 1000; // новое окно — другой ключ
    assert.equal((await tracker.reserve('a', 50)).allowed, true);
  });

  it('одновременные резервы через Redis тоже упираются в предел', async () => {
    const limits = budgetLimitsSchema.parse({ maxRequestsPerPeriod: 3 });
    const redis = new FakeRedis();
    const tracker = new RedisBudgetTracker(redis, limits);

    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const decision = await tracker.reserve('domain:mail.local', 200);
        if (!decision.allowed) return false;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await tracker.settle('domain:mail.local', decision.reserved, usage(50));
        return true;
      }),
    );

    assert.equal(results.filter(Boolean).length, 3);
    assert.equal((await tracker.snapshot('domain:mail.local')).requestsUsed, 3);
  });

  it('недоступный Redis не блокирует почту', async () => {
    const redis = new FakeRedis();
    const tracker = new RedisBudgetTracker(redis, budgetLimitsSchema.parse({}));
    redis.failing = true;
    const decision = await tracker.reserve('a', 10);
    assert.equal(decision.allowed, true);
    if (decision.allowed) await tracker.settle('a', decision.reserved, usage(10));
    await tracker.reset('a');
  });
});

// --- Журнал -----------------------------------------------------------------

const entry = (overrides?: Partial<AiAuditEntry>): AiAuditEntry => ({
  at: '2026-03-12T10:00:00.000Z',
  accountId: 'ivan@example.org',
  messageId: 'inbox:42',
  feature: 'summarize.message',
  promptVersion: 'v1',
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  model: 'm',
  local: true,
  usage: usage(100),
  cached: false,
  outboundChars: 500,
  durationMs: 12,
  ok: true,
  errorKind: null,
  ...overrides,
});

describe('журнал', () => {
  it('итоги считаются по записям', () => {
    const totals = sumEntries([
      entry(),
      entry({ cached: true, usage: usage(0) }),
      entry({ ok: false, errorKind: 'timeout', usage: usage(0) }),
    ]);
    assert.equal(totals.requests, 3);
    assert.equal(totals.cachedRequests, 1);
    assert.equal(totals.failedRequests, 1);
    assert.equal(totals.totalTokens, 100);
  });

  it('фильтр по времени работает', async () => {
    const log = new InMemoryAuditLog();
    await log.record(entry({ at: '2026-03-01T00:00:00.000Z' }));
    await log.record(entry({ at: '2026-03-20T00:00:00.000Z' }));
    const recent = await log.list({ since: '2026-03-10T00:00:00.000Z' });
    assert.equal(recent.length, 1);
  });

  it('кольцевой буфер не растёт бесконечно', async () => {
    const log = new InMemoryAuditLog(3);
    for (let i = 0; i < 10; i += 1) await log.record(entry());
    assert.equal((await log.list()).length, 3);
  });

  it('LoggerAuditLog пишет в логгер и во вложенный журнал', async () => {
    const lines: Record<string, unknown>[] = [];
    const inner = new InMemoryAuditLog();
    const log = new LoggerAuditLog({ info: (obj) => lines.push(obj) }, inner);
    await log.record(entry());
    assert.equal(lines.length, 1);
    assert.equal((await log.list()).length, 1);
    assert.equal((await log.totals()).totalTokens, 100);
  });
});
