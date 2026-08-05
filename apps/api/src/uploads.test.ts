import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { UploadStore } from './uploads.js';

async function tempStore(): Promise<{ store: UploadStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-uploads-'));
  const store = new UploadStore(dir);
  await store.init();
  return { store, dir };
}

/** Поток, который отдаёт кусок данных и падает — так ведёт себя @fastify/multipart
 * при срабатывании limits.fileSize (ошибка FST_REQ_FILE_TOO_LARGE). */
function failingStream(chunk: Buffer, err: Error): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(chunk);
      } else {
        this.destroy(err);
      }
    },
  });
}

/** Поток, обрезанный по лимиту без ошибки (throwFileSizeLimit: false). */
function truncatedStream(chunk: Buffer): Readable {
  const stream = Readable.from([chunk]) as Readable & { truncated?: boolean };
  stream.truncated = true;
  return stream;
}

/**
 * Главный случай. Файл писался на диск до тех пор, пока не срабатывало
 * ограничение размера; дальше поток падал, метаданные не создавались — и
 * недописанный `.bin` оставался лежать НАВСЕГДА: уборщик обходил только
 * `.json`. Три отклонённых запроса по 27 МБ добавляли 78 МБ мусора.
 */
test('отклонённая загрузка не оставляет файл на диске', async () => {
  const { store, dir } = await tempStore();
  try {
    const err = Object.assign(new Error('request file too large'), {
      code: 'FST_REQ_FILE_TOO_LARGE',
    });
    await assert.rejects(
      store.save('big.bin', 'application/octet-stream', failingStream(Buffer.alloc(4096), err)),
      /too large/i
    );
    assert.deepEqual(await readdir(dir), [], 'каталог загрузок должен остаться пустым');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('обрезанная по лимиту загрузка отклоняется, а не сохраняется молча', async () => {
  const { store, dir } = await tempStore();
  try {
    await assert.rejects(
      store.save('big.bin', 'application/octet-stream', truncatedStream(Buffer.alloc(4096))),
      (err: unknown) => {
        const e = err as { statusCode: number; code: string };
        assert.equal(e.statusCode, 413);
        assert.equal(e.code, 'FILE_TOO_LARGE');
        return true;
      }
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('обычная загрузка сохраняется и читается', async () => {
  const { store, dir } = await tempStore();
  try {
    const meta = await store.save('файл.txt', 'text/plain', Readable.from([Buffer.from('привет')]));
    assert.equal(meta.filename, 'файл.txt');
    assert.equal(meta.size, Buffer.from('привет').length);
    const found = await store.get(meta.id);
    assert.ok(found);
    await store.delete(meta.id);
    assert.equal(await store.get(meta.id), null);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('уборщик удаляет .bin, оставшийся без метаданных', async () => {
  const { store, dir } = await tempStore();
  try {
    const orphan = join(dir, '00000000-0000-0000-0000-000000000001.bin');
    await writeFile(orphan, Buffer.alloc(1024));
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    await utimes(orphan, old, old);

    const removed = await store.sweep();
    assert.equal(removed, 1);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('уборщик не трогает загрузку, которая прямо сейчас идёт', async () => {
  const { store, dir } = await tempStore();
  try {
    const fresh = join(dir, '00000000-0000-0000-0000-000000000002.bin');
    await writeFile(fresh, Buffer.alloc(16));
    assert.equal(await store.sweep(), 0);
    assert.deepEqual(await readdir(dir), ['00000000-0000-0000-0000-000000000002.bin']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('уборщик удаляет просроченные загрузки вместе с метаданными', async () => {
  const { store, dir } = await tempStore();
  try {
    const meta = await store.save('a.txt', 'text/plain', Readable.from([Buffer.from('x')]));
    assert.equal(await store.sweep(24 * 3600 * 1000), 0, 'свежую загрузку трогать нельзя');
    assert.equal(await store.sweep(-1), 1);
    assert.equal(await store.get(meta.id), null);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
