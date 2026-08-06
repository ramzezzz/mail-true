/**
 * Проверки маршрутов разбора ящика на подставном IMAP-клиенте.
 *
 * Заглушка держит НАСТОЯЩЕЕ содержимое папок, а не журнал вызовов: почти
 * каждая проверка здесь идёт обратным ходом — попросили убрать и смотрим,
 * что лежит в корзине И что осталось на месте. Журнала вызовов для этого
 * не хватило бы: он доказывает, что команду послали, а не что ящик после
 * неё выглядит верно. Ровно так же устроены проверки меток.
 *
 * Отдельно и настойчиво проверяется то, ради чего вся осторожность:
 * массовое удаление не должно уносить лишнего, а число, показанное ДО
 * нажатия, обязано совпасть с тем, что уехало.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import { mailingsRoutes } from './mailings-routes.js';

/* ------------------------------------------------------------------ */
/* Подставной ящик                                                     */
/* ------------------------------------------------------------------ */

interface FakeMessage {
  uid: number;
  size: number;
  date: string;
  seen?: boolean;
  flagged?: boolean;
  subject?: string;
  from?: string;
  fromName?: string;
  listId?: string;
  unsubscribe?: string;
  unsubscribePost?: string;
}

interface FakeFolder {
  path: string;
  specialUse?: string;
  messages: FakeMessage[];
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

function headerBlock(msg: FakeMessage): Buffer {
  const lines: string[] = [];
  if (msg.listId) lines.push(`List-Id: ${msg.listId}`);
  if (msg.unsubscribe) lines.push(`List-Unsubscribe: ${msg.unsubscribe}`);
  if (msg.unsubscribePost) lines.push(`List-Unsubscribe-Post: ${msg.unsubscribePost}`);
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8');
}

class FakeClient {
  private selected = 'INBOX';
  /** Сколько раз ящик осматривали — по нему видно, работает ли снимок. */
  scans = 0;

  constructor(readonly folders: FakeFolder[]) {}

  private box(path: string): FakeFolder {
    const found = this.folders.find((f) => f.path === path);
    if (!found) throw new Error(`Нет папки ${path}`);
    return found;
  }

  async list(): Promise<unknown[]> {
    return this.folders.map((folder) => ({
      path: folder.path,
      name: folder.path,
      delimiter: '/',
      parentPath: '',
      specialUse: folder.specialUse,
      flags: new Set<string>(),
      status: {
        messages: folder.messages.length,
        unseen: folder.messages.filter((m) => m.seen !== true).length,
        uidValidity: 1n,
      },
    }));
  }

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    this.selected = path;
    return { release: () => undefined };
  }

  async noop(): Promise<void> {}

  async mailboxCreate(path: string): Promise<void> {
    if (!this.folders.some((f) => f.path === path)) this.folders.push({ path, messages: [] });
  }

  async mailboxSubscribe(): Promise<void> {}

  async search(query: { uid?: string; all?: boolean }): Promise<number[]> {
    const uids = this.box(this.selected).messages.map((m) => m.uid);
    if (typeof query.uid === 'string') {
      const wanted = new Set(expandSet(query.uid));
      return uids.filter((uid) => wanted.has(uid));
    }
    return uids;
  }

  async *fetch(range: string, _fields: unknown): AsyncGenerator<unknown> {
    this.scans += 1;
    const wanted = new Set(expandSet(range));
    for (const msg of this.box(this.selected).messages) {
      if (!wanted.has(msg.uid)) continue;
      yield this.toFetchObject(msg);
    }
  }

  async fetchOne(uid: string): Promise<unknown> {
    const msg = this.box(this.selected).messages.find((m) => m.uid === Number(uid));
    if (!msg) return null;
    return {
      uid: msg.uid,
      headers: Buffer.from(
        [
          `From: ${msg.from ?? 'shop@example.com'}`,
          `Subject: ${msg.subject ?? 'Тема'}`,
          ...(msg.listId ? [`List-Id: ${msg.listId}`] : []),
          ...(msg.unsubscribe ? [`List-Unsubscribe: ${msg.unsubscribe}`] : []),
          ...(msg.unsubscribePost ? [`List-Unsubscribe-Post: ${msg.unsubscribePost}`] : []),
          '',
          'тело',
          '',
        ].join('\r\n'),
        'utf8',
      ),
    };
  }

  private toFetchObject(msg: FakeMessage): unknown {
    const flags = new Set<string>();
    if (msg.seen) flags.add('\\Seen');
    if (msg.flagged) flags.add('\\Flagged');
    return {
      uid: msg.uid,
      size: msg.size,
      flags,
      internalDate: new Date(msg.date),
      envelope: {
        date: new Date(msg.date),
        subject: msg.subject ?? 'Тема',
        from: [{ name: msg.fromName ?? '', address: msg.from ?? 'shop@example.com' }],
      },
      headers: headerBlock(msg),
    };
  }

