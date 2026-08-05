/**
 * Очередь отложенной отправки.
 *
 * Главное требование к ней — письмо уходит, даже если браузер закрыт и
 * сервер за это время перезапускался. Поэтому проверяется не «таймер
 * сработал», а то, что письмо ЛЕЖИТ НА ДИСКЕ и его берёт оттуда новый,
 * ничего не помнящий работник.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkSendAt,
  DeferredSender,
  DeferredSpool,
  type DeferredEntry,
  type DeliveryOutcome,
} from './deferred-send.js';

async function tempSpool(): Promise<{ spool: DeferredSpool; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-deferred-'));
  return { spool: new DeferredSpool(dir), dir };
}

function entry(sendAt: string): Omit<DeferredEntry, 'id' | 'attempts' | 'createdAt'> {
  return {
    owner: 'test@mail.local',
    passwordEnc: 'зашифрованный-пароль',
    sendAt,
    envelopeTo: ['to@mail.local'],
    subject: 'Отложенное письмо',
  };
}

test('письмо лежит на диске и переживает перезапуск процесса', async () => {
  const { spool, dir } = await tempSpool();
  try {
    const added = await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('Subject: X\r\n\r\nтело'));

    // Новый экземпляр — ровно то, что происходит после перезапуска сервера:
    // ничего в памяти не осталось, всё берётся из каталога очереди
    const afterRestart = new DeferredSpool(dir);
    const found = await afterRestart.get(added.id);
    assert.equal(found?.subject, 'Отложенное письмо');
    assert.equal((await afterRestart.raw(added.id))?.toString('utf8'), 'Subject: X\r\n\r\nтело');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('пора уходить только тем, чей срок наступил', async () => {
  const { spool, dir } = await tempSpool();
  try {
    const soon = await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('a'));
    await spool.add(entry('2026-08-07T09:00:00.000Z'), Buffer.from('b'));

    const due = await spool.due(new Date('2026-08-06T09:00:01.000Z'));
    assert.deepEqual(
      due.map((e) => e.id),
      [soon.id],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('отправленное письмо уходит из очереди и второй раз не отправляется', async () => {
  const { spool, dir } = await tempSpool();
  try {
    await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('письмо'));
    const delivered: string[] = [];
    const sender = new DeferredSender({
      spool,
      deliver: async (e) => {
        delivered.push(e.id);
        return 'sent';
      },
      onGiveUp: async () => undefined,
    });

    const now = new Date('2026-08-06T09:05:00.000Z');
    assert.equal(await sender.tick(now), 1);
    // Второй проход не должен найти ничего: иначе получатель получил бы
    // одно и то же письмо столько раз, сколько работник просыпался
    assert.equal(await sender.tick(now), 0);
    assert.equal(delivered.length, 1);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('временный отказ оставляет письмо в очереди и считает попытки', async () => {
  const { spool, dir } = await tempSpool();
  try {
    const added = await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('письмо'));
    let outcome: DeliveryOutcome = 'retry';
    const sender = new DeferredSender({
      spool,
      deliver: async () => outcome,
      onGiveUp: async () => undefined,
      maxAttempts: 5,
    });

    const now = new Date('2026-08-06T09:05:00.000Z');
    await sender.tick(now);
    assert.equal((await spool.get(added.id))?.attempts, 1, 'письмо должно остаться в очереди');

    outcome = 'sent';
    assert.equal(await sender.tick(now), 1);
    assert.equal(await spool.get(added.id), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('окончательный отказ не выбрасывает написанное, а отдаёт его в черновики', async () => {
  const { spool, dir } = await tempSpool();
  try {
    await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('текст, который нельзя терять'));
    const kept: string[] = [];
    const sender = new DeferredSender({
      spool,
      deliver: async () => 'failed',
      onGiveUp: async (_e, raw) => {
        kept.push(raw.toString('utf8'));
      },
    });

    await sender.tick(new Date('2026-08-06T09:05:00.000Z'));
    assert.deepEqual(kept, ['текст, который нельзя терять']);
    assert.deepEqual(await readdir(dir), [], 'из очереди письмо убирается');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('после исчерпания попыток письмо тоже уходит в черновики', async () => {
  const { spool, dir } = await tempSpool();
  try {
    await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('письмо'));
    let kept = 0;
    const sender = new DeferredSender({
      spool,
      deliver: async () => 'retry',
      onGiveUp: async () => {
        kept += 1;
      },
      maxAttempts: 3,
    });

    const now = new Date('2026-08-06T09:05:00.000Z');
    await sender.tick(now);
    await sender.tick(now);
    assert.equal(kept, 0, 'пока попытки не кончились, письмо остаётся в очереди');
    await sender.tick(now);
    assert.equal(kept, 1);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('исключение при отправке считается временной бедой, а не потерей письма', async () => {
  const { spool, dir } = await tempSpool();
  try {
    const added = await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('письмо'));
    const sender = new DeferredSender({
      spool,
      deliver: async () => {
        throw new Error('сеть отвалилась');
      },
      onGiveUp: async () => undefined,
    });
    await sender.tick(new Date('2026-08-06T09:05:00.000Z'));
    assert.equal((await spool.get(added.id))?.attempts, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('время отправки: «сейчас», «позже» и заведомо неверное', () => {
  const now = new Date('2026-08-06T09:00:00.000Z');
  assert.deepEqual(checkSendAt(undefined, now), { kind: 'now' });
  // Меньше минуты — это «отправить сейчас», очередь ради такого не нужна
  assert.deepEqual(checkSendAt('2026-08-06T09:00:30.000Z', now), { kind: 'now' });
  assert.deepEqual(checkSendAt('2026-08-06T08:00:00.000Z', now), { kind: 'now' });

  const later = checkSendAt('2026-08-06T18:00:00.000Z', now);
  assert.equal(later.kind, 'later');

  assert.equal(checkSendAt('не дата', now).kind, 'invalid');
  assert.equal(checkSendAt('2030-01-01T00:00:00.000Z', now).kind, 'invalid');
});

test('дальний край отсрочки — тридцать суток, и дело в пароле', () => {
  // Пароль ящика лежит в конверте зашифрованным ровно до отправки. Чем
  // дальше край, тем дольше он лежит — а письмо, отложенное на год, почти
  // наверняка не уйдёт: за год пароль сменят, а то и ящик закроют.
  const now = new Date('2026-08-06T09:00:00.000Z');
  const at = (days: number) =>
    new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString();

  assert.equal(checkSendAt(at(29), now).kind, 'later', '29 суток — в пределах');
  assert.equal(checkSendAt(at(31), now).kind, 'invalid', '31 сутки — уже нет');

  const refused = checkSendAt(at(200), now);
  assert.equal(refused.kind, 'invalid');
  assert.match(
    refused.kind === 'invalid' ? refused.reason : '',
    /30 суток/,
    'отказ обязан называть предел, иначе человек будет подбирать дату наугад',
  );
});
