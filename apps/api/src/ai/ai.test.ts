/**
 * Проверки помощника на основе ИИ.
 *
 * Проверяется ровно то, на чём держится обещание из docs/ai-spec.md:
 *
 *   1. Ключ доступа шифруется, и чужим ключом шифрования его не прочитать.
 *   2. Настройки разграничены по уровням: администратор -> пользователь ->
 *      действие, и нижний уровень не может разрешить то, что запретил верхний.
 *   3. Когда помощник выключен, наружу не уходит ничего, а маршруты
 *      отвечают понятно.
 *   4. Отзыв согласия ДЕЙСТВИТЕЛЬНО удаляет созданные резюме и метки —
 *      именно этого пользователя и не задевая чужих.
 *
 * Четвёртая проверка идёт через настоящий HTTP-сервер, изображающий сервис
 * ИИ: иначе «результат сохранился в кэш» осталось бы предположением.
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
import { AI_FEATURES, defaultFeatures, type AiUserFeature } from './features.js';
import {
  AiConsentRequiredError,
  AiDisabledError,
  AiFeatureOffError,
  AiUnavailableError,
} from './errors.js';
import { AiKeyBox, AiKeyBoxError, createKeyBox, keyHint } from './secret.js';
import { AiService, accountKey } from './service.js';

const logger = pino({ level: 'silent' });

/* ------------------------------------------------------------------ */
/* 1. Шифрование ключа доступа                                          */
/* ------------------------------------------------------------------ */

const SECRET_A = 'a'.repeat(40);
const SECRET_B = 'b'.repeat(40);

void test('ключ доступа шифруется и расшифровывается обратно', () => {
  const box = new AiKeyBox(SECRET_A);
  const plain = 'sk-proj-0123456789abcdefXYZ';
  const boxed = box.encrypt(plain);

  // В шифротексте не должно быть исходного ключа ни целиком, ни куском.
  assert.ok(!boxed.includes(plain));
  assert.ok(!boxed.includes('0123456789'));
  assert.equal(box.decrypt(boxed), plain);
});

void test('одинаковый ключ шифруется каждый раз по-разному', () => {
  const box = new AiKeyBox(SECRET_A);
  const first = box.encrypt('sk-one');
  const second = box.encrypt('sk-one');
  // Разные вектора инициализации: одинаковые ключи не опознать по шифротексту.
  assert.notEqual(first, second);
  assert.equal(box.decrypt(first), 'sk-one');
  assert.equal(box.decrypt(second), 'sk-one');
});

void test('чужим ключом шифрования ключ доступа не прочитать', () => {
  const boxed = new AiKeyBox(SECRET_A).encrypt('sk-secret');
  assert.throws(() => new AiKeyBox(SECRET_B).decrypt(boxed), AiKeyBoxError);
});

void test('подменённый шифротекст не расшифровывается, а честно отказывает', () => {
  const box = new AiKeyBox(SECRET_A);
  const boxed = box.encrypt('sk-secret');

  // Портим ровно один байт, причём на уровне БАЙТОВ, а не символов:
  // правка последнего символа base64url может задеть только отбрасываемые
  // биты дополнения и ничего не изменить — тогда проверка была бы
  // то срабатывающей, то нет, что хуже её отсутствия.
  const raw = Buffer.from(boxed.slice('v1.'.length), 'base64url');
  for (const index of [0, 13, raw.length - 1]) {
    const damaged = Buffer.from(raw);
    damaged[index] = (raw[index] ?? 0) ^ 0xff;
    assert.notDeepEqual(damaged, raw);
    assert.throws(
      () => box.decrypt(`v1.${damaged.toString('base64url')}`),
      AiKeyBoxError,
      `подмена байта ${String(index)} должна быть замечена`,
    );
  }

  assert.throws(() => box.decrypt('мусор'), AiKeyBoxError);
  assert.throws(() => box.decrypt('v1.'), AiKeyBoxError);
});

void test('слишком короткий секрет шифрования не принимается', () => {
  assert.throws(() => new AiKeyBox('коротко'), AiKeyBoxError);
  const short = createKeyBox('коротко');
  assert.equal(short.box, null);
  assert.match(String(short.reason), /не менее 32/);
});

void test('без переменной окружения шифровальщика нет, но причина названа', () => {
  const missing = createKeyBox(undefined);
  assert.equal(missing.box, null);
  assert.match(String(missing.reason), /AI_ENCRYPTION_KEY/);

  const present = createKeyBox(SECRET_A);
  assert.ok(present.box);
  assert.equal(present.reason, null);
});