  async messageMove(uids: number[], target: string): Promise<{ uidMap: Map<number, number> }> {
    const source = this.box(this.selected);
    const destination = this.box(target);
    const uidMap = new Map<number, number>();
    for (const uid of uids) {
      const index = source.messages.findIndex((m) => m.uid === uid);
      const msg = source.messages[index];
      if (!msg) continue;
      source.messages.splice(index, 1);
      const nextUid = destination.messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
      destination.messages.push({ ...msg, uid: nextUid });
      uidMap.set(uid, nextUid);
    }
    return { uidMap };
  }

  async getQuota(): Promise<{ storage: { usage: number; limit: number } }> {
    const usage = this.folders.reduce(
      (sum, folder) => sum + folder.messages.reduce((s, m) => s + m.size, 0),
      0,
    );
    return { storage: { usage, limit: 1_000_000 } };
  }
}

/* ------------------------------------------------------------------ */
/* Стенд                                                               */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

interface Harness {
  app: FastifyInstance;
  client: FakeClient;
}

function defaultFolders(): FakeFolder[] {
  return [
    {
      path: 'INBOX',
      specialUse: '\\Inbox',
      messages: [
        // Рассылка «Магазин»: три письма с двух разных адресов, но с общим
        // List-Id, — в разборе это одна строка.
        {
          uid: 1,
          size: 1000,
          date: daysAgo(200),
          seen: true,
          from: 'news-01@shop.example',
          listId: 'Скидки <news.shop.example>',
          unsubscribe: '<https://shop.example/u/1>',
          unsubscribePost: 'List-Unsubscribe=One-Click',
        },
        {
          uid: 2,
          size: 2000,
          date: daysAgo(100),
          seen: true,
          from: 'news-02@shop.example',
          listId: 'Скидки <news.shop.example>',
          unsubscribe: '<https://shop.example/u/2>',
          unsubscribePost: 'List-Unsubscribe=One-Click',
        },
        {
          uid: 3,
          size: 3000,
          date: daysAgo(1),
          seen: false,
          from: 'news-01@shop.example',
          listId: 'Скидки <news.shop.example>',
        },
        // Живая переписка — рассылкой не считается и уборкой не трогается
        {
          uid: 4,
          size: 500,
          date: daysAgo(300),
          seen: true,
          flagged: true,
          from: 'kolya@example.com',
        },
        {
          uid: 5,
          size: 900_000,
          date: daysAgo(400),
          seen: true,
          from: 'kolya@example.com',
          subject: 'Отчёт',
        },
      ],
    },
    { path: 'Trash', specialUse: '\\Trash', messages: [{ uid: 9, size: 10, date: daysAgo(500) }] },
    {
      path: 'Drafts',
      specialUse: '\\Drafts',
      messages: [{ uid: 7, size: 20, date: daysAgo(500) }],
    },
    { path: 'Archive', specialUse: '\\Archive', messages: [] },
  ];
}

async function buildHarness(folders: FakeFolder[] = defaultFolders()): Promise<Harness> {
  const client = new FakeClient(folders);
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  app.decorate('deps', { pool } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async (request: { mailSession: unknown }) => {
    request.mailSession = { email: 'test@mail.local', password: 'secret' };
  });
  registerErrorHandling(app);
  await app.register(
    async (instance) => {
      await mailingsRoutes(instance, {
        smtp: () => ({ host: 'localhost', port: 25, secure: false, rejectUnauthorized: false }),
      });
    },
    { prefix: '/api' },
  );
  await app.ready();
  return { app, client };
}

interface MailingsResponse {
  at: string;
  scanned: number;
  total: number;
  truncated: boolean;
  quota: { usedBytes: number; limitBytes: number } | null;
  groups: Array<{
    key: string;
    title: string;
    count: number;
    bytes: number;
    unread: number;
    mailing: boolean;
    canUnsubscribe: boolean;
    oneClick: boolean;
    quotaShare: number | null;
  }>;
}

async function mailings(app: FastifyInstance): Promise<MailingsResponse> {
  const response = await app.inject({ method: 'GET', url: '/api/mailings' });
  assert.equal(response.statusCode, 200);
  return response.json<MailingsResponse>();
}

/* ------------------------------------------------------------------ */
/* Разбор                                                              */
/* ------------------------------------------------------------------ */

