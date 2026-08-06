/**
 * Проверки маршрутов своих меток на подставном IMAP-клиенте.
 *
 * Заглушка держит НАСТОЯЩЕЕ состояние ключевых слов каждого письма, а не
 * журнал вызовов: почти каждая проверка здесь идёт обратным ходом —
 * поставили метку и смотрим, что лежит в письме; сняли — смотрим, что
 * пропало И что осталось. Журнала вызовов для этого не хватило бы: он
 * доказывает, что команду послали, а не что ящик после неё выглядит верно.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import { MemoryLabelStore } from './labels-db.js';
import { labelRoutes } from './labels-routes.js';

interface FolderSpec {
  path: string;
  specialUse?: string;
  uids: number[];
}

/** Разворачивает набор номеров IMAP вида `1:100,105` в список. */
function expandSet(set: string): number[] {
  const out: number[] = [];
  for (const part of set.split(',')) {
    const [from, to] = part.split(':');
    const start = Number(from);
    const end = to === undefined ? start : Number(to);
    for (let uid = start; uid <= end; uid += 1) out.push(uid);
  }
  return out;
}

/**
 * Подставной IMAP-клиент с настоящими ключевыми словами писем.
 * Ключ хранилища — `<путь папки>:<uid>`, значение — набор слов письма.
 */
class FakeClient {
  readonly boxes = new Map<string, Set<number>>();
  readonly keywords = new Map<string, Set<string>>();
  private selected = 'INBOX';
  readonly capabilities = new Set<string>();

  constructor(private readonly specs: FolderSpec[]) {
    for (const spec of specs) this.boxes.set(spec.path, new Set(spec.uids));
  }

  /** Ключевые слова письма — то, ради чего вся заглушка. */
  flagsOf(path: string, uid: number): Set<string> {
    const key = `${path}:${String(uid)}`;
    const found = this.keywords.get(key);
    if (found) return found;
    const created = new Set<string>();
    this.keywords.set(key, created);
    return created;
  }

  async list(): Promise<unknown[]> {
    return this.specs.map((spec) => ({
      path: spec.path,
      name: spec.path,
      delimiter: '/',
      parentPath: '',
      specialUse: spec.specialUse,
      flags: new Set<string>(),
      status: { messages: this.boxes.get(spec.path)?.size ?? 0, unseen: 0, uidValidity: 1n },
    }));
  }

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    this.selected = path;
    return { release: () => undefined };
  }

  async noop(): Promise<void> {}

  async search(query: { uid?: string; all?: boolean; keyword?: string }): Promise<number[]> {
    const present = this.boxes.get(this.selected) ?? new Set<number>();
    if (typeof query.keyword === 'string') {
      const wanted = query.keyword;
      return [...present].filter((uid) => this.flagsOf(this.selected, uid).has(wanted));
    }
    if (typeof query.uid === 'string') {
      return expandSet(query.uid).filter((uid) => present.has(uid));
    }
    return [...present];
  }

  async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
    for (const uid of uids) for (const flag of flags) this.flagsOf(this.selected, uid).add(flag);
    return true;
  }

  async messageFlagsRemove(uids: number[], flags: string[]): Promise<boolean> {
    for (const uid of uids) for (const flag of flags) this.flagsOf(this.selected, uid).delete(flag);
    return true;
  }
}

interface Harness {
  app: FastifyInstance;
  client: FakeClient;
  store: MemoryLabelStore;
}

