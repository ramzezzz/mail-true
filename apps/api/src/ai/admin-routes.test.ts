/**
 * Признак «модель поднята на этом же сервере — письма не покидают
 * периметр» приходил от клиента.
 *
 * Это единственное поле настроек ИИ, на котором держится обещание,
 * которое читает КАЖДЫЙ пользователь домена на экране согласия. Вывод
 * признака из адреса жил только в браузере админки, а маршрут принимал
 * его обычным булевым полем и писал в базу как есть. Запрос мимо формы —
 * curl, старая сборка админки, чей-нибудь скрипт — с адресом
 * https://api.openai.com/v1 и local=true заставлял почту обещать людям
 * то, чего нет: письма уходили во внешний сервис, а экран согласия,
 * опись отправленного и журнал обращений говорили обратное.
 *
 * Здесь закреплено, что признак выводится на сервере из адреса и
 * прислать его нельзя никак.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { loadAdminConfig } from '../admin/config.js';
import type { AdminDb } from '../admin/db.js';
import { MemoryAdminSessionStore } from '../admin/session.js';
import { ServerSettings } from '../admin/server-settings.js';
import type { AdminContext } from '../admin/types.js';
import { aiAdminRoutes } from './admin.js';
import { loadAiConfig } from './config.js';
import type {
  AiDomainSettings,
  AiDomainSettingsPatch,
  AiSettingsStore,
  AiUserSettings,
} from './db.js';
import { AiKeyBox } from './secret.js';
import { AiService } from './service.js';

const SECRET = 'test-secret-0123456789-0123456789';
const ENCRYPTION = 'k'.repeat(40);
const logger = pino({ level: 'silent' });

interface DomainDto {
  local: boolean;
  baseUrl: string | null;
  providerLabel: string;
}

function domainRow(patch: Partial<AiDomainSettings> = {}): AiDomainSettings {
  return {
    domainId: 1,
    domain: 'mail.local',
    enabled: true,
    baseUrl: 'http://127.0.0.1:11434/v1',
    chatPath: '/chat/completions',
    apiKeyEnc: null,
    apiKeyHint: null,
    model: 'qwen2.5:7b',
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

class FakeAiStore implements AiSettingsStore {
  row: AiDomainSettings;
  readonly patches: AiDomainSettingsPatch[] = [];

  constructor(row: AiDomainSettings) {
    this.row = row;
  }

  findDomainSettingsByEmail(): Promise<AiDomainSettings | null> {
    return Promise.resolve(this.row);
  }
  findDomainSettingsById(): Promise<AiDomainSettings | null> {
    return Promise.resolve(this.row);
  }
  listDomainSettings(): Promise<AiDomainSettings[]> {
    return Promise.resolve([this.row]);
  }
  saveDomainSettings(_id: number, patch: AiDomainSettingsPatch): Promise<AiDomainSettings | null> {
    this.patches.push(patch);
    this.row = { ...this.row, ...patch } as AiDomainSettings;
    return Promise.resolve(this.row);
  }
  findUserSettings(): Promise<AiUserSettings | null> {
    return Promise.resolve(null);
  }
  grantConsent(): Promise<AiUserSettings | null> {
    return Promise.resolve(null);
  }
  revokeConsent(): Promise<void> {
    return Promise.resolve();
  }
  saveUserFeatures(): Promise<AiUserSettings | null> {
    return Promise.resolve(null);
  }
}

class FakeAdminDb {
  readonly audits: Record<string, unknown>[] = [];
  findAdminById(id: number): Promise<Record<string, unknown>> {
    return Promise.resolve({ id, login: 'osmotr', role: 'owner', active: true });
  }
  writeAudit(record: Record<string, unknown>): Promise<void> {
    this.audits.push(record);
    return Promise.resolve();
  }
  query<T>(): Promise<T[]> {
    return Promise.resolve([]);
  }
}

interface Harness {
  app: FastifyInstance;
  store: FakeAiStore;
  cookie: string;
}

async function harness(row: AiDomainSettings): Promise<Harness> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const adminDb = new FakeAdminDb();
  const sessions = new MemoryAdminSessionStore();
  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: SECRET,
  } as NodeJS.ProcessEnv);

  const ctx: AdminContext = {
    config,
    db: adminDb as unknown as AdminDb,
    sessions,
    mailbox: {} as AdminContext['mailbox'],
    queueAgent: {} as AdminContext['queueAgent'],
    branding: {} as AdminContext['branding'],
    cookieSecure: false,
    importBox: null,
    serverSettings: new ServerSettings({ db: adminDb, env: {}, cacheMs: 0 }),
  };
  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);

  const store = new FakeAiStore(row);
  const service = new AiService({
    config: loadAiConfig({
      DATABASE_URL: 'postgres://unused/unused',
      AI_SETTINGS_CACHE_MS: '0',
    }),
    db: store,
    redis: null,
    keyBox: new AiKeyBox(ENCRYPTION),
    keyBoxReason: null,
    logger,
  });
  await aiAdminRoutes(app, service);

  const sessionId = 'test-session';
  await sessions.set(
    sessionId,
    { adminId: 1, login: 'osmotr', role: 'owner', createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );

  return {
    app,
    store,
    cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${app.signCookie(sessionId)}`,
  };
}

void test('«внутри периметра» нельзя прислать запросом мимо формы', async () => {
  const h = await harness(domainRow());

  const response = await h.app.inject({
    method: 'PATCH',
    url: '/ai/domains/1',
    headers: { cookie: h.cookie },
    payload: {
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      providerLabel: 'Своя модель на сервере',
      // Ровно то, что отправлял бы curl или старая сборка админки.
      local: true,
    },
  });

  assert.equal(response.statusCode, 200);
  const dto = response.json<DomainDto>();
  assert.equal(dto.local, false, 'внешний адрес не может назваться внутренним, что бы ни прислали');

  // И в базу ушло то же самое: строка не должна врать даже при чтении
  // в обход этого маршрута.
  assert.equal(h.store.row.local, false);
  assert.equal(h.store.patches.at(-1)?.local, false);
});

void test('признак пересчитывается и когда адрес не трогают', async () => {
  // Внешний адрес уже записан, а правят соседнее поле. Раньше признак
  // оставался таким, каким его когда-то прислали.
  const h = await harness(domainRow({ baseUrl: 'https://api.openai.com/v1', local: true }));

  const response = await h.app.inject({
    method: 'PATCH',
    url: '/ai/domains/1',
    headers: { cookie: h.cookie },
    payload: { providerLabel: 'OpenAI' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json<DomainDto>().local, false);
  assert.equal(h.store.row.local, false);
});

void test('строка, оставшаяся от старой версии, не врёт при чтении', async () => {
  // В базе лежит is_local = true при внешнем адресе — так могло остаться
  // от версии, где признак приходил от клиента. Показывать это
  // администратору нельзя ни секунды: по этому полю он решает,
  // включать ли помощника вообще.
  const h = await harness(domainRow({ baseUrl: 'https://api.openai.com/v1', local: true }));

  const one = await h.app.inject({
    method: 'GET',
    url: '/ai/domains/1',
    headers: { cookie: h.cookie },
  });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json<DomainDto>().local, false);

  const list = await h.app.inject({
    method: 'GET',
    url: '/ai/domains',
    headers: { cookie: h.cookie },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json<{ items: DomainDto[] }>().items[0]?.local, false);
});

void test('местный адрес остаётся местным', async () => {
  const h = await harness(domainRow({ local: false }));

  const response = await h.app.inject({
    method: 'PATCH',
    url: '/ai/domains/1',
    headers: { cookie: h.cookie },
    payload: { baseUrl: 'http://ollama:11434/v1', local: false },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json<DomainDto>().local, true, 'сосед по сети контейнеров — внутри');
});