test('разбор собирает рассылку с разных адресов в одну строку и считает её место', async () => {
  const { app } = await buildHarness();
  const body = await mailings(app);
  const shop = body.groups.find((g) => g.key === 'list:news.shop.example');
  assert.ok(shop, 'рассылка магазина должна быть в разборе');
  assert.equal(shop.count, 3);
  assert.equal(shop.bytes, 6000);
  assert.equal(shop.unread, 1);
  assert.equal(shop.mailing, true);
  assert.equal(shop.canUnsubscribe, true);
  assert.equal(shop.oneClick, true);
  assert.equal(shop.title, 'Скидки');
  await app.close();
});

test('черновики не осматриваются, а переписка рассылкой не объявляется', async () => {
  const { app } = await buildHarness();
  const body = await mailings(app);
  const kolya = body.groups.find((g) => g.key === 'from:kolya@example.com');
  assert.equal(kolya?.mailing, false);
  assert.equal(kolya?.canUnsubscribe, false);
  // Черновик в разбор не попал вовсе
  assert.ok(!body.groups.some((g) => g.count === 1 && g.bytes === 20));
  await app.close();
});

test('квота берётся у почтового сервера, а доля группы считается от неё', async () => {
  const { app } = await buildHarness();
  const body = await mailings(app);
  assert.equal(body.quota?.limitBytes, 1_000_000);
  const shop = body.groups.find((g) => g.key === 'list:news.shop.example');
  assert.ok(shop?.quotaShare !== null && (shop?.quotaShare ?? 0) > 0);
  await app.close();
});

test('снимок ящика переиспользуется: второй запрос не осматривает ящик заново', async () => {
  const { app, client } = await buildHarness();
  await mailings(app);
  const afterFirst = client.scans;
  await mailings(app);
  assert.equal(client.scans, afterFirst, 'второй запрос обязан взять готовый снимок');
  const refreshed = await app.inject({ method: 'GET', url: '/api/mailings?refresh=1' });
  assert.equal(refreshed.statusCode, 200);
  assert.ok(client.scans > afterFirst, '«Обновить» обязано осматривать заново');
  await app.close();
});

/* ------------------------------------------------------------------ */
/* Уборка: главное — не унести лишнего                                 */
/* ------------------------------------------------------------------ */

test('предпросмотр ничего не двигает и называет то же число, что и выполнение', async () => {
  const { app, client } = await buildHarness();
  const seen = await mailings(app);

  const preview = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: { groupKey: 'list:news.shop.example', olderThanDays: 30, dryRun: true },
  });
  assert.equal(preview.statusCode, 200);
  const previewBody = preview.json<{ count: number; bytes: number; moved: number }>();
  assert.equal(previewBody.count, 2, 'старше 30 дней — два письма рассылки из трёх');
  assert.equal(previewBody.bytes, 3000);
  assert.equal(previewBody.moved, 0);
  assert.equal(client.folders[0]?.messages.length, 5, 'предпросмотр ящик не трогает');

  const run = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: {
      groupKey: 'list:news.shop.example',
      olderThanDays: 30,
      dryRun: false,
      scanAt: seen.at,
    },
  });
  assert.equal(run.statusCode, 200);
  const runBody = run.json<{ count: number; moved: number; targetFolderId: string }>();
  assert.equal(runBody.count, previewBody.count);
  assert.equal(runBody.moved, 2, 'уехало ровно то, что было обещано');
  assert.equal(runBody.targetFolderId, 'trash');

  const inbox = client.folders.find((f) => f.path === 'INBOX');
  const trash = client.folders.find((f) => f.path === 'Trash');
  assert.equal(inbox?.messages.length, 3);
  assert.equal(trash?.messages.length, 3, 'письма ПЕРЕНЕСЕНЫ в корзину, а не стёрты');
  // Свежее письмо рассылки осталось на месте
  assert.ok(inbox?.messages.some((m) => m.uid === 3));
  await app.close();
});

test('выполнение без отметки показанного разбора запрещено', async () => {
  const { app, client } = await buildHarness();
  await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: { olderThanDays: 30, dryRun: false },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(client.folders[0]?.messages.length, 5, 'ящик не тронут');
  await app.close();
});

test('устаревшая отметка разбора отвергается, а не выполняется по новым данным', async () => {
  const { app, client } = await buildHarness();
  await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: { olderThanDays: 30, dryRun: false, scanAt: '2000-01-01T00:00:00.000Z' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json<{ message: string }>().message, /пересобран/);
  assert.equal(client.folders[0]?.messages.length, 5);
  await app.close();
});

