/** Тесты файлового хранилища состояния (докачка). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, createStateStore, PgStateStore } from '../state.js';

describe('FileStateStore', () => {
  it('переживает перезапуск: записи читаются из журнала', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-state-'));
    const file = join(dir, 'state.jsonl');
    try {
      const store = new FileStateStore(file);
      await store.init();
      assert.equal(await store.wasMigrated('acc', 'INBOX', 'mid:1'), false);
      await store.markMigrated('acc', 'INBOX', 'mid:1');
      await store.setCursor('acc', 'INBOX', { uidValidity: '42', lastUid: 17 });
      await store.close();

      // «Перезапуск» — новый экземпляр с тем же файлом
      const store2 = new FileStateStore(file);
      await store2.init();
      assert.equal(await store2.wasMigrated('acc', 'INBOX', 'mid:1'), true);
      assert.equal(await store2.wasMigrated('acc', 'Sent', 'mid:1'), false);
      assert.deepEqual(await store2.getCursor('acc', 'INBOX'), {
        uidValidity: '42',
        lastUid: 17,
      });
      assert.equal(await store2.getCursor('acc', 'Другая'), null);
      await store2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('игнорирует оборванную последнюю строку журнала (сбой при записи)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-state-'));
    const file = join(dir, 'state.jsonl');
    try {
      const store = new FileStateStore(file);
      await store.init();
      await store.markMigrated('acc', 'INBOX', 'mid:1');
      await store.close();
      await appendFile(file, '{"t":"m","a":"acc","f":"INBOX","k":"mid:2', 'utf8'); // обрыв

      const store2 = new FileStateStore(file);
      await store2.init();
      assert.equal(await store2.wasMigrated('acc', 'INBOX', 'mid:1'), true);
      assert.equal(await store2.wasMigrated('acc', 'INBOX', 'mid:2'), false);
      await store2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createStateStore', () => {
  it('выбирает реализацию по префиксу', () => {
    assert.ok(createStateStore('file:/tmp/x.jsonl') instanceof FileStateStore);
    assert.ok(createStateStore('/tmp/x.jsonl') instanceof FileStateStore);
    const pgStore = createStateStore('pg:postgresql://u:p@localhost:5432/db');
    assert.ok(pgStore instanceof PgStateStore);
    void pgStore.close();
    const pgStore2 = createStateStore('postgresql://u:p@localhost:5432/db');
    assert.ok(pgStore2 instanceof PgStateStore);
    void pgStore2.close();
  });
});
