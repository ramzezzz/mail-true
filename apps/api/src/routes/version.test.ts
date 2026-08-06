/**
 * Версия сервера приложения (`GET /api/version`).
 *
 * На старом коде маршрута не было вовсе: живой стенд отвечал на него 404
 * (проверено curl-ом), и нижней строке состояния в почте показывать было
 * нечего. Здесь проверяется главное: версия НАСТОЯЩАЯ (та же, что
 * в манифесте), маршрут закрыт сессией, а неизвестная версия приходит
 * пустой, а не выдуманной.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from '../http-errors.js';
import { parseVersion, readOwnVersion, versionRoutes } from './version.js';

/** Версия из манифеста — то, с чем ответ обязан совпасть. */
const manifestVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

async function buildApp(authorized: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request, reply) {
    if (!authorized) {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
      return;
    }
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(async (scope) => versionRoutes(scope), { prefix: '/api' });
  await app.ready();
  return app;
}

test('версия приходит из манифеста, а не из константы в коде', async () => {
  const app = await buildApp(true);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { version: string | null };
    assert.equal(body.version, manifestVersion);
    // Версия непустая и похожа на версию, а не на «неизвестно»
    assert.match(String(body.version), /^\d+\.\d+\.\d+/u);
  } finally {
    await app.close();
  }
});

test('без сессии версию сервера не показываем', async () => {
  const app = await buildApp(false);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('нечитаемый манифест даёт пустую версию, а не выдуманную', () => {
  // Настоящий манифест читается — значение есть
  assert.equal(readOwnVersion(), manifestVersion);
  // Ни один из способов «не прочитать» не порождает подставной версии:
  // поддержка приняла бы «0.0.0» за настоящую и искала бы не тот образ.
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion('не json'), null);
  assert.equal(parseVersion('{}'), null);
  assert.equal(parseVersion('{"version":""}'), null);
  assert.equal(parseVersion('{"version":42}'), null);
});
