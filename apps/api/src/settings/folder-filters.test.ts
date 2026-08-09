/**
 * Папка и правила фильтрации, которые на неё смотрят.
 *
 * Проверяется то, что ломалось молча и объяснению не поддавалось:
 *
 *   1. Переименовали папку — правило осталось со старым путём. Файл Sieve
 *      собирается с `fileinto :create`, поэтому первое же подходящее
 *      письмо ЗАВОДИЛО папку со старым именем заново. В новой папке
 *      писем не было, в списке правил действие пропадало с глаз, и первое
 *      же сохранение правила записывало folder: null — раскладка
 *      исчезала насовсем.
 *   2. Удалили папку — то же самое: `:create` возвращал её к жизни при
 *      первой доставке.
 *   3. Удаление папки удаляло ОДНУ папку, хотя человеку обещано «папка и
 *      все её вложенные папки будут удалены вместе с письмами».
 *
 * Настоящий Dovecot для этого не нужен: подделка помнит, что ей велели
 * сделать, а проверяется именно это — что сервер сделал и чего не сделал.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import type { ImapFlow } from 'imapflow';
import { registerErrorHandling } from '../http-errors.js';
import { mapFolders, type RawFolderInfo } from '../mail/folders.js';
import { folderManagementRoutes, retargetFilterFolders } from './folders.js';
import { DEFAULT_ACTIONS, type FilterActions, type FilterRule } from './types.js';

const logger = pino({ level: 'silent' });

/* ------------------------------------------------------------------ */
/* Подделки                                                             */
/* ------------------------------------------------------------------ */

interface FakeMailbox {
  path: string;
  specialUse?: string;
}

/** Ящик: «Входящие», «Корзина» и дерево «Работа/Счета». */
const MAILBOXES: FakeMailbox[] = [
  { path: 'INBOX', specialUse: '\\Inbox' },
  { path: 'Trash', specialUse: '\\Trash' },
  { path: 'Работа' },
  { path: 'Работа/Счета' },
];

class FakeClient {
  boxes: FakeMailbox[];
  readonly deleted: string[] = [];
  readonly renamed: Array<[string, string]> = [];

  constructor(boxes: FakeMailbox[]) {
    this.boxes = boxes.map((b) => ({ ...b }));
  }

  list(): Promise<unknown[]> {
    return Promise.resolve(
      this.boxes.map((box) => {
        const parts = box.path.split('/');
        return {
          path: box.path,
          name: parts[parts.length - 1] ?? box.path,
          delimiter: '/',
          parentPath: parts.slice(0, -1).join('/'),
          flags: new Set<string>(),
          ...(box.specialUse ? { specialUse: box.specialUse } : {}),
          status: { messages: 3, unseen: 0, uidValidity: 1n },
        };
      }),
    );
  }

  status(): Promise<unknown> {
    return Promise.resolve({ messages: 3, unseen: 0, uidValidity: 1n });
  }

  mailboxDelete(path: string): Promise<void> {
    this.deleted.push(path);
    this.boxes = this.boxes.filter((b) => b.path !== path);
    return Promise.resolve();
  }

  mailboxRename(from: string, to: string): Promise<void> {
    this.renamed.push([from, to]);
    this.boxes = this.boxes.map((b) => (b.path === from ? { ...b, path: to } : b));
    return Promise.resolve();
  }
}

/** База настроек: помнит правила и все правки. */
class FakeDb {
  rules: FilterRule[];
  readonly patched: Array<{ id: number; folder: string | null; enabled: boolean | undefined }> = [];

  constructor(rules: FilterRule[]) {
    this.rules = rules;
  }

  listFilters(): Promise<FilterRule[]> {
    return Promise.resolve(this.rules);
  }

  updateFilter(
    _email: string,
    id: number,
    patch: { actions?: FilterActions; enabled?: boolean },
  ): Promise<FilterRule | null> {
    const rule = this.rules.find((r) => r.id === id) ?? null;
    if (!rule) return Promise.resolve(null);
    if (patch.actions) rule.actions = patch.actions;
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    this.patched.push({ id, folder: rule.actions.folder, enabled: patch.enabled });
    return Promise.resolve(rule);
  }
}

function rule(id: number, folder: string | null, extra: Partial<FilterActions> = {}): FilterRule {
  return {
    id,
    name: `Правило ${String(id)}`,
    position: id,
    enabled: true,
    auto: false,
    matchMode: 'all',
    conditions: [{ field: 'from', op: 'contains', value: 'вася@почта' }],
    actions: { ...DEFAULT_ACTIONS, folder, ...extra },
  };
}

interface Harness {
  app: FastifyInstance;
  client: FakeClient;
  db: FakeDb;
  synced: string[];
  folderId(path: string): string;
}

