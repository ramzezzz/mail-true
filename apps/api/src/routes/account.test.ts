/**
 * `GET /api/account` отдавал дату создания ящика `1970-01-01`: она была
 * зашита как `new Date(0)`. Проверено живьём — именно это и приходило.
 *
 * Настоящая дата есть только в базе почтового стека (`virtual_users`),
 * а база для почтового API не обязательна. Значит, ответ должен быть
 * либо настоящим, либо пустым — но не выдуманным.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import { AccountDirectory } from '../accounts/directory.js';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import { accountRoutes } from './account.js';

const EPOCH = new Date(0).toISOString();

const silentLogger = {
  warn: () => undefined,
  error: () => undefined,
  info: () => undefined,
} as unknown as Logger;

/** Справочник с заранее известным ответом — базы в тестах нет. */
function fakeDirectory(value: string | null): AccountDirectory {
  return {
    available: value !== null,
    createdAt: async () => value,
    close: async () => undefined,
  } as unknown as AccountDirectory;
}

async function buildApp(directory: AccountDirectory): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn({
        getQuota: async () => ({ storage: { usage: 1024, limit: 4096 } }),
      } as unknown as ImapFlow),
  };
  app.decorate('deps', { pool, logger: silentLogger } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(async (scope) => accountRoutes(scope, { directory }), { prefix: '/api' });
  await app.ready();
  return app;
}

test('дата создания ящика берётся из базы, а не из начала эпохи', async () => {
  const app = await buildApp(fakeDirectory('2026-03-14T09:20:00.000Z'));
  try {
    const res = await app.inject({ method: 'GET', url: '/api/account' });
    assert.equal(res.statusCode, 200);
    const account = res.json() as { createdAt: string | null; quotaUsedBytes: number };
    assert.equal(account.createdAt, '2026-03-14T09:20:00.000Z');
    assert.notEqual(account.createdAt, EPOCH);
    assert.equal(account.quotaUsedBytes, 1024);
  } finally {
    await app.close();
  }
});

test('без базы дата создания приходит пустой, а не «01.01.1970»', async () => {
  const app = await buildApp(fakeDirectory(null));
  try {
    const res = await app.inject({ method: 'GET', url: '/api/account' });
    const account = res.json() as { createdAt: string | null };
    assert.equal(account.createdAt, null);
    assert.notEqual(account.createdAt, EPOCH);
  } finally {
    await app.close();
  }
});

test('справочник без строки подключения к базе не выдумывает дату', async () => {
  const directory = new AccountDirectory({ connectionString: null, logger: silentLogger });
  assert.equal(directory.available, false);
  assert.equal(await directory.createdAt('test@mail.local'), null);
  await directory.close();
});
