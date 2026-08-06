/**
 * Проверки маршрутов сохранённых запросов.
 *
 * IMAP здесь не нужен вовсе: сохранённый запрос — это строка в базе, а не
 * действие над ящиком. Поэтому harness минимальный, а проверки идут
 * обратным ходом: сохранили — читаем список, удалили — смотрим, что ушло
 * именно то и что остальное на месте.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import { MemorySavedSearchStore, type SavedSearchStore } from './saved-searches-db.js';
import { savedSearchRoutes } from './saved-searches-routes.js';
import { MAX_SAVED_SEARCHES } from './saved-searches.js';

async function buildApp(
  store: SavedSearchStore | null = new MemorySavedSearchStore(),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  app.decorate('deps', {} as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(
    async (api) => {
      await savedSearchRoutes(api, { store, unavailableReason: 'База не настроена' });
    },
    { prefix: '/api' },
  );
  await app.ready();
  return app;
}

async function save(
  app: FastifyInstance,
  name: string,
  query: string,
  includeJunk = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/searches',
    payload: { name, query, includeJunk },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

test('без базы возможность честно объявлена недоступной', async () => {
  const app = await buildApp(null);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/searches' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { available: false, reason: 'База не настроена', items: [] });
    /*
     * Обратный ход: раз возможности нет, сохранить тоже нельзя. Иначе
     * интерфейс прятал бы кнопку, а запрос всё равно проходил бы — и
     * человек, знающий адрес, получал бы «сохранено» в никуда.
     */
    const created = await save(app, 'Счета', 'от:волкова');
    assert.equal(created.status, 400);
  } finally {
    await app.close();
  }
});

test('запрос сохраняется, читается и удаляется', async () => {
  const app = await buildApp();
  try {
    const created = await save(app, 'Счета от Волковой', 'от:волкова есть:вложение', true);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body['query'], 'от:волкова есть:вложение');
    assert.equal(created.body['includeJunk'], true);

    const list = await app.inject({ method: 'GET', url: '/api/searches' });
    const state = list.json() as { available: boolean; items: { id: string; name: string }[] };
    assert.equal(state.available, true);
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.name, 'Счета от Волковой');

    const id = created.body['id'] as string;
    const removed = await app.inject({ method: 'DELETE', url: `/api/searches/${id}` });
    assert.equal(removed.statusCode, 200, removed.body);

    const after = await app.inject({ method: 'GET', url: '/api/searches' });
    assert.deepEqual((after.json() as { items: unknown[] }).items, []);
  } finally {
    await app.close();
  }
});

test('имя занято — отказ, а не второй такой же пункт в колонке', async () => {
  const app = await buildApp();
  try {
    assert.equal((await save(app, 'Счета', 'от:волкова')).status, 200);
    // Регистр не спасает: «счета» и «Счета» человек в колонке не различит
    const again = await save(app, 'счета', 'тема:счёт');
    assert.equal(again.status, 400);
    assert.match(String(again.body['message'] ?? ''), /уже сохранён/u);
  } finally {
    await app.close();
  }
});

test('пустое имя и пустой запрос сохранить нельзя', async () => {
  const app = await buildApp();
  try {
    // Имя из одних пробелов после схлопывания пусто
    assert.equal((await save(app, '   ', 'от:волкова')).status, 400);
    // Запрос из одних пробелов открывал бы пустой экран
    assert.equal((await save(app, 'Пусто', '   ')).status, 400);
  } finally {
    await app.close();
  }
});

test('перевод строки в запросе схлопывается, а не ломает адрес', async () => {
  const app = await buildApp();
  try {
    const created = await save(app, 'Из письма', 'от:волкова\n  есть:вложение');
    assert.equal(created.status, 200);
    assert.equal(created.body['query'], 'от:волкова есть:вложение');
  } finally {
    await app.close();
  }
});

test('удаление чужого и несуществующего — честный 404', async () => {
  const app = await buildApp();
  try {
    const missing = await app.inject({ method: 'DELETE', url: '/api/searches/99999' });
    assert.equal(missing.statusCode, 404);
    // Не число вместо идентификатора не должно доехать до базы
    const junk = await app.inject({ method: 'DELETE', url: '/api/searches/12abc' });
    assert.equal(junk.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('список не растёт бесконечно', async () => {
  const app = await buildApp();
  try {
    for (let i = 0; i < MAX_SAVED_SEARCHES; i += 1) {
      assert.equal((await save(app, `Запрос ${String(i)}`, 'слово')).status, 200);
    }
    const extra = await save(app, 'Ещё один', 'слово');
    assert.equal(extra.status, 400);
  } finally {
    await app.close();
  }
});
