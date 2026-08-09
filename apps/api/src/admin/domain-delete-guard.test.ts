/**
 * Основной домен сервера удалить нельзя.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Удаление проверяло только счётчики ящиков и алиасов, а MAIL_DOMAIN не
 * сверялся нигде. На свежей установке домен ещё пуст — значит два
 * щелчка, и он удалён. После этого Postfix перестаёт принимать почту
 * для него, настройки DKIM уходят каскадом, а сервер продолжает
 * представляться этим именем в HELO и подписывать им письма.
 *
 * Собрать обратно можно только повторным заведением домена и выпуском
 * нового ключа с публикацией записи в DNS — цена случайного нажатия
 * несоизмерима с «домен пустой, что тут терять».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { adminDomainRoutes } from './routes/domains.js';
import { ServerSettings } from './server-settings.js';
import { MemoryAdminSessionStore } from './session.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

interface Rig {
  app: FastifyInstance;
  cookie: string;
  /** Какие домены успели удалить. */
  deleted: () => number[];
}

/** Домены сервера: основной и второй, оба пустые. */
const DOMAINS = [
  { id: 1, name: 'staraya.ru', user_count: '0', alias_count: '0' },
  { id: 2, name: 'filial.ru', user_count: '0', alias_count: '0' },
];

async function harness(): Promise<Rig> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const deleted: number[] = [];
  const db = {
    findAdminById: async (id: number) => ({ id, login: 'osmotr', role: 'owner', active: true }),
    writeAudit: async () => undefined,
    findDomainById: async (id: number) => DOMAINS.find((d) => d.id === id) ?? null,
    deleteDomain: async (id: number) => {
      deleted.push(id);
      return true;
    },
    listDomainAliases: async () => [],
    query: async () => [],
  } as unknown as AdminDb;

  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: SECRET,
    MAIL_DOMAIN: 'staraya.ru',
    MAIL_HOSTNAME: 'mail.staraya.ru',
  } as unknown as NodeJS.ProcessEnv);

  const ctx = {
    config,
    db,
    sessions: new MemoryAdminSessionStore(),
    serverSettings: new ServerSettings({
      db: null,
      env: { MAIL_DOMAIN: 'staraya.ru' } as NodeJS.ProcessEnv,
      cacheMs: 0,
    }),
    serviceAgent: null,
  } as unknown as AdminContext;

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  await adminDomainRoutes(app);

  const sessionId = 'test-session';
  await ctx.sessions.set(
    sessionId,
    { adminId: 1, login: 'osmotr', role: 'owner', createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  await app.ready();

  return {
    app,
    cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${app.signCookie(sessionId)}`,
    deleted: () => deleted,
  };
}

test('основной домен сервера удалить нельзя, даже если он пуст', async () => {
  const rig = await harness();
  try {
    const res = await rig.app.inject({
      method: 'DELETE',
      url: '/domains/1',
      headers: { cookie: rig.cookie },
    });
    assert.notEqual(res.statusCode, 200, 'основной домен удалён без единого вопроса');
    assert.match(res.body, /основной домен/iu, 'человеку не сказано, чем этот домен особенный');
    assert.deepEqual(rig.deleted(), [], 'до удаления всё-таки дошло');
  } finally {
    await rig.app.close();
  }
});

test('отказ подсказывает верный путь — раздел смены домена', async () => {
  const rig = await harness();
  try {
    const res = await rig.app.inject({
      method: 'DELETE',
      url: '/domains/1',
      headers: { cookie: rig.cookie },
    });
    assert.match(res.body, /смен/iu, 'не сказано, что делать, если домен всё-таки меняется');
  } finally {
    await rig.app.close();
  }
});

test('обычный домен удаляется по-прежнему', async () => {
  // Обратная сторона: защита не должна мешать убрать лишний домен.
  const rig = await harness();
  try {
    const res = await rig.app.inject({
      method: 'DELETE',
      url: '/domains/2',
      headers: { cookie: rig.cookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(rig.deleted(), [2]);
  } finally {
    await rig.app.close();
  }
});

test('обход через force не работает: он не про это правило', async () => {
  const rig = await harness();
  try {
    const res = await rig.app.inject({
      method: 'DELETE',
      url: '/domains/1?force=true',
      headers: { cookie: rig.cookie },
    });
    assert.notEqual(res.statusCode, 200, 'force снёс основной домен');
    assert.deepEqual(rig.deleted(), []);
  } finally {
    await rig.app.close();
  }
});