async function buildHarness(
  store: MemoryLabelStore | null = new MemoryLabelStore(),
): Promise<Harness> {
  const client = new FakeClient([
    { path: 'INBOX', specialUse: '\\Inbox', uids: [1, 2, 3] },
    { path: 'Archive', specialUse: '\\Archive', uids: [10, 11] },
  ]);
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  app.decorate('deps', { pool } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(
    async (api) => {
      await labelRoutes(api, { store, unavailableReason: 'База не настроена' });
    },
    { prefix: '/api' },
  );
  await app.ready();
  return { app, client, store: store ?? new MemoryLabelStore() };
}

/** Заводит метку через маршрут и отдаёт её ключ. */
async function createLabel(app: FastifyInstance, name: string, color = 'red'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/labels', payload: { name, color } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().key as string;
}

/* ------------------------------------------------------------------ */
/* Справочник                                                          */
/* ------------------------------------------------------------------ */

test('без базы возможность честно объявлена недоступной', async () => {
  const { app } = await buildHarness(null);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/labels' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      available: false,
      reason: 'База не настроена',
      items: [],
    });
    // Обратный ход: раз возможности нет, завести метку тоже нельзя —
    // иначе интерфейс прятал бы раздел, а запрос всё равно проходил.
    const created = await app.inject({
      method: 'POST',
      url: '/api/labels',
      payload: { name: 'Оплатить' },
    });
    assert.equal(created.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('метка заводится, читается и переименовывается без смены ключа', async () => {
  const { app } = await buildHarness();
  try {
    const key = await createLabel(app, 'Оплатить', 'red');
    assert.equal(key, 'mt-oplatit');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/labels/${key}`,
      payload: { name: 'Счета', color: 'green' },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    // Ключ лежит в письмах — переименование не имеет права его менять
    assert.equal(patched.json().key, key);
    assert.equal(patched.json().name, 'Счета');
    assert.equal(patched.json().color, 'green');

    const list = await app.inject({ method: 'GET', url: '/api/labels' });
    assert.deepEqual(list.json().items, [
      { key: 'mt-oplatit', name: 'Счета', color: 'green', position: 0 },
    ]);
  } finally {
    await app.close();
  }
});

test('меткой нельзя назваться служебным словом продукта', async () => {
  const { app } = await buildHarness();
  try {
    for (const name of ['reliable', 'finance', '$Snoozed', '$MDNSent']) {
      const res = await app.inject({ method: 'POST', url: '/api/labels', payload: { name } });
      assert.equal(res.statusCode, 400, `${name} прошло: ${res.body}`);
    }
    // Обратный ход: справочник остался пустым
    const list = await app.inject({ method: 'GET', url: '/api/labels' });
    assert.deepEqual(list.json().items, []);
  } finally {
    await app.close();
  }
});

test('две метки с одним именем не заводятся', async () => {
  const { app } = await buildHarness();
  try {
    await createLabel(app, 'Оплатить');
    const again = await app.inject({
      method: 'POST',
      url: '/api/labels',
      payload: { name: 'оплатить' },
    });
    assert.equal(again.statusCode, 400, again.body);
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------------------ */
/* Простановка и снятие                                                */
/* ------------------------------------------------------------------ */

test('метка ставится и снимается, не трогая остальных ключевых слов', async () => {
  const { app, client } = await buildHarness();
  try {
    const key = await createLabel(app, 'Оплатить');
    // Письмо уже несёт служебные слова: пометку возврата из «Отложенных»,
    // чип категории и отправленное уведомление о прочтении.
    for (const word of ['$Snoozed', '$Pinned', '$MDNSent', 'finance', 'reliable']) {
      client.flagsOf('INBOX', 1).add(word);
    }

    const set = await app.inject({
      method: 'POST',
      url: '/api/messages/labels',
      payload: { ids: ['inbox:1', 'inbox:2'], add: [key] },
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().updated, 2);
    assert.ok(client.flagsOf('INBOX', 1).has(key));
    assert.ok(client.flagsOf('INBOX', 2).has(key));

    // Обратный ход: снимаем — метка ушла, служебные слова на месте
    const unset = await app.inject({
      method: 'POST',
      url: '/api/messages/labels',
      payload: { ids: ['inbox:1'], remove: [key] },
    });
    assert.equal(unset.statusCode, 200, unset.body);
    assert.equal(client.flagsOf('INBOX', 1).has(key), false);
    assert.deepEqual([...client.flagsOf('INBOX', 1)].sort(), [
      '$MDNSent',
      '$Pinned',
      '$Snoozed',
      'finance',
      'reliable',
    ]);
    // А со второго письма метку не снимали — она осталась
    assert.ok(client.flagsOf('INBOX', 2).has(key));
  } finally {
    await app.close();
  }
});

/**
 * Главная проверка всей возможности: служебное слово не проходит
 * ни в «поставить», ни в «снять».
 */
test('служебное ключевое слово нельзя ни поставить, ни снять', async () => {
  const { app, client } = await buildHarness();
  try {
    client.flagsOf('INBOX', 1).add('$Snoozed');
    client.flagsOf('INBOX', 1).add('$MDNSent');

    for (const word of ['$Snoozed', '$MDNSent', 'reliable', 'finance', '\\Deleted']) {
      const add = await app.inject({
        method: 'POST',
        url: '/api/messages/labels',
        payload: { ids: ['inbox:1'], add: [word] },
      });
      assert.equal(add.statusCode, 400, `поставили ${word}: ${add.body}`);

      const remove = await app.inject({
        method: 'POST',
        url: '/api/messages/labels',
        payload: { ids: ['inbox:1'], remove: [word] },
      });
      assert.equal(remove.statusCode, 400, `сняли ${word}: ${remove.body}`);
    }

    // Обратный ход: письмо не изменилось ни на одно слово
    assert.deepEqual([...client.flagsOf('INBOX', 1)].sort(), ['$MDNSent', '$Snoozed']);
  } finally {
    await app.close();
  }
});

test('метки, которой нет в справочнике, поставить нельзя', async () => {
  const { app, client } = await buildHarness();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/labels',
      payload: { ids: ['inbox:1'], add: ['mt-vydumannaya'] },
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(client.flagsOf('INBOX', 1).size, 0);
  } finally {
    await app.close();
  }
});

test('несуществующая папка в списке не даёт изменить ничего', async () => {
  const { app, client } = await buildHarness();
  try {
    const key = await createLabel(app, 'Оплатить');
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/labels',
      payload: { ids: ['inbox:1', 'нет-такой-папки:5'], add: [key] },
    });
    assert.equal(res.statusCode, 404);
    // Ни одного письма не тронули: папки разбираются ДО первой команды
    assert.equal(client.flagsOf('INBOX', 1).size, 0);
  } finally {
    await app.close();
  }
});

test('несуществующее письмо не считается изменённым', async () => {
  const { app } = await buildHarness();
  try {
    const key = await createLabel(app, 'Оплатить');
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/labels',
      payload: { ids: ['inbox:999'], add: [key] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().updated, 0);
  } finally {
    await app.close();
  }
});

/*
 * Отдельного маршрута «какие метки на этих письмах» больше нет: метки
 * приезжают вместе со списком писем, а у строки-переписки — объединением
 * в сводке (`thread.labels`, см. imap/threading.test.ts). Проверка того,
 * что метка разговора собирается по ВСЕМ его письмам, живёт там же.
 */

/* ------------------------------------------------------------------ */
/* Удаление метки                                                      */
/* ------------------------------------------------------------------ */

test('удаление без снятия оставляет ключевое слово в письмах', async () => {
  const { app, client } = await buildHarness();
  try {
    const key = await createLabel(app, 'Оплатить');
    await app.inject({
      method: 'POST',
      url: '/api/messages/labels',
      payload: { ids: ['inbox:1'], add: [key] },
    });

    const res = await app.inject({ method: 'DELETE', url: `/api/labels/${key}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      ok: true,
      key,
      purged: false,
      removedFromMessages: 0,
    });

    // Обратный ход: в справочнике метки нет, а в письме слово осталось —
    // ровно это и обещано человеку в вопросе при удалении.
    const list = await app.inject({ method: 'GET', url: '/api/labels' });
    assert.deepEqual(list.json().items, []);
    assert.ok(client.flagsOf('INBOX', 1).has(key));
  } finally {
    await app.close();
  }
});

