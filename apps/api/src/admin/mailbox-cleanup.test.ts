/**
 * Уборка почтового хранилища после удаления ящика.
 *
 * Проверяется то, ради чего всё это и делалось: после удаления каталог
 * не остаётся лежать под тем же именем (иначе повторно созданный ящик
 * с тем же адресом покажет чужую старую переписку), а место на диске
 * действительно освобождается — не «когда-нибудь», а проходом уборщика.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pino } from 'pino';
import type { AdminDb } from './db.js';
import { AdminJanitor } from './janitor.js';
import {
  findOrphanMaildirs,
  maildirPathOf,
  QUARANTINE_DIR,
  quarantineMaildir,
  removeTree,
  treeSize,
} from './mailbox-cleanup.js';

const logger = pino({ level: 'silent' });

async function seed(root: string, email: string, bytes = 4096): Promise<string> {
  const dir = maildirPathOf(root, email);
  assert.ok(dir);
  await mkdir(path.join(dir, 'cur'), { recursive: true });
  await writeFile(path.join(dir, 'cur', '1.mail'), 'x'.repeat(bytes));
  return dir;
}

void test('путь каталога ящика строится по правилу Dovecot и не выходит за корень', () => {
  assert.equal(maildirPathOf('/var/mail/vhosts', 'ivan@x.local'), '/var/mail/vhosts/x.local/ivan');
  assert.equal(maildirPathOf('/var/mail/vhosts', 'Ivan@X.Local'), '/var/mail/vhosts/x.local/ivan');
  // Ни одна часть адреса не должна уметь увести rm -rf в другое место.
  assert.equal(maildirPathOf('/var/mail/vhosts', '../../etc@x.local'), null);
  assert.equal(maildirPathOf('/var/mail/vhosts', 'ivan@../..'), null);
  assert.equal(maildirPathOf('/var/mail/vhosts', 'без-собаки'), null);
});

void test('карантин уводит каталог из-под нового ящика с тем же адресом', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-quar-'));
  const dir = await seed(root, 'gone@x.local');

  const result = await quarantineMaildir(root, 'gone@x.local', '42');

  assert.equal(result.existed, true);
  assert.equal(result.error, null);
  assert.ok(result.quarantinePath);
  // Старого пути больше нет — это и есть главное следствие исправления.
  await assert.rejects(stat(dir));
  // А содержимое цело: до прохода уборщика письма можно спасти.
  assert.ok((await treeSize(result.quarantinePath)) > 0);
  const inside = await readdir(path.join(root, 'x.local', QUARANTINE_DIR));
  assert.deepEqual(inside, ['gone.42']);
});

void test('карантин ящика, который ни разу не открывали, — не ошибка', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-quar-'));
  const result = await quarantineMaildir(root, 'never@x.local', '1');
  assert.equal(result.existed, false);
  assert.equal(result.quarantinePath, null);
  assert.equal(result.error, null);
});

void test('уборщик удаляет карантин и записывает освобождённое место', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-quar-'));
  await seed(root, 'gone@x.local', 10_000);
  const quarantined = await quarantineMaildir(root, 'gone@x.local', '7');
  assert.ok(quarantined.quarantinePath);

  const updates: Array<Record<string, unknown>> = [];
  const db = {
    listDeletionsToPurge: async () => [
      { id: 7, email: 'gone@x.local', quarantinePath: quarantined.quarantinePath },
    ],
    updateMailboxDeletion: async (_id: number, patch: Record<string, unknown>) => {
      updates.push(patch);
    },
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    listAllMailboxEmails: async () => [],
  };

  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger,
    mailRoot: root,
    intervalSeconds: 0,
  });
  const result = await janitor.runOnce();

  assert.equal(result.purgedMaildirs, 1);
  assert.ok(result.bytesFreed >= 10_000, 'освобождённое место должно быть посчитано');
  await assert.rejects(stat(quarantined.quarantinePath));
  assert.equal(updates[0]?.state, 'purged');
});

void test('уборщик находит осиротевшие каталоги, но сам их не трогает', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-orph-'));
  const living = await seed(root, 'alive@x.local');
  const orphan = await seed(root, 'orphan@x.local');

  const found = await findOrphanMaildirs(root, ['alive@x.local']);
  assert.deepEqual(found, ['orphan@x.local']);

  const db = {
    listDeletionsToPurge: async () => [],
    updateMailboxDeletion: async () => undefined,
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    listAllMailboxEmails: async () => ['alive@x.local'],
  };
  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger,
    mailRoot: root,
    intervalSeconds: 0,
  });
  const result = await janitor.runOnce();

  assert.equal(result.orphanMaildirs, 1);
  // Молча стирать чужую почту нельзя: каталог мог быть заведён руками.
  assert.ok((await stat(orphan)).isDirectory());
  assert.ok((await stat(living)).isDirectory());
});

void test('карантин не попадает в список осиротевших каталогов', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-orph-'));
  await seed(root, 'gone@x.local');
  await quarantineMaildir(root, 'gone@x.local', '3');
  assert.deepEqual(await findOrphanMaildirs(root, []), []);
});

void test('удаление дерева возвращает освобождённые байты', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-size-'));
  const dir = await seed(root, 'big@x.local', 20_000);
  const freed = await removeTree(dir);
  assert.ok(freed >= 20_000);
  await assert.rejects(stat(dir));
});
