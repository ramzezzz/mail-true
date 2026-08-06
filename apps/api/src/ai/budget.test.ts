/**
 * Предел расходов на ИИ считается ПО ДОМЕНУ.
 *
 * Настройка живёт в настройках домена и подписана как доменная
 * («ограничение расходов по домену», docs/ai-spec.md), а ключи учёта
 * строились по адресу ящика. Значит «200 запросов в сутки на домен»
 * означало 200 запросов КАЖДОМУ: в домене на сто ящиков предел вырастал
 * в сто раз, и администратор, поставивший потолок расходов, его не имел.
 *
 * Здесь проверяется и то, что предел общий на весь домен, и то, что
 * домены друг друга не задевают: общий счётчик на всех — тоже неверно.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { pino } from 'pino';
import { loadAiConfig } from './config.js';
import type {
  AiDomainSettings,
  AiDomainSettingsPatch,
  AiRedis,
  AiSettingsStore,
  AiUserSettings,
} from './db.js';
import { defaultFeatures, type AiUserFeature } from './features.js';
import { AiKeyBox } from './secret.js';
import { AiService, DomainBudgetTracker } from './service.js';

const logger = pino({ level: 'silent' });
const SECRET = 'k'.repeat(40);

/* ------------------------------------------------------------------ */
/* Подделки                                                             */
/* ------------------------------------------------------------------ */

function settingsFor(domain: string, patch: Partial<AiDomainSettings> = {}): AiDomainSettings {
  return {
    domainId: domain === 'mail.local' ? 1 : 2,
    domain,
    enabled: true,
    baseUrl: 'http://127.0.0.1:1/v1',
    chatPath: '/chat/completions',
    apiKeyEnc: null,
    apiKeyHint: null,
    model: 'test-model',
    providerLabel: 'Локальная модель',
    local: true,
    maxBodyChars: 8000,
    timeoutMs: 5000,
    maxOutputTokens: 512,
    periodMs: 86_400_000,
    maxTokensPerPeriod: null,
    maxRequestsPerPeriod: null,
    maxTokensPerRequest: null,
    featuresAllowed: null,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

/** Настройки нескольких доменов сразу — этого не умеет FakeStore из ai.test. */
class MultiDomainStore implements AiSettingsStore {
  readonly users = new Map<string, AiUserSettings>();
  constructor(private readonly domains: Map<string, AiDomainSettings>) {}

  findDomainSettingsByEmail(email: string): Promise<AiDomainSettings | null> {
    const host = email.split('@')[1]?.toLowerCase() ?? '';
    return Promise.resolve(this.domains.get(host) ?? null);
  }
  findDomainSettingsById(id: number): Promise<AiDomainSettings | null> {
    return Promise.resolve([...this.domains.values()].find((d) => d.domainId === id) ?? null);
  }
  listDomainSettings(): Promise<AiDomainSettings[]> {
    return Promise.resolve([...this.domains.values()]);
  }
  saveDomainSettings(_id: number, _patch: AiDomainSettingsPatch): Promise<AiDomainSettings | null> {
    return Promise.resolve(null);
  }
  findUserSettings(email: string): Promise<AiUserSettings | null> {
    return Promise.resolve(this.users.get(email.toLowerCase()) ?? null);
  }
  grantConsent(
    email: string,
    endpoint: string,
    model: string,
    features: AiUserFeature[],
  ): Promise<AiUserSettings | null> {
    const value: AiUserSettings = {
      accountEmail: email.toLowerCase(),
      consentAt: new Date().toISOString(),
      consentEndpoint: endpoint,
      consentModel: model,
      features,
    };
    this.users.set(email.toLowerCase(), value);
    return Promise.resolve(value);
  }
  revokeConsent(email: string): Promise<void> {
    this.users.delete(email.toLowerCase());
    return Promise.resolve();
  }
  saveUserFeatures(): Promise<AiUserSettings | null> {
    return Promise.resolve(null);
  }
}

class FakeRedis implements AiRedis {
  readonly data = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.data.get(key) ?? null);
  }
  set(key: string, value: string): Promise<unknown> {
    this.data.set(key, value);
    return Promise.resolve('OK');
  }
  del(...keys: string[]): Promise<unknown> {
    for (const key of keys) this.data.delete(key);
    return Promise.resolve(keys.length);
  }
  scan(): Promise<[string, string[]]> {
    return Promise.resolve(['0', [...this.data.keys()]]);
  }
  incrby(key: string, increment: number): Promise<number> {
    const next = Number.parseInt(this.data.get(key) ?? '0', 10) + increment;
    this.data.set(key, String(next));
    return Promise.resolve(next);
  }
  expire(): Promise<unknown> {
    return Promise.resolve(1);
  }
}

