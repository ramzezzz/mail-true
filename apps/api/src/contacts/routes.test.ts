/**
 * Маршруты подсказки адреса: что приходит с запросом и что уходит в ответ.
 *
 * Проверяется в обе стороны главное свойство раздела — указатель привязан
 * к ящику. Не «проверка отказывает чужому», а «чужой адрес указать негде»:
 * маршрут берёт владельца из сессии, и в теле запроса такого поля нет
 * вовсе. Проверка «без сессии — 401» без проверки «с сессией берётся
 * ИМЕННО её адрес» пропустила бы реализацию, читающую адрес из тела.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ContactsDb } from './db.js';
import { ContactsService } from './service.js';
import { contactsRoutes } from './routes.js';
import { contactTokens } from './tokens.js';
import type { ContactRow } from './rank.js';
import type { MailSession } from '../types.js';

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

interface Seen {
  account: string;
  query: string;
  exclude: readonly string[];
}

function buildApp(options: { session: MailSession | null; rows?: ContactRow[] }): {
  app: FastifyInstance;
  seen: Seen[];
  hidden: Array<{ account: string; address: string; hidden: boolean }>;
} {
  const seen: Seen[] = [];
  const hidden: Array<{ account: string; address: string; hidden: boolean }> = [];
  const db = {
    suggest: async (account: string, query: string, exclude: readonly string[]) => {
      seen.push({ account, query, exclude });
      return options.rows ?? [];
    },
    setHidden: async (account: string, address: string, value: boolean) => {
      hidden.push({ account, address, hidden: value });
    },
  } as unknown as ContactsDb;

  const service = new ContactsService({
    db,
    harvester: null,
    env: { collectReceived: async () => true },
    logger: silent,
  });

  const app = Fastify() as unknown as FastifyInstance;
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request: { mailSession: MailSession | null }) {
    if (!options.session) {
      const error = new Error('Требуется вход в систему') as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
    request.mailSession = options.session;
  });
  void app.register(async (scope) => contactsRoutes(scope, service), { prefix: '/api/contacts' });
  return { app, seen, hidden };
}

const SESSION: MailSession = { id: 's', email: 'Test@Mail.local', password: 'x' };

function row(address: string, name: string | null, sentCount = 1): ContactRow {
  return {
    address,
    name,
    sentCount,
    recvCount: 0,
    lastSeenAt: new Date(),
    tokens: contactTokens(name, address),
  };
}

test('без сессии подсказки нет', async () => {
  const { app } = buildApp({ session: null });
  const response = await app.inject({ method: 'GET', url: '/api/contacts/suggest?q=ив' });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('владелец берётся из сессии, а не из запроса', async () => {
  const { app, seen } = buildApp({ session: SESSION, rows: [row('ivan@example.com', 'Иван')] });
  // Пытаемся подсунуть чужой ящик всеми способами, какие есть у клиента
  const response = await app.inject({
    method: 'GET',
    url: '/api/contacts/suggest?q=ив&account=victim@mail.local&accountEmail=victim@mail.local',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(seen[0]?.account, 'test@mail.local');
  await app.close();
});

test('подсказка отдаёт адрес, имя и пометку «писал сам»', async () => {
  const { app } = buildApp({
    session: SESSION,
    rows: [row('ivan@example.com', 'Иван', 2), row('igor@example.com', null, 0)],
  });
  const response = await app.inject({ method: 'GET', url: '/api/contacts/suggest?q=и' });
  const body = response.json() as {
    items: Array<{ address: string; name: string | null; own: boolean }>;
  };
  assert.equal(body.items.length, 2);
  assert.equal(body.items.find((i) => i.address === 'ivan@example.com')?.own, true);
  assert.equal(body.items.find((i) => i.address === 'igor@example.com')?.own, false);
  await app.close();
});

test('уже введённые адреса приходят списком и доходят до запроса', async () => {
  const { app, seen } = buildApp({ session: SESSION });
  await app.inject({
    method: 'GET',
    url: '/api/contacts/suggest?q=ан&exclude=Anna%40example.com%2C%20boris%40example.com',
  });
  assert.deepEqual(seen[0]?.exclude, ['anna@example.com', 'boris@example.com']);
  // Обратный ход: без параметра список пуст, а не «весь указатель»
  await app.inject({ method: 'GET', url: '/api/contacts/suggest?q=ан' });
  assert.deepEqual(seen[1]?.exclude, []);
  await app.close();
});

test('пустой запрос базу не тревожит', async () => {
  const { app, seen } = buildApp({ session: SESSION });
  const response = await app.inject({ method: 'GET', url: '/api/contacts/suggest?q=' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { items: [], complete: false });
  assert.deepEqual(seen, []);
  await app.close();
});

test('адрес убирается из подсказок и возвращается обратно', async () => {
  const { app, hidden } = buildApp({ session: SESSION });
  const hide = await app.inject({
    method: 'POST',
    url: '/api/contacts/hide',
    payload: { address: 'IVAN@Example.com' },
  });
  assert.equal(hide.statusCode, 200);
  assert.deepEqual(hide.json(), { address: 'ivan@example.com', hidden: true });

  const restore = await app.inject({
    method: 'POST',
    url: '/api/contacts/restore',
    payload: { address: 'ivan@example.com' },
  });
  assert.deepEqual(restore.json(), { address: 'ivan@example.com', hidden: false });

  assert.deepEqual(hidden, [
    { account: 'test@mail.local', address: 'ivan@example.com', hidden: true },
    { account: 'test@mail.local', address: 'ivan@example.com', hidden: false },
  ]);
  await app.close();
});

test('убрать адрес из чужих подсказок нечем', async () => {
  const { app, hidden } = buildApp({ session: SESSION });
  await app.inject({
    method: 'POST',
    url: '/api/contacts/hide',
    // Поля «чей ящик» в схеме нет — лишнее просто игнорируется
    payload: { address: 'ivan@example.com', account: 'victim@mail.local' },
  });
  assert.equal(hidden[0]?.account, 'test@mail.local');
  await app.close();
});

test('убрать не-адрес нельзя', async () => {
  const { app, hidden } = buildApp({ session: SESSION });
  const response = await app.inject({
    method: 'POST',
    url: '/api/contacts/hide',
    payload: { address: 'не адрес' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(hidden, [], 'в базу не уходит ничего');
  await app.close();
});