async function harness(rules: FilterRule[], boxes: FakeMailbox[] = MAILBOXES): Promise<Harness> {
  const client = new FakeClient(boxes);
  const db = new FakeDb(rules);
  const synced: string[] = [];

  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  registerErrorHandling(app);
  app.decorate('deps', {
    logger,
    pool: {
      withClient: <T>(_email: string, _password: string, fn: (c: ImapFlow) => Promise<T>) =>
        fn(client as unknown as ImapFlow),
    },
  } as unknown as FastifyInstance['deps']);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', (request: { mailSession: unknown }) => {
    request.mailSession = { id: 's', email: 'ivan@mail.true', password: 'secret' };
    return Promise.resolve();
  });
  app.decorate('settingsService', {
    available: true,
    requireDb: () => db,
    syncSieve: (email: string) => {
      synced.push(email);
      return Promise.resolve({ ok: true, written: true, error: '' });
    },
  } as unknown as FastifyInstance['settingsService']);
  app.decorate('recoveryService', {
    available: false,
    daysFor: () => Promise.resolve(0),
  } as unknown as FastifyInstance['recoveryService']);

  await app.register(folderManagementRoutes);
  await app.ready();

  const raw: RawFolderInfo[] = boxes.map((box) => {
    const parts = box.path.split('/');
    return {
      path: box.path,
      name: parts[parts.length - 1] ?? box.path,
      delimiter: '/',
      parentPath: parts.slice(0, -1).join('/'),
      ...(box.specialUse ? { specialUse: box.specialUse } : {}),
      flags: new Set<string>(),
    };
  });
  const mapped = mapFolders(raw);
  const folderId = (path: string): string => {
    const found = mapped.find((f) => f.path === path);
    assert.ok(found, `в подделке нет папки ${path}`);
    return found.id;
  };

  return { app, client, db, synced, folderId };
}

/* ------------------------------------------------------------------ */
/* Чистая функция переезда правил                                       */
/* ------------------------------------------------------------------ */

test('переименование папки уводит за собой правила — и родителя, и вложенных', () => {
  const patches = retargetFilterFolders(
    [rule(1, 'Работа'), rule(2, 'Работа/Счета'), rule(3, 'Личное')],
    'Работа',
    'Проекты',
    '/',
  );
  assert.deepEqual(patches, [
    { id: 1, folder: 'Проекты', disable: false },
    { id: 2, folder: 'Проекты/Счета', disable: false },
  ]);
});

test('удаление папки оставляет правило без приёмника, а пустое — выключает', () => {
  const patches = retargetFilterFolders(
    [rule(1, 'Работа'), rule(2, 'Работа/Счета', { markRead: true })],
    'Работа',
    null,
    '/',
  );
  // У первого правила действий больше не осталось — оно выключается, иначе
  // выглядело бы работающим и не делало ничего.
  assert.deepEqual(patches, [
    { id: 1, folder: null, disable: true },
    { id: 2, folder: null, disable: false },
  ]);
});

test('чужие папки не трогаются: «Работа» не начало «Работать»', () => {
  const patches = retargetFilterFolders([rule(1, 'Работать')], 'Работа', 'Проекты', '/');
  assert.deepEqual(patches, []);
});

/* ------------------------------------------------------------------ */
/* Маршруты                                                             */
/* ------------------------------------------------------------------ */

test('PATCH /folders/:id переписывает правила и файл Sieve', async () => {
  const h = await harness([rule(1, 'Работа'), rule(2, 'Работа/Счета')]);
  const response = await h.app.inject({
    method: 'PATCH',
    url: `/folders/${encodeURIComponent(h.folderId('Работа'))}`,
    payload: { name: 'Проекты' },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(h.client.renamed, [['Работа', 'Проекты']]);
  assert.equal(h.db.rules[0]?.actions.folder, 'Проекты', 'правило переехало вместе с папкой');
  assert.equal(h.db.rules[1]?.actions.folder, 'Проекты/Счета', 'вложенная папка тоже');
  assert.deepEqual(h.synced, ['ivan@mail.true'], 'файл правил переписан из базы');

  await h.app.close();
});

test('DELETE /folders/:id удаляет вложенные папки — как и обещано человеку', async () => {
  const h = await harness([rule(1, 'Работа/Счета')]);
  const response = await h.app.inject({
    method: 'DELETE',
    url: `/folders/${encodeURIComponent(h.folderId('Работа'))}`,
  });

  assert.equal(response.statusCode, 200, response.body);
  // Сначала вложенная, потом родитель: иначе ребёнка не назвать путём.
  assert.deepEqual(h.client.deleted, ['Работа/Счета', 'Работа']);
  assert.equal(h.db.rules[0]?.actions.folder, null, 'приёмника у правила больше нет');
  assert.equal(h.db.rules[0]?.enabled, false, 'делать правилу больше нечего');
  assert.deepEqual(h.synced, ['ivan@mail.true']);

  await h.app.close();
});

test('системная папка внутри своей не удаляется вместе с родителем', async () => {
  const h = await harness(
    [],
    [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Работа' },
      { path: 'Работа/Trash', specialUse: '\\Trash' },
    ],
  );
  const response = await h.app.inject({
    method: 'DELETE',
    url: `/folders/${encodeURIComponent(h.folderId('Работа'))}`,
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(h.client.deleted, [], 'ничего не удалено — ни родителя, ни детей');

  await h.app.close();
});
