/**
 * Проверки одноразовых адресов.
 *
 * Здесь защищается то, что ломается МОЛЧА — то есть выглядит работающим:
 *
 *  1. Выключение снимает `active` у строки virtual_aliases. Это не деталь
 *     реализации, а единственное, из-за чего Postfix перестаёт носить
 *     почту: карта алиасов отбирает строки по этому полю. Проверка,
 *     смотрящая только на ответ маршрута, пропустила бы адрес, который
 *     в интерфейсе «выключен», а письма принимает.
 *  2. Чужой адрес не виден и не меняется. Список псевдонимов отвечает на
 *     вопрос «под какими адресами человек прячется» — утечь он не имеет
 *     права даже по номеру.
 *  3. Алиас администратора (без строки в disposable_aliases) владельцу
 *     ящика невидим и неприкосновенен, даже когда ведёт на его ящик.
 *  4. Предел считает выключенные адреса. Иначе предела нет вовсе.
 *  5. Служебные имена (postmaster, abuse) занять нельзя.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import type { DisposableRow, DisposableStore } from './db.js';
import { checkLocalPart, suggestLocalPart } from './name.js';
import { disposableRoutes } from './routes.js';

/* ------------------------------------------------------------------ */
/* Хранилище в памяти                                                   */
/* ------------------------------------------------------------------ */

/**
 * Держит ДВЕ таблицы раздельно — ровно как настоящая база.
 *
 * Слить их в один список было бы удобно и неверно: половина проверок
 * здесь именно про то, что алиас без пристройки владельцу не принадлежит.
 */
class MemoryStore implements DisposableStore {
  /** Всё, что видит Postfix: и наши адреса, и админские. */
  aliases: { id: number; address: string; destination: string; active: boolean }[] = [];
  /** Пристройка: чей адрес и когда выключен. */
  own = new Map<number, { ownerEmail: string; note: string; createdAt: Date; disabledAt: Date | null }>();
  mailboxes = new Set<string>(['test@mail.local', 'chuzhoy@mail.local']);
  domains = new Map<string, number>([['mail.local', 1]]);
  private next = 1;

  async schemaReady(): Promise<boolean> {
    return true;
  }

  private row(id: number): DisposableRow | null {
    const alias = this.aliases.find((a) => a.id === id);
    const mine = this.own.get(id);
    if (!alias || !mine) return null;
    return {
      id,
      address: alias.address,
      destination: alias.destination,
      active: alias.active,
      note: mine.note,
      createdAt: mine.createdAt,
      disabledAt: mine.disabledAt,
    };
  }

  async list(ownerEmail: string): Promise<DisposableRow[]> {
    return [...this.own.entries()]
      .filter(([, v]) => v.ownerEmail === ownerEmail)
      .map(([id]) => this.row(id))
      .filter((r): r is DisposableRow => r !== null);
  }

  async count(ownerEmail: string): Promise<number> {
    return [...this.own.values()].filter((v) => v.ownerEmail === ownerEmail).length;
  }

  async taken(address: string): Promise<boolean> {
    const lower = address.toLowerCase();
    return (
      this.mailboxes.has(lower) || this.aliases.some((a) => a.address.toLowerCase() === lower)
    );
  }

  async domainId(domain: string): Promise<number | null> {
    return this.domains.get(domain.toLowerCase()) ?? null;
  }

  async create(p: {
    domainId: number;
    address: string;
    ownerEmail: string;
    note: string;
  }): Promise<DisposableRow> {
    const id = this.next++;
    this.aliases.push({ id, address: p.address, destination: p.ownerEmail, active: true });
    this.own.set(id, {
      ownerEmail: p.ownerEmail,
      note: p.note,
      createdAt: new Date(),
      disabledAt: null,
    });
    return this.row(id)!;
  }

  async setActive(ownerEmail: string, id: number, active: boolean): Promise<DisposableRow | null> {
    const mine = this.own.get(id);
    if (!mine || mine.ownerEmail !== ownerEmail) return null;
    const alias = this.aliases.find((a) => a.id === id);
    if (!alias) return null;
    alias.active = active;
    mine.disabledAt = active ? null : new Date();
    return this.row(id);
  }

  async setNote(ownerEmail: string, id: number, note: string): Promise<DisposableRow | null> {
    const mine = this.own.get(id);
    if (!mine || mine.ownerEmail !== ownerEmail) return null;
    mine.note = note;
    return this.row(id);
  }

