/**
 * Проверки маршрутов раздела «Настройки сервера».
 *
 * Что здесь закрыто:
 *
 *   1. Секрет утёк наружу. Пароль базы, секрет сессии и ключи шифрования
 *      перечислены в списке настроек (иначе их негде было бы запретить),
 *      и ровно поэтому проверяется, что ни одно их значение не попадает
 *      в ответ ни целиком, ни в каком-либо ином виде.
 *   2. Настройки сервера доступны не владельцу. Раньше эти значения жили
 *      в infra/.env, то есть менял их тот, у кого есть SSH; перенос в веб
 *      обязан оставить круг тем же.
 *   3. Изменение не оставило следа. Каждое действие обязано попасть
 *      в журнал аудита — со старым значением и новым.
 *   4. Панель обещает «действует сразу» там, где нужен перезапуск.
 *      Признак приходит с сервера, а не додумывается интерфейсом.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminServerSettingsRoutes } from './routes/server-settings.js';
import { applyRowsToEnv, ServerSettings } from './server-settings.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

interface SettingDto {
  key: string;
  group: string;
  value: unknown;
  source: string;
  secret: boolean;
  editable: boolean;
  configured: boolean | null;
  requiresRestart: boolean;
  pendingRestart: boolean;
  description: string;
  reason: string | null;
  default: unknown;
  min: number | null;
  max: number | null;
}

interface ListDto {
  sections: Array<{ id: string; title: string; settings: SettingDto[] }>;
  counts: Record<string, number>;
}

class FakeDb {
  rows: Array<{ key: string; value: string; updated_by: string | null; updated_at: Date }> = [];
  audits: Array<Record<string, unknown>> = [];
  role = 'owner';

  async findAdminById(id: number): Promise<Record<string, unknown>> {
    return { id, login: 'osmotr', role: this.role, active: true };
  }
  async writeAudit(record: Record<string, unknown>): Promise<void> {
    this.audits.push(record);
  }
  async query<T>(text: string, values: unknown[] = []): Promise<T[]> {
    if (text.startsWith('SELECT')) return this.rows as unknown as T[];
    if (text.startsWith('INSERT')) {
      const [key, value, by] = values as [string, string, string];
      const found = this.rows.find((r) => r.key === key);
      if (found) {
        found.value = value;
        found.updated_by = by;
      } else this.rows.push({ key, value, updated_by: by, updated_at: new Date() });
      return [];
    }
    if (text.startsWith('DELETE')) {
      const [key] = values as [string];
      this.rows = this.rows.filter((r) => r.key !== key);
      return [];
    }
    return [];
  }
}

interface Harness {
  app: FastifyInstance;
  db: FakeDb;
  cookie: string;
  /** Окружение этого стенда: в него подмешивает значения старт сервера. */
  env: NodeJS.ProcessEnv;
}

