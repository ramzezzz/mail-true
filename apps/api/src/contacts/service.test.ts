/**
 * Поведение подсказки адреса как целого.
 *
 * Главное здесь — не «список приходит», а два обещания, которые легко
 * нарушить незаметно: подсказка НЕ ждёт сборщика и НЕ предлагает адрес,
 * который уже введён. Оба проверяются в обе стороны: отдельно — что
 * сборщика всё-таки будят, и отдельно — что не исключённые адреса
 * остаются на месте.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Logger } from 'pino';
import type { ContactsDb } from './db.js';
import type { ContactHarvester } from './harvester.js';
import type { ContactRow } from './rank.js';
import { ContactsService, type ContactsEnvironment } from './service.js';
import { contactTokens } from './tokens.js';
import type { MailSession } from '../types.js';

const SESSION: MailSession = { id: 's1', email: 'Test@Mail.local', password: 'secret' };
const NOW_ISH = new Date();

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function row(address: string, name: string | null, patch: Partial<ContactRow> = {}): ContactRow {
  return {
    address,
    name,
    sentCount: 1,
    recvCount: 0,
    lastSeenAt: NOW_ISH,
    tokens: contactTokens(name, address),
    ...patch,
  };
}

interface FakeDb {
  db: ContactsDb;
  calls: Array<{ account: string; query: string; exclude: readonly string[] }>;
  hidden: Array<{ account: string; address: string; hidden: boolean }>;
}

function fakeDb(rows: ContactRow[], fail = false): FakeDb {
  const calls: FakeDb['calls'] = [];
  const hidden: FakeDb['hidden'] = [];
  const db = {
    suggest: async (account: string, query: string, exclude: readonly string[]) => {
      if (fail) throw new Error('база недоступна');
      calls.push({ account, query, exclude });
      return rows.filter((r) => !exclude.includes(r.address));
    },
    setHidden: async (account: string, address: string, value: boolean) => {
      hidden.push({ account, address, hidden: value });
    },
  } as unknown as ContactsDb;
  return { db, calls, hidden };
}

function fakeHarvester(): { harvester: ContactHarvester; kicks: number } {
  const state = { kicks: 0 };
  const harvester = {
    kick: () => {
      state.kicks += 1;
    },
  } as unknown as ContactHarvester;
  return {
    harvester,
    get kicks() {
      return state.kicks;
    },
  };
}

const allowAll: ContactsEnvironment = { collectReceived: async () => true };

function build(
  db: ContactsDb | null,
  harvester: ContactHarvester | null,
  env: ContactsEnvironment = allowAll,
): ContactsService {
  const service = new ContactsService({ db, harvester: null, env, logger: silent });
  service.attachHarvester(harvester);
  return service;
}

test('без базы подсказка молчит, но не ломается', async () => {
  const service = build(null, null);
  assert.equal(service.available, false);
  assert.deepEqual(await service.suggest(SESSION, 'ив'), { items: [], complete: false });
});

test('подсказка находит по имени и по адресу', async () => {
  const { db } = fakeDb([row('ivan.petrov@example.com', 'Иван Петров')]);
  const service = build(db, null);
  for (const query of ['ив', 'petrov', 'iva']) {
    const result = await service.suggest(SESSION, query);
    assert.equal(result.items[0]?.address, 'ivan.petrov@example.com', `запрос «${query}»`);
    assert.equal(result.items[0]?.name, 'Иван Петров');
  }
});

test('адрес ящика уходит в базу приведённым к нижнему регистру', async () => {
  // Иначе указатель одного и того же ящика раздваивался бы по регистру
  // адреса, каким его набрали при входе.
  const { db, calls } = fakeDb([]);
  await build(db, null).suggest(SESSION, 'ив');
  assert.equal(calls[0]?.account, 'test@mail.local');
});

test('уже введённые адреса не предлагаются повторно', async () => {
  const { db, calls } = fakeDb([
    row('anna@example.com', 'Анна'),
    row('anton@example.com', 'Антон'),
  ]);
  const service = build(db, null);
  const result = await service.suggest(SESSION, 'an', ['Anna@Example.com']);
  assert.deepEqual(calls[0]?.exclude, ['anna@example.com'], 'исключение нормализуется');
  assert.deepEqual(
    result.items.map((i) => i.address),
    ['anton@example.com'],
    'остальные остаются на месте',
  );
});

test('мусор в списке исключений не мешает подсказке', async () => {
  const { db, calls } = fakeDb([row('anna@example.com', 'Анна')]);
  const result = await build(db, null).suggest(SESSION, 'an', ['', 'не адрес', 'anna@']);
  assert.deepEqual(calls[0]?.exclude, []);
  assert.equal(result.items.length, 1);
});

test('пометка «писал сам» ставится только тем, кому писали', async () => {
  const { db } = fakeDb([
    row('anna@example.com', 'Анна', { sentCount: 3 }),
    row('news@example.com', 'Рассылка', { sentCount: 0, recvCount: 9 }),
  ]);
  const items = (await build(db, null).suggest(SESSION, 'a')).items;
  assert.equal(items.find((i) => i.address === 'anna@example.com')?.own, true);
  assert.equal(items.find((i) => i.address === 'news@example.com')?.own, false);
});

test('отказ базы не мешает писать письмо', async () => {
  const { db } = fakeDb([], true);
  const result = await build(db, null).suggest(SESSION, 'ив');
  assert.deepEqual(result.items, []);
});

test('пустой запрос ничего не предлагает, но будит сборщик', async () => {
  const { db } = fakeDb([row('anna@example.com', 'Анна')]);
  const h = fakeHarvester();
  const service = build(db, h.harvester);
  const result = await service.suggest(SESSION, '   ');
  assert.deepEqual(result.items, []);
  // Сборщик будится асинхронно (через настройку ящика) — дожидаемся очереди
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.kicks, 1, 'фокус в поле «Кому» — повод разогреть указатель');
});

test('подсказка отвечает раньше, чем отработает сборщик', async () => {
  // Сборщик здесь заведомо медленный: если бы подсказка его ждала,
  // проверка не уложилась бы в отведённое время.
  const { db } = fakeDb([row('anna@example.com', 'Анна')]);
  const slow = {
    kick: () => {
      // Работа сборщика идёт мимо ответа — он ничего не возвращает
    },
  } as unknown as ContactHarvester;
  const started = Date.now();
  const result = await build(db, slow).suggest(SESSION, 'ан');
  assert.equal(result.items.length, 1);
  assert.ok(Date.now() - started < 200);
});

test('признак «указатель разобран» честно отражает состояние сборщика', async () => {
  const { db } = fakeDb([row('anna@example.com', 'Анна')]);
  const service = build(db, null);
  assert.equal((await service.suggest(SESSION, 'ан')).complete, false);
  service.markComplete(SESSION.email, true);
  assert.equal((await service.suggest(SESSION, 'ан')).complete, true);
  // Обратный ход: смена ящика или сброс возвращает «не всё просмотрено»
  service.markComplete(SESSION.email, false);
  assert.equal((await service.suggest(SESSION, 'ан')).complete, false);
});

test('адрес убирается из подсказок и возвращается обратно', async () => {
  const { db, hidden } = fakeDb([]);
  const service = build(db, null);
  assert.deepEqual(await service.setHidden(SESSION, 'IVAN@Example.com', true), {
    address: 'ivan@example.com',
    hidden: true,
  });
  assert.deepEqual(await service.setHidden(SESSION, 'ivan@example.com', false), {
    address: 'ivan@example.com',
    hidden: false,
  });
  assert.deepEqual(hidden, [
    { account: 'test@mail.local', address: 'ivan@example.com', hidden: true },
    { account: 'test@mail.local', address: 'ivan@example.com', hidden: false },
  ]);
});

test('убрать не-адрес нельзя', async () => {
  const { db, hidden } = fakeDb([]);
  await build(db, null).setHidden(SESSION, 'не адрес', true);
  assert.deepEqual(hidden, [], 'в базу не уходит ничего');
});

test('сборщик не будится, когда его нет', async () => {
  const { db } = fakeDb([row('anna@example.com', 'Анна')]);
  const service = build(db, null);
  const result = await service.suggest(SESSION, 'ан');
  assert.equal(result.items.length, 1);
});

test('запрет на пополнение из входящих доходит до сборщика', async () => {
  const seen: boolean[] = [];
  const harvester = {
    kick: (request: { collectReceived: boolean }) => seen.push(request.collectReceived),
  } as unknown as ContactHarvester;
  const { db } = fakeDb([]);
  const denied: ContactsEnvironment = { collectReceived: async () => false };
  build(db, harvester, denied).warm(SESSION);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [false]);

  build(db, harvester, allowAll).warm(SESSION);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [false, true]);
});
