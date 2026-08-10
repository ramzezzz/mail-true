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
      store.save(
        'test@mail.local',
        'big.bin',
        'application/octet-stream',
        failingStream(Buffer.alloc(4096), err),
      ),
      /too large/i,
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
      store.save(
        'test@mail.local',
        'big.bin',
        'application/octet-stream',
        truncatedStream(Buffer.alloc(4096)),
      ),
      (err: unknown) => {
        const e = err as { statusCode: number; code: string };
        assert.equal(e.statusCode, 413);
        assert.equal(e.code, 'FILE_TOO_LARGE');
        return true;
      },
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('обычная загрузка сохраняется и читается', async () => {
  const { store, dir } = await tempStore();
  try {
    const meta = await store.save(
      'test@mail.local',
      'файл.txt',
      'text/plain',
      Readable.from([Buffer.from('привет')]),
    );
    assert.equal(meta.filename, 'файл.txt');
    assert.equal(meta.size, Buffer.from('привет').length);
    const found = await store.get(meta.id, 'test@mail.local');
    assert.ok(found);
    await store.delete(meta.id);
    assert.equal(await store.get(meta.id, 'test@mail.local'), null);
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
    const meta = await store.save(
      'test@mail.local',
      'a.txt',
      'text/plain',
      Readable.from([Buffer.from('x')]),
    );
    assert.equal(await store.sweep(24 * 3600 * 1000), 0, 'свежую загрузку трогать нельзя');
    assert.equal(await store.sweep(-1), 1);
    assert.equal(await store.get(meta.id, 'test@mail.local'), null);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/*
 * Владельца у загрузки не было вовсе: файл лежал под случайным именем, и
 * любой вошедший, назвав чужой идентификатор, прикладывал чужое вложение
 * к своему письму. Идентификатор секретом не является — он уходит в
 * ответ, живёт в черновике и в журналах.
 */
test('чужая загрузка для другого ящика не существует', async () => {
  const { store, dir } = await tempStore();
  try {
    const meta = await store.save(
      'anna@mail.local',
      'зарплата.pdf',
      'application/pdf',
      Readable.from([Buffer.from('тайна')]),
    );
    assert.ok(await store.get(meta.id, 'anna@mail.local'), 'свой файл должен быть виден');
    // Именно null, а не отказ: по разнице ответов чужие идентификаторы
    // можно было бы перебирать.
    assert.equal(await store.get(meta.id, 'petr@mail.local'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('занятое место считается по ящику, а не по всему каталогу', async () => {
  const { store, dir } = await tempStore();
  try {
    await store.save(
      'anna@mail.local',
      'a.bin',
      'application/octet-stream',
      Readable.from([Buffer.alloc(1000)]),
    );
    await store.save(
      'anna@mail.local',
      'b.bin',
      'application/octet-stream',
      Readable.from([Buffer.alloc(500)]),
    );
    await store.save(
      'petr@mail.local',
      'c.bin',
      'application/octet-stream',
      Readable.from([Buffer.alloc(9000)]),
    );
    assert.equal(await store.usedBy('anna@mail.local'), 1500);
    assert.equal(await store.usedBy('petr@mail.local'), 9000);
    // Ящик без загрузок не должен ничего наследовать от соседей.
    assert.equal(await store.usedBy('nikto@mail.local'), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('одновременные продления срока не портят метаданные друг другу', async () => {
  /*
   * Временный файл записи был ОДИН на все продления сразу. Два вызова на
   * одну картинку — соседняя вкладка сохраняет тот же черновик,
   * автосохранение налезает на отправку — и второй обрезал недописанный
   * файл первого, а неудачник в довершение сносил чужой временный файл.
   * Итог: битая мета, которую разбор не читает.
   */
  const { store, dir } = await tempStore();
  try {
    const meta = await store.save(
      'test@mail.local',
      'фото.png',
      'image/png',
      Readable.from('байты'),
    );

    await Promise.all(Array.from({ length: 12 }, () => store.touch(meta.id)));

    const found = await store.get(meta.id, 'test@mail.local');
    assert.notEqual(found, null, 'метаданные не читаются — запись побилась');
    assert.equal(found?.meta.filename, 'фото.png');
    assert.ok((found?.meta.usedAt ?? 0) >= meta.createdAt, 'срок не продлён');

    // И ни одного временного файла за собой
    const left = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(left, [], 'временные файлы остались лежать');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('уборщик не трогает временный файл, который пишется прямо сейчас', async () => {
  /*
   * Уборщик ходит раз в час и запросто попадёт в середину чужой записи.
   * Снеся свежий временный файл, он ломает продление срока: rename
   * упирается в исчезнувший файл, и картинка умирает на сутки раньше.
   */
  const { store, dir } = await tempStore();
  try {
    const meta = await store.save(
      'test@mail.local',
      'фото.png',
      'image/png',
      Readable.from('байты'),
    );
    const fresh = join(dir, `${meta.id}.json.${'0'.repeat(8)}.tmp`);
    await writeFile(fresh, '{}', 'utf8');

    await store.sweep();
    const after = await readdir(dir);
    assert.ok(
      after.some((n) => n.endsWith('.tmp')),
      'свежий временный файл унесли; в каталоге: ' + after.join(', '),
    );

    // А старый — уносит
    const old = Date.now() / 1000 - 3 * 3600;
    await utimes(fresh, old, old);
    await store.sweep();
    const swept = await readdir(dir);
    assert.ok(
      !swept.some((n) => n.endsWith('.tmp')),
      'старый временный файл остался лежать: ' + swept.join(', '),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