void test('подсказка показывает только хвост ключа', () => {
  assert.equal(keyHint('sk-proj-abcd1234'), '…1234');
  assert.equal(keyHint(''), '');
});

/* ------------------------------------------------------------------ */
/* Поддельные хранилища                                                 */
/* ------------------------------------------------------------------ */

function domainSettings(patch: Partial<AiDomainSettings> = {}): AiDomainSettings {
  return {
    domainId: 1,
    domain: 'mail.local',
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

/** Хранилище настроек в памяти. Повторяет поведение AiDb, но без Postgres. */
class FakeStore implements AiSettingsStore {
  domain: AiDomainSettings | null;
  readonly users = new Map<string, AiUserSettings>();

  constructor(domain: AiDomainSettings | null) {
    this.domain = domain;
  }

  findDomainSettingsByEmail(email: string): Promise<AiDomainSettings | null> {
    const host = email.split('@')[1]?.toLowerCase() ?? '';
    return Promise.resolve(this.domain && this.domain.domain === host ? this.domain : null);
  }
  findDomainSettingsById(): Promise<AiDomainSettings | null> {
    return Promise.resolve(this.domain);
  }
  listDomainSettings(): Promise<AiDomainSettings[]> {
    return Promise.resolve(this.domain ? [this.domain] : []);
  }
  saveDomainSettings(_id: number, patch: AiDomainSettingsPatch): Promise<AiDomainSettings | null> {
    if (this.domain) this.domain = { ...this.domain, ...patch } as AiDomainSettings;
    return Promise.resolve(this.domain);
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
  saveUserFeatures(email: string, features: AiUserFeature[]): Promise<AiUserSettings | null> {
    const existing = this.users.get(email.toLowerCase());
    if (!existing) return Promise.resolve(null);
    const value = { ...existing, features };
    this.users.set(email.toLowerCase(), value);
    return Promise.resolve(value);
  }
}

/** Redis в памяти: ровно те команды, которыми пользуется помощник. */
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
    let removed = 0;
    for (const key of keys) if (this.data.delete(key)) removed += 1;
    return Promise.resolve(removed);
  }
  scan(
    _cursor: string | number,
    _matchToken: 'MATCH',
    pattern: string,
    _countToken: 'COUNT',
    _count: number,
  ): Promise<[string, string[]]> {
    const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
    return Promise.resolve(['0', [...this.data.keys()].filter((k) => re.test(k))]);
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

function escapeRe(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeService(init: {
  store: AiSettingsStore | null;
  redis?: AiRedis | null;
  env?: NodeJS.ProcessEnv;
}): AiService {
  return new AiService({
    config: loadAiConfig({
      DATABASE_URL: 'postgres://unused/unused',
      // Кэш настроек в тестах не нужен: он бы прятал изменения.
      AI_SETTINGS_CACHE_MS: '0',
      ...init.env,
    }),
    db: init.store,
    redis: init.redis ?? null,
    keyBox: new AiKeyBox(SECRET_A),
    keyBoxReason: null,
    logger,
  });
}

const USER = 'test@mail.local';

/* ------------------------------------------------------------------ */
/* 2. Выключенный помощник                                              */
/* ------------------------------------------------------------------ */

void test('администратор выключил ИИ: состояние пустое, кнопкам не из чего браться', async () => {
  const service = makeService({ store: new FakeStore(domainSettings({ enabled: false })) });
  const state = await service.state(USER);

  assert.equal(state.enabled, false);
  assert.equal(state.provider, null);
  assert.deepEqual(state.features, []);
  assert.deepEqual(state.neverSent, []);
  assert.equal(state.budget, null);
  assert.equal(state.consent.given, false);
});

void test('при выключенном ИИ вызов возможности отказывает понятно', async () => {
  const service = makeService({ store: new FakeStore(domainSettings({ enabled: false })) });
  await assert.rejects(() => service.forFeature(USER, 'summary'), AiDisabledError);
});

void test('общий выключатель сервера сильнее настроек домена', async () => {
  const service = makeService({
    store: new FakeStore(domainSettings({ enabled: true })),
    env: { AI_ENABLED: 'false' },
  });
  const state = await service.state(USER);
  assert.equal(state.enabled, false);
  await assert.rejects(() => service.forFeature(USER, 'summary'), AiDisabledError);
});

void test('без базы помощник выключен, а не сломан', async () => {
  const service = makeService({ store: null });
  const state = await service.state(USER);
  assert.equal(state.enabled, false);
  await assert.rejects(() => service.forFeature(USER, 'summary'), AiUnavailableError);
});

void test('упавшая база выключает помощника, но не роняет запрос', async () => {
  // Postgres может уехать в перезагрузку в любой момент. Помощник обязан
  // это пережить: почта важнее подсказок.
  const broken: AiSettingsStore = {
    findDomainSettingsByEmail: () => Promise.reject(new Error('connect ECONNREFUSED')),
    findDomainSettingsById: () => Promise.reject(new Error('connect ECONNREFUSED')),
    listDomainSettings: () => Promise.reject(new Error('connect ECONNREFUSED')),
    saveDomainSettings: () => Promise.reject(new Error('connect ECONNREFUSED')),
    findUserSettings: () => Promise.reject(new Error('connect ECONNREFUSED')),
    grantConsent: () => Promise.reject(new Error('connect ECONNREFUSED')),
    revokeConsent: () => Promise.reject(new Error('connect ECONNREFUSED')),
    saveUserFeatures: () => Promise.reject(new Error('connect ECONNREFUSED')),
  };
  const service = makeService({ store: broken });

  const state = await service.state(USER);
  assert.equal(state.enabled, false, 'состояние отдаётся, а не превращается в ошибку');
  assert.deepEqual(state.features, []);
  await assert.rejects(() => service.forFeature(USER, 'summary'), AiUnavailableError);
});

void test('включённый домен без адреса сервиса не выдаёт себя за рабочий', async () => {
  const service = makeService({
    store: new FakeStore(domainSettings({ enabled: true, baseUrl: null, model: null })),
  });
  const availability = await service.availability(USER);
  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'misconfigured');
  assert.equal((await service.state(USER)).enabled, false);
  await assert.rejects(() => service.forFeature(USER, 'summary'), AiUnavailableError);
});

/* ------------------------------------------------------------------ */
/* 3. Разграничение настроек по уровням                                 */
/* ------------------------------------------------------------------ */

void test('домен разрешил, но согласия нет: кнопки видны, вызов требует согласия', async () => {
  const service = makeService({ store: new FakeStore(domainSettings()) });
  const state = await service.state(USER);

  assert.equal(state.enabled, true);
  assert.equal(state.consent.given, false);
  assert.equal(state.provider?.local, true);
  assert.equal(state.features.length, AI_FEATURES.length);
  assert.ok(state.neverSent.length > 0);

  await assert.rejects(() => service.forFeature(USER, 'summary'), AiConsentRequiredError);
});

void test('после согласия возможность из набора по умолчанию работает', async () => {
  const store = new FakeStore(domainSettings());
  const service = makeService({ store });
  await service.grantConsent(USER, defaultFeatures());

  const { assistant } = await service.forFeature(USER, 'summary');
  assert.equal(assistant.model, 'test-model');
  assert.equal(assistant.local, true);

  const state = await service.state(USER);
  assert.equal(state.consent.given, true);
  assert.equal(state.consent.matchesProvider, true);
});

void test('администратор домена сильнее пользователя: запрещённую возможность не включить', async () => {
  // Домен разрешает только резюме — всё остальное запрещено.
  const store = new FakeStore(domainSettings({ featuresAllowed: ['summary'] }));
  const service = makeService({ store });
  // Пользователь просит всё, что есть.
  await service.grantConsent(USER, [...AI_FEATURES]);

  const state = await service.state(USER);
  const translate = state.features.find((f) => f.key === 'translate');
  assert.equal(translate?.allowed, false);
  // Даже с согласием и явным желанием пользователя — выключено.
  assert.equal(translate?.enabled, false);

  await assert.doesNotReject(() => service.forFeature(USER, 'summary'));
  await assert.rejects(() => service.forFeature(USER, 'translate'), AiFeatureOffError);
});

void test('пользователь может выключить у себя то, что домен разрешил', async () => {
  const store = new FakeStore(domainSettings());
  const service = makeService({ store });
  await service.grantConsent(USER, ['summary']);

  await assert.doesNotReject(() => service.forFeature(USER, 'summary'));
  await assert.rejects(() => service.forFeature(USER, 'extract'), AiFeatureOffError);

  // И может передумать.
  await service.saveFeatures(USER, ['summary', 'extract']);
  await assert.doesNotReject(() => service.forFeature(USER, 'extract'));
});

void test('смена сервиса администратором обесценивает старое согласие', async () => {
  const store = new FakeStore(domainSettings());
  const service = makeService({ store });
  await service.grantConsent(USER, defaultFeatures());
  await assert.doesNotReject(() => service.forFeature(USER, 'summary'));

  // Администратор увёл письма на другой адрес.
  store.domain = domainSettings({ baseUrl: 'https://external.example.com/v1', local: false });

  const state = await service.state(USER);
  assert.equal(state.consent.given, true);
  assert.equal(state.consent.matchesProvider, false, 'согласие больше не соответствует сервису');
  await assert.rejects(
    () => service.forFeature(USER, 'summary'),
    (err: unknown) => err instanceof AiConsentRequiredError && /сменил сервис/.test(err.message),
  );
});

void test('без согласия настройки возможностей менять нельзя', async () => {
  const service = makeService({ store: new FakeStore(domainSettings()) });
  await assert.rejects(() => service.saveFeatures(USER, ['summary']), AiConsentRequiredError);
});

/* ------------------------------------------------------------------ */
/* 4. Отзыв согласия удаляет созданное                                  */
/* ------------------------------------------------------------------ */

/** Поднимает сервер, изображающий совместимый сервис ИИ. */
async function fakeAiServer(): Promise<{
  baseUrl: string;
  calls: number;
  close(): Promise<void>;
}> {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  summary: 'Счёт на 45 600 рублей, оплатить до 20 марта.',
                  bullets: ['Счёт № 1024', 'Срок оплаты 20 марта'],
                  actionRequired: true,
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const LETTER = {
  id: 'inbox:42',
  threadId: 'thread-1',
  subject: 'Счёт на оплату № 1024',
  date: new Date('2026-03-12T09:00:00Z').toISOString(),
  from: { name: 'Бухгалтерия', address: 'buh@romashka.ru' },
  to: [{ name: null, address: USER }],
  cc: [],
  bodyText: 'Направляем счёт № 1024 на сумму 45 600 руб. Просим оплатить до 20 марта.',
  bodyHtml: null,
  attachments: [],
  headers: {},
};

void test('отзыв согласия удаляет созданные резюме именно этого пользователя', async () => {
  const upstream = await fakeAiServer();
  const redis = new FakeRedis();
  const other = 'migsrc@mail.local';

  try {
    const store = new FakeStore(domainSettings({ baseUrl: upstream.baseUrl }));
    const service = makeService({ store, redis });

    await service.grantConsent(USER, defaultFeatures());
    await service.grantConsent(other, defaultFeatures());

    // 1. Настоящий вызов: результат должен осесть в кэше.
    const first = await service.forFeature(USER, 'summary');
    const summary = await first.assistant.summarizeMessage(LETTER, { accountId: USER });
    assert.ok(summary.ok, 'помощник должен ответить');
    assert.equal(summary.cached, false);
    assert.ok(summary.disclosure, 'при настоящей отправке должна быть опись отправленного');
    assert.equal(upstream.calls, 1);

    // 2. Повтор берётся из кэша: наружу второй раз не уходит.
    const again = await service.forFeature(USER, 'summary');
    const cached = await again.assistant.summarizeMessage(LETTER, { accountId: USER });
    assert.ok(cached.ok);
    assert.equal(cached.cached, true, 'второй раз ответ должен прийти из кэша');
    assert.equal(cached.disclosure, null, 'из кэша наружу ничего не уходит — описи быть не должно');
    assert.equal(upstream.calls, 1, 'сервис ИИ не должен получить второй запрос');

    // 3. У другого пользователя тоже что-то накопилось.
    const otherRun = await service.forFeature(other, 'summary');
    assert.ok((await otherRun.assistant.summarizeMessage(LETTER, { accountId: other })).ok);

    const keysOf = (email: string): string[] =>
      [...redis.data.keys()].filter((k) => k.includes(`u:${accountKey(email)}:`));
    assert.ok(keysOf(USER).length > 0, 'резюме должно было сохраниться');
    assert.ok(keysOf(other).length > 0);

    // 4. Отзыв согласия.
    const result = await service.revokeConsent(USER);
    assert.ok(result.removedCacheEntries > 0, 'должны быть удалены записи кэша');

    assert.deepEqual(keysOf(USER), [], 'резюме этого пользователя должны исчезнуть');
    assert.ok(keysOf(other).length > 0, 'чужие резюме трогать нельзя');
    assert.equal(await store.findUserSettings(USER), null, 'согласие должно быть удалено');

    // 5. Согласие отозвано — вызывать нельзя.
    await assert.rejects(() => service.forFeature(USER, 'summary'), AiConsentRequiredError);

    // 6. После нового согласия результат считается заново: старого кэша нет.
    await service.grantConsent(USER, defaultFeatures());
    const afresh = await service.forFeature(USER, 'summary');
    const recomputed = await afresh.assistant.summarizeMessage(LETTER, { accountId: USER });
    assert.ok(recomputed.ok);
    assert.equal(recomputed.cached, false, 'удалённое резюме не должно воскреснуть');
    assert.equal(upstream.calls, 3, 'понадобился новый запрос к сервису');
  } finally {
    await upstream.close();
  }
});

void test('удалить созданное по письму можно и при выключенной возможности', async () => {
  const upstream = await fakeAiServer();
  const redis = new FakeRedis();
  try {
    const store = new FakeStore(domainSettings({ baseUrl: upstream.baseUrl }));
    const service = makeService({ store, redis });
    await service.grantConsent(USER, ['summary']);

    const { assistant } = await service.forFeature(USER, 'summary');
    assert.ok((await assistant.summarizeMessage(LETTER, { accountId: USER })).ok);
    assert.ok(redis.data.size > 0);

    // Пользователь выключил резюме у себя — но право удалить уже
    // созданное от этого пропасть не может.
    await service.saveFeatures(USER, []);
    await assert.rejects(() => service.forFeature(USER, 'summary'), AiFeatureOffError);

    const removed = await service.forgetMessage(USER, LETTER.id);
    assert.ok(removed > 0, 'записи по письму должны быть удалены');
    assert.equal(
      [...redis.data.keys()].filter((k) => k.includes(encodeURIComponent(LETTER.id))).length,
      0,
    );
  } finally {
    await upstream.close();
  }
});

void test('без согласия удалять нечего и незачем — маршрут отказывает', async () => {
  const service = makeService({ store: new FakeStore(domainSettings()), redis: new FakeRedis() });
  await assert.rejects(() => service.forgetMessage(USER, 'inbox:1'), AiConsentRequiredError);
});

void test('вложения и служебные заголовки наружу не уходят', async () => {
  const upstream = await fakeAiServer();
  try {
    const store = new FakeStore(domainSettings({ baseUrl: upstream.baseUrl }));
    const service = makeService({ store, redis: new FakeRedis() });
    await service.grantConsent(USER, defaultFeatures());

    const { assistant } = await service.forFeature(USER, 'summary');
    const outcome = await assistant.summarizeMessage(
      {
        ...LETTER,
        attachments: [{ filename: 'schet-1024.pdf', mimeType: 'application/pdf', size: 84_213 }],
        headers: { 'DKIM-Signature': 'v=1; a=rsa-sha256;' },
      },
      { accountId: USER },
    );

    assert.ok(outcome.ok);
    const disclosure = outcome.disclosure;
    assert.ok(disclosure);
    // Имя вложения названо как исключённое, а его содержимое никуда не идёт.
    assert.deepEqual(disclosure.attachmentsExcluded, ['schet-1024.pdf']);
    const sent = disclosure.fields.map((f) => f.value).join('\n');
    assert.ok(!sent.includes('DKIM-Signature'));
    assert.ok(disclosure.removed.some((r) => r.kind === 'attachment'));
    assert.ok(disclosure.removed.some((r) => r.kind === 'headers'));
    // Опись описывает именно тот сервис, что настроен.
    assert.equal(disclosure.local, true);
    assert.equal(disclosure.providerLabel, 'Локальная модель');
  } finally {
    await upstream.close();
  }
});

void test('предел расходов останавливает вызов до отправки', async () => {
  const upstream = await fakeAiServer();
  try {
    const store = new FakeStore(
      domainSettings({ baseUrl: upstream.baseUrl, maxRequestsPerPeriod: 1 }),
    );
    const service = makeService({ store, redis: new FakeRedis() });
    await service.grantConsent(USER, defaultFeatures());

    const { assistant } = await service.forFeature(USER, 'summary');
    assert.ok((await assistant.summarizeMessage(LETTER, { accountId: USER })).ok);

    // Второй вызов мимо кэша: предел уже исчерпан.
    const blocked = await assistant.summarizeMessage(LETTER, { accountId: USER, skipCache: true });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.error.kind, 'budget-exceeded');
      assert.match(blocked.error.message, /предел обращений/);
    }
    assert.equal(upstream.calls, 1, 'при исчерпанном пределе наружу ничего не уходит');
  } finally {
    await upstream.close();
  }
});
