/**
 * Проверки маршрутов работы с письмами на подставном IMAP-клиенте.
 * Приложение собирается минимальным: маршруты + тот же перевод ошибок,
 * что и в бою (registerErrorHandling), без Redis и Postgres.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import { messageRoutes } from './messages.js';

interface FolderSpec {
  path: string;
  specialUse?: string;
  uids: number[];
  /** У каких писем есть настоящее вложение. */
  withAttachment?: number[];
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

/** Подставной IMAP-клиент: только то, чем пользуются проверяемые маршруты. */
class FakeClient {
  readonly boxes = new Map<string, Set<number>>();
  readonly attachments = new Map<string, Set<number>>();
  private selected = 'INBOX';

  /** Журнал изменяющих вызовов — по нему видно, что тронули, а что нет. */
  readonly calls: string[] = [];

  constructor(private readonly specs: FolderSpec[]) {
    for (const spec of specs) {
      this.boxes.set(spec.path, new Set(spec.uids));
      this.attachments.set(spec.path, new Set(spec.withAttachment ?? []));
    }
  }

  async list(): Promise<unknown[]> {
    return this.specs.map((spec) => ({
      path: spec.path,
      name: spec.path,
      delimiter: '/',
      parentPath: '',
      specialUse: spec.specialUse,
      flags: new Set<string>(),
      status: {
        messages: this.boxes.get(spec.path)?.size ?? 0,
        unseen: 0,
        uidValidity: 1n,
      },
    }));
  }

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    this.selected = path;
    return { release: () => undefined };
  }

  /**
   * NOOP. Настоящий продукт зовёт его перед поиском, чтобы почтовый сервер
   * пересмотрел папку: соединение живёт между запросами, и без этого список
   * отставал ровно на одно письмо.
   *
   * Заглушка обязана уметь всё, что умеет настоящий клиент. Когда NOOP
   * появился в продукте, заглушки его не знали — и падали. Это десятый по
   * счёту случай, когда заглушка разошлась с настоящим; хорошо, что на этот
   * раз расхождение поймали проверки, а не человек.
   */
  async noop(): Promise<void> {}

  async search(query: { uid?: string; all?: boolean }): Promise<number[]> {
    const present = this.boxes.get(this.selected) ?? new Set<number>();
    if (typeof query.uid === 'string') {
      return expandSet(query.uid).filter((uid) => present.has(uid));
    }
    return [...present];
  }

  // Настоящий IMAP принимает набор вида `1:100,105` — и API теперь именно
  // так и сворачивает списки номеров, чтобы команда не упиралась в предел
  // длины (см. imap/service.ts, chunkUidSets)
  async fetchAll(range: string | number[]): Promise<unknown[]> {
    const uids = typeof range === 'string' ? expandSet(range) : range;
    const withAttachment = this.attachments.get(this.selected) ?? new Set<number>();
    return uids.map((uid) => ({
      uid,
      envelope: { subject: `Письмо ${uid}`, from: [], date: new Date('2026-08-05T10:00:00Z') },
      flags: new Set<string>(),
      size: 100,
      internalDate: new Date('2026-08-05T10:00:00Z'),
      bodyStructure: withAttachment.has(uid)
        ? {
            type: 'multipart/mixed',
            childNodes: [
              { part: '1', type: 'text/plain', size: 10 },
              {
                part: '2',
                type: 'application/pdf',
                size: 90,
                disposition: 'attachment',
                dispositionParameters: { filename: 'счёт.pdf' },
              },
            ],
          }
        : { part: '1', type: 'text/plain', size: 100 },
    }));
  }

  async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
    this.calls.push(`flagsAdd ${this.selected} ${uids.join(',')} ${flags.join(',')}`);
    return true;
  }

  async messageFlagsRemove(uids: number[], flags: string[]): Promise<boolean> {
    this.calls.push(`flagsRemove ${this.selected} ${uids.join(',')} ${flags.join(',')}`);
    return true;
  }

  async messageMove(
    uids: number[],
    destination: string
  ): Promise<{ path: string; destination: string; uidMap: Map<number, number> }> {
    this.calls.push(`move ${this.selected}->${destination} ${uids.join(',')}`);
    const from = this.boxes.get(this.selected);
    const to = this.boxes.get(destination) ?? new Set<number>();
    const uidMap = new Map<number, number>();
    let next = 1000;
    for (const uid of uids) {
      if (!from?.has(uid)) continue;
      from.delete(uid);
      const newUid = next++;
      to.add(newUid);
      uidMap.set(uid, newUid);
    }
    this.boxes.set(destination, to);
    return { path: this.selected, destination, uidMap };
  }

  async mailboxCreate(path: string): Promise<void> {
    this.calls.push(`mailboxCreate ${path}`);
    this.specs.push({ path, uids: [] });
    this.boxes.set(path, new Set());
  }

  async mailboxSubscribe(): Promise<void> {
    /* не важно для проверок */
  }
}