async function harness(options?: { role?: string; env?: NodeJS.ProcessEnv }): Promise<Harness> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const db = new FakeDb();
  db.role = options?.role ?? 'owner';
  const sessions = new MemoryAdminSessionStore();
  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: SECRET,
  } as NodeJS.ProcessEnv);

  const env: NodeJS.ProcessEnv = options?.env ?? {
    MAIL_DOMAIN: 'mail.local',
    POSTGRES_PASSWORD: 'ochen-sekretnyy-parol-bazy',
    SESSION_SECRET: 'ochen-sekretnyy-sekret-sessii',
    ADMIN_DEFAULT_QUOTA_BYTES: '1073741824',
    MAIL_FLOW_RETENTION_DAYS: '14',
  };

  const ctx: AdminContext = {
    config,
    db: db as unknown as AdminDb,
    sessions,
    mailbox: {} as AdminContext['mailbox'],
    queueAgent: {} as AdminContext['queueAgent'],
    branding: {} as AdminContext['branding'],
    cookieSecure: false,
    importBox: null,
    serverSettings: new ServerSettings({ db, env, cacheMs: 0 }),
  };

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  await adminServerSettingsRoutes(app);

  const sessionId = 'test-session';
  await sessions.set(
    sessionId,
    { adminId: 1, login: 'osmotr', role: db.role, createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  return {
    app,
    db,
    env,
    cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${app.signCookie(sessionId)}`,
  };
}

function allSettings(body: ListDto): SettingDto[] {
  return body.sections.flatMap((s) => s.settings);
}

/* ------------------------------------------------------------------ */
/* 1. Секреты наружу не выходят                                         */
/* ------------------------------------------------------------------ */

void test('значения секретов не отдаются ни в каком виде', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'GET',
    url: '/server-settings',
    headers: { cookie: h.cookie },
  });
  assert.equal(response.statusCode, 200);

  // Ни одной подстроки настоящего секрета в теле ответа — ни целиком,
  // ни звёздочками, из которых его можно было бы «показать».
  assert.equal(response.body.includes('ochen-sekretnyy-parol-bazy'), false);
  assert.equal(response.body.includes('ochen-sekretnyy-sekret-sessii'), false);

  const items = allSettings(response.json<ListDto>());
  const password = items.find((i) => i.key === 'POSTGRES_PASSWORD');
  assert.ok(password, 'секрет должен быть перечислен — иначе непонятно, задан ли он');
  assert.equal(password.value, null);
  assert.equal(password.default, null);
  assert.equal(password.secret, true);
  assert.equal(password.editable, false);
  // Единственное, что о нём известно: задан или нет.
  assert.equal(password.configured, true);
});

void test('секрет нельзя задать и через запись', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'PUT',
    url: '/server-settings/POSTGRES_PASSWORD',
    headers: { cookie: h.cookie },
    payload: { value: 'novyy-parol' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json<{ message: string }>().message, /не меняется из панели/u);
  assert.equal(h.db.rows.length, 0);
});

void test('настройку устройства стека тоже не записать', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'PUT',
    url: '/server-settings/MAIL_DOMAIN',
    headers: { cookie: h.cookie },
    payload: { value: 'zloy.example' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(h.db.rows.length, 0);
});

/* ------------------------------------------------------------------ */
/* 2. Права: настройки сервера — только владельцу                       */
/* ------------------------------------------------------------------ */

void test('роль «управление пользователями» не видит и не меняет настройки сервера', async () => {
  const h = await harness({ role: 'user_manager' });
  const read = await h.app.inject({
    method: 'GET',
    url: '/server-settings',
    headers: { cookie: h.cookie },
  });
  assert.equal(read.statusCode, 403);

  const write = await h.app.inject({
    method: 'PUT',
    url: '/server-settings/MAIL_FLOW_RETENTION_DAYS',
    headers: { cookie: h.cookie },
    payload: { value: 30 },
  });
  assert.equal(write.statusCode, 403);
  assert.equal(h.db.rows.length, 0);
});

void test('роль «только чтение» тоже не допускается', async () => {
  const h = await harness({ role: 'readonly' });
  const read = await h.app.inject({
    method: 'GET',
    url: '/server-settings',
    headers: { cookie: h.cookie },
  });
  assert.equal(read.statusCode, 403);
});

void test('без сессии — 401, а не 403', async () => {
  const h = await harness();
  const response = await h.app.inject({ method: 'GET', url: '/server-settings' });
  assert.equal(response.statusCode, 401);
});

/* ------------------------------------------------------------------ */
/* 3. Изменение, возврат и след в журнале                               */
/* ------------------------------------------------------------------ */

void test('изменение сохраняется, а в журнал уходит старое и новое значение', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'PUT',
    url: '/server-settings/MAIL_FLOW_RETENTION_DAYS',
    headers: { cookie: h.cookie },
    payload: { value: 30 },
  });
  assert.equal(response.statusCode, 200);
  const dto = response.json<SettingDto>();
  assert.equal(dto.value, 30);
  assert.equal(dto.source, 'db');
  assert.equal(h.db.rows[0]?.value, '30');

  assert.equal(h.db.audits.length, 1);
  const record = h.db.audits[0] as {
    action: string;
    targetType: string;
    targetLabel: string;
    oldValue: Record<string, unknown> | null;
    newValue: Record<string, unknown> | null;
  };
  assert.equal(record.action, 'serversettings.update');
  assert.equal(record.targetType, 'serversettings');
  assert.equal(record.targetLabel, 'MAIL_FLOW_RETENTION_DAYS');
  assert.equal(record.oldValue?.value, '14');
  assert.equal(record.newValue?.value, '30');
});

void test('негодное значение отклоняется с внятным отказом и ничего не пишет', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'PUT',
    url: '/server-settings/ADMIN_LOGIN_MAX_FAILURES',
    headers: { cookie: h.cookie },
    payload: { value: 0 },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json<{ message: string }>().message, /минимум 1/u);
  assert.equal(h.db.rows.length, 0);
  assert.equal(h.db.audits.length, 0);
});

void test('возврат к умолчанию убирает запись и пишет своё действие в журнал', async () => {
  const h = await harness();
  await h.app.inject({
    method: 'PUT',
    url: '/server-settings/MAIL_FLOW_RETENTION_DAYS',
    headers: { cookie: h.cookie },
    payload: { value: 30 },
  });
  const response = await h.app.inject({
    method: 'DELETE',
    url: '/server-settings/MAIL_FLOW_RETENTION_DAYS',
    headers: { cookie: h.cookie },
  });
  assert.equal(response.statusCode, 200);
  const dto = response.json<SettingDto>();
  assert.equal(dto.value, 14);
  assert.equal(dto.source, 'env');
  assert.equal(h.db.rows.length, 0);
  assert.equal(h.db.audits.at(-1)?.action, 'serversettings.reset');
});

void test('сохранение нескольких настроек разом даёт запись на каждую изменившуюся', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'POST',
    url: '/server-settings/bulk',
    headers: { cookie: h.cookie },
    payload: {
      values: {
        MAIL_FLOW_RETENTION_DAYS: 30,
        ADMIN_DEFAULT_QUOTA_BYTES: 5368709120,
        // Значение то же, что действует, — записи о нём быть не должно.
        ADMIN_LOGIN_MAX_FAILURES: 5,
      },
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json<ListDto & { changed: number }>();
  assert.equal(body.changed, 2);
  assert.equal(h.db.audits.length, 2);
  assert.deepEqual(h.db.audits.map((a) => a.targetLabel).sort(), [
    'ADMIN_DEFAULT_QUOTA_BYTES',
    'MAIL_FLOW_RETENTION_DAYS',
  ]);
});

/* ------------------------------------------------------------------ */
/* 4. Признаки для интерфейса                                           */
/* ------------------------------------------------------------------ */

void test('каждая настройка приходит с описанием, источником и пределами', async () => {
  const h = await harness();
  const body = (
    await h.app.inject({ method: 'GET', url: '/server-settings', headers: { cookie: h.cookie } })
  ).json<ListDto>();
  const items = allSettings(body);
  assert.ok(items.length > 50, `настроек в ответе: ${items.length}`);

  for (const item of items) {
    assert.ok(item.description.length > 10, `${item.key} без описания`);
    assert.ok(['db', 'env', 'default'].includes(item.source), `${item.key}: источник неизвестен`);
    if (item.group === 'locked') assert.ok(item.reason, `${item.key} без причины запрета`);
  }

  const quota = items.find((i) => i.key === 'ADMIN_DEFAULT_QUOTA_BYTES')!;
  assert.equal(quota.group, 'live');
  assert.equal(quota.requiresRestart, false);
  assert.equal(quota.source, 'env');
  assert.equal(quota.value, 1073741824);
  assert.equal(quota.min, 0);
});

void test('после изменения настройки группы restart панель узнаёт, что нужен перезапуск', async () => {
  const h = await harness();
  await h.app.inject({
    method: 'PUT',
    url: '/server-settings/PUSH_TIMEOUT_MS',
    headers: { cookie: h.cookie },
    payload: { value: 20000 },
  });
  const body = (
    await h.app.inject({ method: 'GET', url: '/server-settings', headers: { cookie: h.cookie } })
  ).json<ListDto>();
  const items = allSettings(body);

  const push = items.find((i) => i.key === 'PUSH_TIMEOUT_MS')!;
  assert.equal(push.requiresRestart, true);
  assert.equal(push.pendingRestart, true, 'значение сохранено, но живой процесс о нём не знает');
  assert.equal(body.counts.pendingRestart, 1);

  // У настройки, которую не трогали, ожидания перезапуска быть не должно.
  const другая = items.find((i) => i.key === 'PUSH_TTL_SECONDS')!;
  assert.equal(другая.pendingRestart, false);
});

void test('настройка группы live перезапуска не требует никогда', async () => {
  const h = await harness();
  await h.app.inject({
    method: 'PUT',
    url: '/server-settings/ADMIN_DEFAULT_QUOTA_BYTES',
    headers: { cookie: h.cookie },
    payload: { value: 2147483648 },
  });
  const body = (
    await h.app.inject({ method: 'GET', url: '/server-settings', headers: { cookie: h.cookie } })
  ).json<ListDto>();
  const quota = allSettings(body).find((i) => i.key === 'ADMIN_DEFAULT_QUOTA_BYTES')!;
  assert.equal(quota.value, 2147483648);
  assert.equal(quota.source, 'db');
  assert.equal(quota.requiresRestart, false);
  assert.equal(quota.pendingRestart, false);
});

/*
 * СБРОС НАСТРОЙКИ ГРУППЫ restart НЕ ГАСИТ «ЖДЁТ ПЕРЕЗАПУСКА».
 *
 * Значение этой группы прочитано один раз при старте, и сброс не может
 * отменить прочитанного: до перезапуска контейнера сервер продолжает
 * работать со сброшенным значением. Признак считался по текущему
 * окружению, а сброс из этого окружения значение и вынимал, — панель
 * показывала «умолчание, перезапуск не нужен» о процессе, который живёт
 * с прежним. Проверяем через маршрут: именно этот ответ читает панель.
 */
void test('после сброса настройки группы restart панель всё ещё просит перезапуск', async () => {
  const h = await harness();
  await h.app.inject({
    method: 'PUT',
    url: '/server-settings/PUSH_TIMEOUT_MS',
    headers: { cookie: h.cookie },
    payload: { value: 20000 },
  });
  // Перезапуск: сохранённые значения подмешиваются в окружение при старте.
  applyRowsToEnv([{ key: 'PUSH_TIMEOUT_MS', value: '20000' }], h.env);

  const applied = allSettings(
    (
      await h.app.inject({ method: 'GET', url: '/server-settings', headers: { cookie: h.cookie } })
    ).json<ListDto>(),
  ).find((i) => i.key === 'PUSH_TIMEOUT_MS')!;
  assert.equal(applied.pendingRestart, false, 'после перезапуска ждать уже нечего');

  const reset = await h.app.inject({
    method: 'DELETE',
    url: '/server-settings/PUSH_TIMEOUT_MS',
    headers: { cookie: h.cookie },
  });
  assert.equal(reset.statusCode, 200);
  assert.equal(
    reset.json<SettingDto>().pendingRestart,
    true,
    'живой процесс до сих пор со сброшенным значением, а панель молчит',
  );

  const body = (
    await h.app.inject({ method: 'GET', url: '/server-settings', headers: { cookie: h.cookie } })
  ).json<ListDto>();
  const push = allSettings(body).find((i) => i.key === 'PUSH_TIMEOUT_MS')!;
  assert.equal(push.pendingRestart, true);
  assert.equal(body.counts.pendingRestart, 1);
});
