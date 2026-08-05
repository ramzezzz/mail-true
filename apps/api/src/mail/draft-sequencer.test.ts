import assert from 'node:assert/strict';
import test from 'node:test';
import { DraftSequencer } from './draft-sequencer.js';

/** Подставной ящик черновиков: APPEND кладёт письмо, DELETE убирает. */
class FakeDraftsFolder {
  private nextUid = 10;
  readonly uids = new Set<number>();

  async append(): Promise<number> {
    // Задержка обязательна: без неё гонки просто не случится
    await new Promise((r) => setTimeout(r, 5));
    const uid = this.nextUid++;
    this.uids.add(uid);
    return uid;
  }

  async remove(uid: number): Promise<void> {
    await new Promise((r) => setTimeout(r, 1));
    this.uids.delete(uid);
  }
}

function saveOp(folder: FakeDraftsFolder) {
  return async (previousUid: number | undefined) => {
    const uid = await folder.append();
    if (previousUid !== undefined) await folder.remove(previousUid);
    return { uid, result: uid };
  };
}

/**
 * Главный случай. Пять одновременных сохранений одного черновика создавали
 * пять писем: каждое клало свою копию и пыталось удалить один и тот же
 * исходный UID, которого после первого раза уже не было. Ровно это даёт
 * таймер автосохранения вместе с явным «сохранить».
 */
test('пять одновременных сохранений одного черновика оставляют один черновик', async () => {
  const folder = new FakeDraftsFolder();
  const sequencer = new DraftSequencer();

  // Исходная версия черновика уже лежит в ящике
  const first = await sequencer.save('ящик', undefined, false, saveOp(folder));
  assert.equal(folder.uids.size, 1);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => sequencer.save('ящик', first, false, saveOp(folder)))
  );

  assert.equal(folder.uids.size, 1, `в папке осталось: ${[...folder.uids].join(', ')}`);
  // Уцелеть должна именно последняя записанная версия
  assert.equal(folder.uids.has(Math.max(...results)), true);
});

test('сохранения одного черновика не выполняются одновременно', async () => {
  const sequencer = new DraftSequencer();
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      sequencer.save('ящик', 10, false, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 2));
        inside -= 1;
        return { uid: 11, result: null };
      })
    )
  );
  assert.equal(maxInside, 1);
});

test('автосохранение нового письма с ключом окна не плодит копий', async () => {
  const folder = new FakeDraftsFolder();
  const sequencer = new DraftSequencer();

  // Ни у одного из пяти сохранений ещё нет UID — так и выглядит автосохранение
  // только что открытого окна написания
  await Promise.all(
    Array.from({ length: 5 }, () =>
      sequencer.save('ящик:окно-1', undefined, true, saveOp(folder))
    )
  );
  assert.equal(folder.uids.size, 1);
});

test('разные окна написания сохраняются независимо', async () => {
  const folder = new FakeDraftsFolder();
  const sequencer = new DraftSequencer();
  await Promise.all([
    sequencer.save('ящик:окно-1', undefined, true, saveOp(folder)),
    sequencer.save('ящик:окно-2', undefined, true, saveOp(folder)),
  ]);
  assert.equal(folder.uids.size, 2);
});

test('устаревший UID от клиента не мешает: удаляется актуальная версия', async () => {
  const folder = new FakeDraftsFolder();
  const sequencer = new DraftSequencer();

  const v1 = await sequencer.save('ящик', undefined, false, saveOp(folder));
  const v2 = await sequencer.save('ящик', v1, false, saveOp(folder));
  // Клиент ещё не узнал про v2 и присылает старый UID
  const v3 = await sequencer.save('ящик', v1, false, saveOp(folder));

  assert.deepEqual([...folder.uids], [v3]);
  assert.notEqual(v2, v3);
});

test('ошибка одного сохранения не ломает очередь следующих', async () => {
  const folder = new FakeDraftsFolder();
  const sequencer = new DraftSequencer();

  const failing = sequencer.save('ящик', undefined, false, async () => {
    throw new Error('IMAP отвалился');
  });
  const ok = sequencer.save('ящик', undefined, false, saveOp(folder));

  await assert.rejects(failing, /IMAP отвалился/);
  assert.equal(typeof (await ok), 'number');
  assert.equal(folder.uids.size, 1);
});

test('состояние окна забывается по таймауту', async () => {
  const folder = new FakeDraftsFolder();
  const sequencer = new DraftSequencer(5);
  await sequencer.save('ящик:окно', undefined, true, saveOp(folder));
  await new Promise((r) => setTimeout(r, 30));
  // Очередь про окно забыла — новое сохранение начинает с чистого листа
  await sequencer.save('ящик:окно', undefined, true, saveOp(folder));
  assert.equal(folder.uids.size, 2);
});