async function buildTestApp(client: FakeClient): Promise<FastifyInstance> {
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
  await app.register(messageRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

function mailbox(): FakeClient {
  return new FakeClient([
    { path: 'INBOX', specialUse: '\\Inbox', uids: [1, 2, 3], withAttachment: [2] },
    { path: 'Trash', specialUse: '\\Trash', uids: [] },
  ]);
}

// --- Флаги ---

/**
 * Главный случай. Папки разбирались по ходу дела: письмо из несуществующей
 * папки в середине списка приводило к 404 уже ПОСЛЕ того, как часть флагов
 * проставлена, — список расходился с ящиком.
 */
test('флаги: несуществующая папка в списке не даёт изменить ничего', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/flags',
      payload: { ids: ['inbox:1', 'нет-такой-папки:5'], seen: true },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'NOT_FOUND');
    assert.deepEqual(client.calls, [], `ящик тронули: ${client.calls.join(' | ')}`);
  } finally {
    await app.close();
  }
});

/**
 * И наоборот: для несуществующего письма возвращалось `{"updated":1}`,
 * потому что считалась длина списка, а не результат IMAP.
 */
test('флаги: несуществующее письмо не считается изменённым', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/flags',
      payload: { ids: ['inbox:999'], seen: true },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { updated: 0 });
    assert.deepEqual(client.calls, []);
  } finally {
    await app.close();
  }
});

test('флаги: считаются только существующие письма', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/flags',
      payload: { ids: ['inbox:1', 'inbox:999', 'inbox:3'], flagged: true },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { updated: 2 });
    assert.deepEqual(client.calls, ['flagsAdd INBOX 1,3 \\Flagged']);
  } finally {
    await app.close();
  }
});

// --- Перемещение ---

test('перемещение: несуществующая папка-источник не даёт переместить ничего', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/move',
      payload: { ids: ['inbox:1', 'нет-такой-папки:5'], targetFolderId: 'trash' },
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(client.calls, []);
    assert.equal(client.boxes.get('INBOX')?.size, 3, 'письма остались на месте');
  } finally {
    await app.close();
  }
});

test('перемещение: заведомо неудачный запрос не создаёт папку-получатель', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/move',
      payload: { ids: ['нет-такой-папки:5'], targetFolderId: 'archive' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(
      client.calls.some((c) => c.startsWith('mailboxCreate')),
      false,
      'папка «Архив» создана зря'
    );
  } finally {
    await app.close();
  }
});

test('перемещение: несуществующее письмо не считается перемещённым', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/move',
      payload: { ids: ['inbox:999'], targetFolderId: 'trash' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { moved: 0 });
    assert.deepEqual(client.calls, []);
  } finally {
    await app.close();
  }
});

test('перемещение: счётчик равен числу действительно перемещённых писем', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/move',
      payload: { ids: ['inbox:1', 'inbox:999'], targetFolderId: 'trash' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { moved: 1 });
    assert.equal(client.boxes.get('Trash')?.size, 1);
    assert.equal(client.boxes.get('INBOX')?.has(1), false);
  } finally {
    await app.close();
  }
});

// --- Фильтр «с вложениями» ---

/**
 * Фильтр искал по заголовку `Content-Type: multipart/mixed`, а Dovecot по
 * нему не ищет — проверено на живом сервере. Фильтр не находил ничего
 * и никогда.
 */
test('фильтр «с вложениями» находит письма с вложениями', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?folderId=inbox&filter=with-attachments&snippets=0',
    });
    assert.equal(res.statusCode, 200);
    const page = res.json() as { items: Array<{ uid: number; hasAttachments: boolean }>; total: number };
    assert.equal(page.total, 1);
    assert.deepEqual(
      page.items.map((i) => i.uid),
      [2]
    );
    assert.equal(page.items[0]?.hasAttachments, true);
  } finally {
    await app.close();
  }
});

test('без фильтра список остаётся полным', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?folderId=inbox&snippets=0',
    });
    const page = res.json() as { total: number };
    assert.equal(page.total, 3);
  } finally {
    await app.close();
  }
});

test('несуществующий путь отвечает в форме контракта', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/такого-нет' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'NOT_FOUND', message: 'Ресурс не найден' });
  } finally {
    await app.close();
  }
});