test('удаление со снятием чистит письма во всех папках и не трогает служебное', async () => {
  const { app, client } = await buildHarness();
  try {
    const key = await createLabel(app, 'Оплатить');
    const other = await createLabel(app, 'Юрист');
    await app.inject({
      method: 'POST',
      url: '/api/messages/labels',
      payload: { ids: ['inbox:1', 'inbox:2', 'archive:10'], add: [key, other] },
    });
    client.flagsOf('INBOX', 1).add('$Snoozed');
    client.flagsOf('Archive', 10).add('reliable');

    const res = await app.inject({ method: 'DELETE', url: `/api/labels/${key}?purge=1` });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().purged, true);
    assert.equal(res.json().removedFromMessages, 3, 'сняли не со всех писем');

    // Обратный ход: удаляемой метки нет нигде, а всё прочее на месте
    assert.equal(client.flagsOf('INBOX', 1).has(key), false);
    assert.equal(client.flagsOf('INBOX', 2).has(key), false);
    assert.equal(client.flagsOf('Archive', 10).has(key), false);
    assert.ok(client.flagsOf('INBOX', 1).has(other), 'соседняя метка пострадала');
    assert.ok(client.flagsOf('Archive', 10).has(other), 'соседняя метка пострадала');
    assert.ok(client.flagsOf('INBOX', 1).has('$Snoozed'), 'служебное слово стёрли');
    assert.ok(client.flagsOf('Archive', 10).has('reliable'), 'служебное слово стёрли');

    const list = await app.inject({ method: 'GET', url: '/api/labels' });
    assert.deepEqual(
      (list.json().items as Array<{ key: string }>).map((l) => l.key),
      [other],
    );
  } finally {
    await app.close();
  }
});

test('удалять и править можно только свои метки', async () => {
  const { app } = await buildHarness();
  try {
    for (const key of ['$Snoozed', 'reliable', 'finance', 'mt-net-takoy']) {
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/labels/${encodeURIComponent(key)}?purge=1`,
      });
      assert.equal(del.statusCode, 404, `${key}: ${del.body}`);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/labels/${encodeURIComponent(key)}`,
        payload: { name: 'Что угодно' },
      });
      assert.equal(patch.statusCode, 404, `${key}: ${patch.body}`);
    }
  } finally {
    await app.close();
  }
});