async function fakeAiServer(): Promise<{
  baseUrl: string;
  calls: number;
  close: () => Promise<void>;
}> {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({ summary: 'Кратко.', bullets: [], actionRequired: false }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    get calls(): number {
      return state.calls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function letterFor(
  account: string,
): Parameters<Awaited<ReturnType<AiService['forFeature']>>['assistant']['summarizeMessage']>[0] {
  return {
    id: `inbox:${account}`,
    subject: 'Счёт на оплату',
    date: new Date('2026-03-12T09:00:00Z').toISOString(),
    from: { name: 'Бухгалтерия', address: 'buh@romashka.ru' },
    to: [{ name: null, address: account }],
    cc: [],
    bodyText: 'Просим оплатить счёт до 20 марта.',
    bodyHtml: null,
    attachments: [],
    headers: {},
  };
}

/* ------------------------------------------------------------------ */
/* Проверки                                                             */
/* ------------------------------------------------------------------ */

void test('ключ учёта строится по домену, а не по ящику', async () => {
  const calls: string[] = [];
  const inner = {
    check: (key: string) => {
      calls.push(key);
      return Promise.resolve({ allowed: true as const });
    },
    record: (key: string) => {
      calls.push(key);
      return Promise.resolve();
    },
    snapshot: (key: string) => {
      calls.push(key);
      return Promise.reject(new Error('не нужно'));
    },
    reset: (key: string) => {
      calls.push(key);
      return Promise.resolve();
    },
  };
  const tracker = new DomainBudgetTracker(inner, 'Mail.Local');
  await tracker.check('ivan@mail.local', 10);
  await tracker.record('anna@mail.local', {
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    estimated: false,
  });
  await tracker.reset('petr@mail.local');
  assert.deepEqual(calls, ['domain:mail.local', 'domain:mail.local', 'domain:mail.local']);
});

void test('предел «два запроса на домен» исчерпывается ДВУМЯ ящиками, а не каждым', async () => {
  const upstream = await fakeAiServer();
  try {
    const redis = new FakeRedis();
    const store = new MultiDomainStore(
      new Map([
        [
          'mail.local',
          settingsFor('mail.local', { baseUrl: upstream.baseUrl, maxRequestsPerPeriod: 2 }),
        ],
        [
          'other.local',
          settingsFor('other.local', { baseUrl: upstream.baseUrl, maxRequestsPerPeriod: 2 }),
        ],
      ]),
    );
    const service = new AiService({
      config: loadAiConfig({
        DATABASE_URL: 'postgres://unused/unused',
        AI_SETTINGS_CACHE_MS: '0',
      }),
      db: store,
      redis,
      keyBox: new AiKeyBox(SECRET),
      keyBoxReason: null,
      logger,
    });

    const ivan = 'ivan@mail.local';
    const anna = 'anna@mail.local';
    const boris = 'boris@other.local';
    for (const account of [ivan, anna, boris]) {
      await service.grantConsent(account, defaultFeatures());
    }

    const summarize = async (account: string): Promise<{ ok: boolean; kind: string | null }> => {
      const { assistant } = await service.forFeature(account, 'summary');
      const outcome = await assistant.summarizeMessage(letterFor(account), {
        accountId: account,
        skipCache: true,
      });
      return { ok: outcome.ok, kind: outcome.ok ? null : outcome.error.kind };
    };

    // Два разных ящика ОДНОГО домена расходуют общий предел домена.
    assert.equal((await summarize(ivan)).ok, true);
    assert.equal((await summarize(anna)).ok, true);

    // Третий запрос в этом домене — уже сверх предела, чей бы ящик ни был.
    const third = await summarize(ivan);
    assert.equal(third.ok, false, 'предел домена обязан отсечь третий запрос');
    assert.equal(third.kind, 'budget-exceeded');

    // А соседний домен со своим пределом не задет.
    assert.equal((await summarize(boris)).ok, true, 'у другого домена свой предел');

    // Ключи учёта в Redis именованы доменом — счётчик один на домен.
    const budgetKeys = [...redis.data.keys()].filter((k) => k.includes('budget'));
    assert.ok(
      budgetKeys.every((k) => k.includes('domain:')),
      `ключи учёта должны быть доменными: ${budgetKeys.join(', ')}`,
    );
    assert.ok(!budgetKeys.some((k) => k.includes('ivan@') || k.includes('anna@')));
  } finally {
    await upstream.close();
  }
});

void test('остаток предела в состоянии для интерфейса тоже доменный', async () => {
  const upstream = await fakeAiServer();
  try {
    const redis = new FakeRedis();
    const store = new MultiDomainStore(
      new Map([
        [
          'mail.local',
          settingsFor('mail.local', { baseUrl: upstream.baseUrl, maxRequestsPerPeriod: 5 }),
        ],
      ]),
    );
    const service = new AiService({
      config: loadAiConfig({
        DATABASE_URL: 'postgres://unused/unused',
        AI_SETTINGS_CACHE_MS: '0',
      }),
      db: store,
      redis,
      keyBox: new AiKeyBox(SECRET),
      keyBoxReason: null,
      logger,
    });
    await service.grantConsent('ivan@mail.local', defaultFeatures());
    await service.grantConsent('anna@mail.local', defaultFeatures());

    const { assistant } = await service.forFeature('ivan@mail.local', 'summary');
    await assistant.summarizeMessage(letterFor('ivan@mail.local'), {
      accountId: 'ivan@mail.local',
      skipCache: true,
    });

    // Анна не сделала ни одного запроса, но видит общий расход домена:
    // предел один на всех, и показывать его надо честно.
    const state = await service.state('anna@mail.local');
    assert.equal(state.budget?.requestsUsed, 1);
    assert.equal(state.budget?.requestsLeft, 4);
  } finally {
    await upstream.close();
  }
});