  async remove(ownerEmail: string, id: number): Promise<DisposableRow | null> {
    const before = this.row(id);
    const mine = this.own.get(id);
    if (!before || !mine || mine.ownerEmail !== ownerEmail) return null;
    this.own.delete(id);
    this.aliases = this.aliases.filter((a) => a.id !== id);
    return before;
  }

  async shutdown(): Promise<void> {}

  /** Алиас, заведённый администратором: строка есть, пристройки нет. */
  addAdminAlias(address: string, destination: string): number {
    const id = this.next++;
    this.aliases.push({ id, address, destination, active: true });
    return id;
  }
}

/* ------------------------------------------------------------------ */
/* Стенд                                                                */
/* ------------------------------------------------------------------ */

interface Harness {
  app: FastifyInstance;
  store: MemoryStore;
  close(): Promise<void>;
}

async function build(options: { store?: MemoryStore | null; limit?: number; email?: string } = {}): Promise<Harness> {
  const store = options.store === undefined ? new MemoryStore() : options.store;
  const email = options.email ?? 'test@mail.local';

  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  app.decorate('deps', {} as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email, password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(
    async (scope) => {
      await disposableRoutes(scope, {
        store,
        unavailableReason: 'Не применена миграция 0028',
        limit: options.limit ?? 50,
        // Каталога нет — сводка по журналу просто не соберётся, и это
        // правильное поведение для проверок: они не про журнал.
        logDir: '/nonexistent-log-dir',
      });
    },
    { prefix: '/api/settings' },
  );
  await app.ready();

  return { app, store: store!, close: () => app.close() };
}

const post = async (app: FastifyInstance, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/settings/aliases', payload });

/* ------------------------------------------------------------------ */
/* Проверки                                                             */
/* ------------------------------------------------------------------ */

test('адрес заводится и сразу работает', async () => {
  const h = await build();
  const res = await post(h.app, { name: 'shop-2026', note: 'Магазин обуви' });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.address, 'shop-2026@mail.local');
  assert.equal(body.destination, 'test@mail.local');
  assert.equal(body.active, true);
  assert.equal(body.note, 'Магазин обуви');
  // Строка легла в ту самую таблицу, которую читает Postfix.
  assert.equal(h.store.aliases[0]!.address, 'shop-2026@mail.local');
  await h.close();
});

test('выключение снимает active у строки, которую читает Postfix', async () => {
  const h = await build();
  const created = (await post(h.app, { name: 'shop-2026', note: '' })).json();

  const res = await h.app.inject({
    method: 'PATCH',
    url: `/api/settings/aliases/${created.id}`,
    payload: { active: false },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().active, false);
  assert.ok(res.json().disabledAt, 'время выключения проставлено');

  /*
   * Главное в этой проверке. Карта virtual_alias_maps отбирает строки
   * по `active`; не снятый флаг означал бы адрес, выключенный только на
   * вид, — и почта продолжала бы приходить.
   */
  assert.equal(h.store.aliases[0]!.active, false);

  // Обратно включается.
  const back = await h.app.inject({
    method: 'PATCH',
    url: `/api/settings/aliases/${created.id}`,
    payload: { active: true },
  });
  assert.equal(back.json().active, true);
  assert.equal(back.json().disabledAt, null);
  assert.equal(h.store.aliases[0]!.active, true);
  await h.close();
});

test('чужой адрес не виден в списке и не меняется по номеру', async () => {
  const store = new MemoryStore();
  // Адрес соседа.
  const mine = await build({ store, email: 'chuzhoy@mail.local' });
  const alien = (await post(mine.app, { name: 'sosed-shop', note: 'секрет' })).json();
  await mine.close();

  const h = await build({ store, email: 'test@mail.local' });

  const list = (await h.app.inject({ method: 'GET', url: '/api/settings/aliases' })).json();
  assert.equal(list.items.length, 0, 'чужих адресов в списке нет');

  const patch = await h.app.inject({
    method: 'PATCH',
    url: `/api/settings/aliases/${alien.id}`,
    payload: { active: false },
  });
  assert.equal(patch.statusCode, 404, 'чужой адрес не выключить по номеру');
  assert.equal(store.aliases[0]!.active, true, 'и он остался работать');

  const del = await h.app.inject({
    method: 'DELETE',
    url: `/api/settings/aliases/${alien.id}`,
  });
  assert.equal(del.statusCode, 404);
  await h.close();
});

test('алиас администратора владельцу ящика невидим и неприкосновенен', async () => {
  const store = new MemoryStore();
  // Служебный support@ ведёт на наш ящик, но заведён администратором.
  const id = store.addAdminAlias('support@mail.local', 'test@mail.local');
  const h = await build({ store });

  const list = (await h.app.inject({ method: 'GET', url: '/api/settings/aliases' })).json();
  assert.equal(list.items.length, 0, 'служебного алиаса в разделе нет');

  const res = await h.app.inject({
    method: 'PATCH',
    url: `/api/settings/aliases/${id}`,
    payload: { active: false },
  });
  assert.equal(res.statusCode, 404, 'и выключить его нельзя');
  assert.equal(store.aliases[0]!.active, true);
  await h.close();
});

test('предел считает выключенные адреса тоже', async () => {
  const h = await build({ limit: 2 });
  const first = (await post(h.app, { name: 'shop-one', note: '' })).json();
  await post(h.app, { name: 'shop-two', note: '' });

  // Выключаем первый — имя он всё равно занимает.
  await h.app.inject({
    method: 'PATCH',
    url: `/api/settings/aliases/${first.id}`,
    payload: { active: false },
  });

  const res = await post(h.app, { name: 'shop-three', note: '' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /Больше 2/);

  // А после удаления место освобождается.
  await h.app.inject({ method: 'DELETE', url: `/api/settings/aliases/${first.id}` });
  assert.equal((await post(h.app, { name: 'shop-three', note: '' })).statusCode, 201);
  await h.close();
});

test('занятый адрес не завести: ни поверх ящика, ни поверх чужого алиаса', async () => {
  const store = new MemoryStore();
  store.addAdminAlias('support@mail.local', 'test@mail.local');
  const h = await build({ store });

  // Поверх живого ящика — это увело бы всю его входящую почту.
  const overMailbox = await post(h.app, { name: 'chuzhoy', note: '' });
  assert.equal(overMailbox.statusCode, 400);
  assert.match(overMailbox.json().message, /занят/);

  // Поверх служебного алиаса.
  const overAlias = await post(h.app, { name: 'support', note: '' });
  assert.equal(overAlias.statusCode, 400);
  await h.close();
});

test('служебные имена заняты за доменом навсегда', async () => {
  const h = await build();
  for (const name of ['postmaster', 'abuse']) {
    const res = await post(h.app, { name, note: '' });
    assert.equal(res.statusCode, 400, `${name} не должен заводиться`);
    assert.match(res.json().message, /служебное/);
  }
  await h.close();
});

test('без имени адрес придумывается сам и не повторяется', async () => {
  const h = await build();
  const a = (await post(h.app, { name: '', note: 'Магазин' })).json();
  const b = (await post(h.app, { name: '', note: 'Магазин' })).json();
  assert.notEqual(a.address, b.address, 'два адреса подряд не совпали');
  assert.match(a.address, /@mail\.local$/);
  await h.close();
});

test('без применённой миграции раздел честно говорит, чего не хватает', async () => {
  const h = await build({ store: null });
  const list = (await h.app.inject({ method: 'GET', url: '/api/settings/aliases' })).json();
  assert.equal(list.available, false);
  assert.match(list.reason, /0028/);
  assert.deepEqual(list.items, []);

  // И завести ничего нельзя — отказ с той же причиной, а не 500.
  const res = await post(h.app, { name: 'shop', note: '' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /0028/);
  await h.close();
});

/* ------------------------------------------------------------------ */
/* Имена                                                                */
/* ------------------------------------------------------------------ */

test('вид имени проверяется до базы', () => {
  assert.equal(checkLocalPart('shop-2026'), null);
  assert.equal(checkLocalPart('shop.2026'), null);
  assert.ok(checkLocalPart('ab'), 'слишком коротко');
  assert.ok(checkLocalPart('-shop'), 'дефис в начале');
  assert.ok(checkLocalPart('shop-'), 'дефис в конце');
  assert.ok(checkLocalPart('shop..2026'), 'две точки подряд');
  assert.ok(checkLocalPart('маг'), 'кириллица: письма на такой адрес не дойдут');
  assert.ok(checkLocalPart('a b'), 'пробел');
  assert.ok(checkLocalPart('a'.repeat(65)), 'длиннее 64 знаков');
});

test('придуманное имя годится по тем же правилам', () => {
  const random = () => 0.5;
  assert.equal(checkLocalPart(suggestLocalPart('Магазин обуви', random)), null);
  assert.equal(checkLocalPart(suggestLocalPart('', random)), null);
  assert.equal(checkLocalPart(suggestLocalPart('!!!', random)), null);
  assert.equal(checkLocalPart(suggestLocalPart('a'.repeat(80), random)), null);
});