test('по умолчанию запрос только считает: dryRun не обязан присылаться', async () => {
  const { app, client } = await buildHarness();
  await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: { olderThanDays: 1 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ dryRun: boolean }>().dryRun, true);
  assert.equal(client.folders[0]?.messages.length, 5);
  await app.close();
});

test('уборка не выносит корзину и черновики даже без единого условия', async () => {
  const { app, client } = await buildHarness();
  const seen = await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: { dryRun: false, scanAt: seen.at },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(client.folders.find((f) => f.path === 'Drafts')?.messages.length, 1);
  // В корзине было одно своё письмо плюс пять приехавших из «Входящих»
  assert.equal(client.folders.find((f) => f.path === 'Trash')?.messages.length, 6);
  await app.close();
});

test('защита непрочитанного и помеченного доходит от запроса до ящика', async () => {
  const { app, client } = await buildHarness();
  const seen = await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: { dryRun: false, scanAt: seen.at, keepUnread: true, keepFlagged: true },
  });
  assert.equal(response.statusCode, 200);
  const inbox = client.folders.find((f) => f.path === 'INBOX');
  assert.deepEqual(
    inbox?.messages.map((m) => m.uid).sort((a, b) => a - b),
    [3, 4],
    'остались непрочитанное (3) и помеченное флажком (4)',
  );
  await app.close();
});

test('после уборки снимок пересобирается: числа не могут остаться от прежнего ящика', async () => {
  const { app } = await buildHarness();
  const seen = await mailings(app);
  const sweep = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: {
      groupKey: 'list:news.shop.example',
      olderThanDays: 30,
      dryRun: false,
      scanAt: seen.at,
    },
  });
  assert.equal(sweep.statusCode, 200, sweep.body);
  const after = await mailings(app);
  assert.notEqual(after.at, seen.at);
  assert.equal(after.groups.find((g) => g.key === 'list:news.shop.example')?.count, 1);
  await app.close();
});

test('«оставить последнее» доезжает до ящика: свежее письмо рассылки остаётся', async () => {
  const { app, client } = await buildHarness();
  const seen = await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: {
      groupKey: 'list:news.shop.example',
      dryRun: false,
      scanAt: seen.at,
      keepLatest: 1,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ moved: number }>().moved, 2);
  const inbox = client.folders.find((f) => f.path === 'INBOX');
  assert.ok(
    inbox?.messages.some((m) => m.uid === 3),
    'последнее письмо рассылки на месте',
  );
  await app.close();
});

test('рассылку можно отправить в папку, а не в корзину', async () => {
  const { app, client } = await buildHarness();
  const seen = await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/cleanup/sweep',
    payload: {
      groupKey: 'list:news.shop.example',
      dryRun: false,
      scanAt: seen.at,
      targetFolderId: 'archive',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ moved: number }>().moved, 3);
  assert.equal(client.folders.find((f) => f.path === 'Archive')?.messages.length, 3);
  assert.equal(client.folders.find((f) => f.path === 'Trash')?.messages.length, 1);
  await app.close();
});

/* ------------------------------------------------------------------ */
/* Отписка пачкой                                                      */
/* ------------------------------------------------------------------ */

test('отписка от группы без адреса отписки отвечает «нечем», а не молчит', async () => {
  const { app } = await buildHarness();
  await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/mailings/unsubscribe',
    payload: { key: 'from:kolya@example.com' },
  });
  assert.equal(response.statusCode, 404);
  assert.match(response.json<{ message: string }>().message, /нет адреса отписки/);
  await app.close();
});

test('отписка от несуществующей группы — 404, а не ошибка сервера', async () => {
  const { app } = await buildHarness();
  await mailings(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/mailings/unsubscribe',
    payload: { key: 'list:нет.такого' },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

/* ------------------------------------------------------------------ */
/* Уборка: что съело место                                             */
/* ------------------------------------------------------------------ */

test('уборка показывает самые тяжёлые письма и настоящую квоту', async () => {
  const { app } = await buildHarness();
  const response = await app.inject({ method: 'GET', url: '/api/cleanup' });
  assert.equal(response.statusCode, 200);
  const body = response.json<{
    quota: { usedBytes: number; limitBytes: number } | null;
    heaviest: Array<{ size: number; subject: string }>;
    staleMailings: Array<{ key: string }>;
  }>();
  assert.equal(body.quota?.limitBytes, 1_000_000);
  assert.equal(body.heaviest[0]?.size, 900_000);
  assert.equal(body.heaviest[0]?.subject, 'Отчёт');
  // Рассылка магазина писала на днях — залежавшейся она не считается
  assert.ok(!body.staleMailings.some((g) => g.key === 'list:news.shop.example'));
  await app.close();
});
