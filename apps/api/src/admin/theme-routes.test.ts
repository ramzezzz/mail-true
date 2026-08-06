/**
 * Тема оформления панели хранится за учётной записью администратора.
 *
 * Проверяется поведение маршрутов: откуда берётся id (из сессии, а не из
 * тела запроса), что отдаётся в ответе о сессии и что происходит с базой,
 * где миграция 0009 ещё не применена.
 *
 * На прежнем коде падает всё: маршрута /auth/theme не было, в ответе о
 * сессии поля theme не было, выбор жил только в localStorage браузера.
 *
 * Настоящая база не нужна: подделка запоминает вызовы, а проверяется
 * поведение маршрута. Сам SQL проверяется на живой базе отдельно.
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { BrandingStore } from './branding.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { createImportBox } from './import-jobs.js';
import { QueueAgent } from './queue-agent.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminAuthRoutes } from './routes/auth.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

/** Подделка базы: помнит темы администраторов и все обращения к ним. */
class FakeDb {
  themes = new Map<number, string | null>();
  writes: Array<{ id: number; theme: string | null }> = [];
  /** Столбца theme нет — база без миграции 0009. */
  columnMissing = false;

  async findAdminById(id: number): Promise<Record<string, unknown>> {
    return { id, login: 'petrov', role: 'owner', active: true, display_name: null };
  }

  async getAdminTheme(id: number): Promise<string | null> {
    // Настоящая реализация проглатывает 42703 и отдаёт null — панель
    // при этом работает с темой по умолчанию, а не падает
    if (this.columnMissing) return null;
    return this.themes.get(id) ?? null;
  }

  async setAdminTheme(id: number, theme: string | null): Promise<void> {
    this.writes.push({ id, theme });
    this.themes.set(id, theme);
  }

  async writeAudit(): Promise<void> {
    throw new Error('цвет интерфейса в журнале аудита не место');
  }
}

interface Harness {
  app: FastifyInstance;
  db: FakeDb;
  cookie: string;
  /** Cookie второго администратора — за тем же компьютером. */
  otherCookie: string;
}

async function harness(): Promise<Harness> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const db = new FakeDb();
  const sessions = new MemoryAdminSessionStore();
  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    ADMIN_MAIL_ROOT: tmpdir(),
    SESSION_SECRET: SECRET,
  } as NodeJS.ProcessEnv);

  const ctx: AdminContext = {
    config,
    db: db as unknown as AdminDb,
    sessions,
    mailbox: {
      configured: true,
      verify: async (): Promise<void> => undefined,
      purgeMail: async () => ({ ok: true, foldersDeleted: 0, error: null }),
    } as unknown as AdminContext['mailbox'],
    queueAgent: new QueueAgent({ baseUrl: '', token: '', logger }),
    branding: new BrandingStore(path.join(tmpdir(), 'mailtrue-admin-theme-branding')),
    cookieSecure: false,
    importBox: createImportBox(SECRET),
  };

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  app.decorateRequest('mailSession', null);
  await adminAuthRoutes(app);

  await sessions.set(
    'sess-petrov',
    { adminId: 1, login: 'petrov', role: 'owner', createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  await sessions.set(
    'sess-sidorov',
    { adminId: 2, login: 'sidorov', role: 'owner', createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  const name = config.ADMIN_SESSION_COOKIE_NAME;
  return {
    app,
    db,
    cookie: `${name}=${app.signCookie('sess-petrov')}`,
    otherCookie: `${name}=${app.signCookie('sess-sidorov')}`,
  };
}

void test('ответ о сессии несёт тему этого администратора', async () => {
  const h = await harness();
  h.db.themes.set(1, 'emerald');
  h.db.themes.set(2, 'sunset');

  const mine = await h.app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie: h.cookie },
  });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().theme, 'emerald');

  // Тот же компьютер, другая учётная запись — другая тема
  const other = await h.app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie: h.otherCookie },
  });
  assert.equal(other.json().theme, 'sunset');
});

void test('администратор без выбора получает пустое поле, а не чужую тему', async () => {
  const h = await harness();
  h.db.themes.set(1, 'coral');
  const res = await h.app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie: h.otherCookie },
  });
  assert.equal(res.json().theme, null);
});

void test('смена темы пишется в учётную запись из СЕССИИ, а не из тела запроса', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'PUT',
    url: '/auth/theme',
    headers: { cookie: h.cookie },
    // Подсовываем чужой id — сервер обязан его не заметить
    payload: { theme: 'violet', adminId: 2, login: 'sidorov' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.db.writes, [{ id: 1, theme: 'violet' }]);
  assert.equal(h.db.themes.get(2), undefined);
});

void test('без сессии тему не сменить', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'PUT',
    url: '/auth/theme',
    payload: { theme: 'coral' },
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(h.db.writes, []);
});

void test('null возвращает администратора к теме по умолчанию', async () => {
  const h = await harness();
  h.db.themes.set(1, 'coral');
  const res = await h.app.inject({
    method: 'PUT',
    url: '/auth/theme',
    headers: { cookie: h.cookie },
    payload: { theme: null },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(h.db.themes.get(1), null);
});

void test('в поле темы не пролезет что попало', async () => {
  const h = await harness();
  for (const theme of ['<script>', 'ТЁМНАЯ', 'a'.repeat(64), 'DROP TABLE', 42, {}]) {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/auth/theme',
      headers: { cookie: h.cookie },
      payload: { theme },
    });
    assert.equal(res.statusCode, 400, `значение ${JSON.stringify(theme)} приняли`);
  }
  assert.deepEqual(h.db.writes, []);
});

void test('«как в системе» — такой же законный выбор, как имя темы', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'PUT',
    url: '/auth/theme',
    headers: { cookie: h.cookie },
    payload: { theme: 'system' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(h.db.themes.get(1), 'system');
});

void test('база без миграции 0009 не мешает войти в панель', async () => {
  const h = await harness();
  h.db.columnMissing = true;
  const res = await h.app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie: h.cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().theme, null);
  assert.equal(res.json().login, 'petrov');
});

void test('смена цвета не засоряет журнал аудита', async () => {
  // Подделка бросает исключение на writeAudit: в журнале перечислены
  // изменения, за которые администратор отвечает перед другими, а цвет
  // интерфейса не меняет ничего ни для кого, кроме автора.
  const h = await harness();
  const res = await h.app.inject({
    method: 'PUT',
    url: '/auth/theme',
    headers: { cookie: h.cookie },
    payload: { theme: 'lagoon' },
  });
  assert.equal(res.statusCode, 200);
});
