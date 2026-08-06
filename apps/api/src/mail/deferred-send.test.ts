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
  DEFAULT_UNDO_SEND_SECONDS,
  DeferredSender,
  DeferredSpool,
  normalizeUndoSeconds,
  readFailureFromRaw,
  readFailureHeader,
  withFailureHeader,
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

/* ------------------------------------------------------------------ */
/* Отмена отправки: та же очередь с малым сроком                        */
/* ------------------------------------------------------------------ */

test('срок отмены: только перечисленное в настройках, всё остальное — «выключено»', () => {
  assert.equal(normalizeUndoSeconds(0), 0);
  assert.equal(normalizeUndoSeconds(5), 5);
  assert.equal(normalizeUndoSeconds(10), 10);
  assert.equal(normalizeUndoSeconds(30), 30);

  // Обратный ход: непонятное значение НЕ превращается в умолчание.
  // Задержать чужое письмо из-за мусора в настройке нельзя — этого
  // поведения человек не выбирал.
  assert.equal(normalizeUndoSeconds(3600), 0, 'час задержки настройкой не задаётся');
  assert.equal(normalizeUndoSeconds(7), 0);
  assert.equal(normalizeUndoSeconds(-5), 0);
  assert.equal(normalizeUndoSeconds('5'), 0, 'строка — не число секунд');
  assert.equal(normalizeUndoSeconds(null), 0);
  assert.equal(normalizeUndoSeconds(undefined), 0);
  assert.equal(DEFAULT_UNDO_SEND_SECONDS, 5);
});

test('замок: письмо, взятое в работу, отменить уже нельзя', async () => {
  const { spool, dir } = await tempSpool();
  const sender = new DeferredSender({
    spool,
    deliver: async () => 'sent',
    onGiveUp: async () => undefined,
  });
  try {
    const added = await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('тело'));

    // Работник взял письмо — отмена обязана получить отказ, иначе она
    // стёрла бы запись уже ПОСЛЕ того, как письмо ушло получателю,
    // и человеку сказали бы «отменено» о письме, которое у адресата
    assert.equal(sender.claim(added.id), true, 'первый захват должен удаться');
    assert.equal(sender.claim(added.id), false, 'второй — нет');

    // Обратный ход: отпущенное письмо снова можно взять
    sender.release(added.id);
    assert.equal(sender.claim(added.id), true);
  } finally {
    sender.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('отменённое письмо работник не отправляет, даже если уже наметил его к отправке', async () => {
  const { spool, dir } = await tempSpool();
  const sentTo: string[] = [];
  const sender = new DeferredSender({
    spool,
    deliver: async (e: DeferredEntry): Promise<DeliveryOutcome> => {
      sentTo.push(e.id);
      return 'sent';
    },
    onGiveUp: async () => undefined,
  });
  try {
    const first = await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('первое'));
    const second = await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('второе'));

    // Список «кому пора» работник собирает один раз, а отправляет по
    // очереди. Отмена приходит, когда первое письмо уже ушло, а второе
    // ещё лежит: снятое с очереди уходить не должно.
    await spool.remove(second.id);
    const sent = await sender.tick(new Date('2026-08-06T09:00:01.000Z'));

    assert.deepEqual(sentTo, [first.id]);
    assert.equal(sent, 1);
    assert.deepEqual(await readdir(dir), [], 'очередь должна опустеть');
  } finally {
    sender.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('будильник забирает письмо в свой срок, а не через полминуты общего обхода', async () => {
  const { spool, dir } = await tempSpool();
  const sentIds: string[] = [];
  const sender = new DeferredSender({
    spool,
    deliver: async (e: DeferredEntry): Promise<DeliveryOutcome> => {
      sentIds.push(e.id);
      return 'sent';
    },
    onGiveUp: async () => undefined,
  });
  try {
    const at = new Date(Date.now() + 120);
    const added = await spool.add(entry(at.toISOString()), Buffer.from('тело'));
    // Общий обход ходит раз в полминуты — на него здесь надеяться нельзя
    sender.start(30_000);

    // Обратный ход СНАЧАЛА: без будильника за это время не уходит ничего,
    // то есть проверка ниже действительно проверяет будильник, а не общий
    // обход, случайно совпавший по времени
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(sentIds.length, 0, 'без будильника письмо ждёт общего обхода');
    assert.notEqual(await spool.get(added.id), null);

    sender.wakeAt(at);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(sentIds, [added.id], 'письмо обязано уйти по будильнику');
  } finally {
    sender.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Извещения о том, что письмо не ушло                                 */
/* ------------------------------------------------------------------ */

function notice(owner: string, subject: string) {
  return {
    owner,
    subject,
    envelopeTo: ['to@mail.local'],
    reason: 'Почтовый сервер получателя недоступен',
    rejected: [{ address: 'to@mail.local', message: '550 User unknown' }],
    attempts: 5,
    lastAttemptAt: '2026-08-06T09:00:00.000Z',
    draftUid: 42,
  };
}

test('извещение переживает перезапуск процесса и не путается с письмами очереди', async () => {
  const { spool, dir } = await tempSpool();
  try {
    const added = await spool.addFailure(notice('test@mail.local', 'Не ушло'));
    await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('тело'));

    // Новый экземпляр — то же, что перезапуск сервера. Извещение обязано
    // дождаться человека: вкладку он закрыл, а узнать всё равно должен.
    const afterRestart = new DeferredSpool(dir);
    const found = await afterRestart.failures('test@mail.local');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, added.id);
    assert.equal(found[0]?.reason, 'Почтовый сервер получателя недоступен');
    assert.equal(found[0]?.draftUid, 42);

    // Обратный ход: обход очереди извещение за письмо не принимает —
    // иначе работник вечно пытался бы «отправить» его
    const due = await afterRestart.all();
    assert.equal(due.length, 1);
    assert.equal(due[0]?.subject, 'Отложенное письмо');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('чужое извещение не показывается и не убирается', async () => {
  const { spool, dir } = await tempSpool();
  try {
    const mine = await spool.addFailure(notice('test@mail.local', 'Моё'));
    const foreign = await spool.addFailure(notice('сосед@mail.local', 'Чужое'));

    assert.deepEqual(
      (await spool.failures('test@mail.local')).map((n) => n.subject),
      ['Моё'],
      'в теме и адресах чужого письма нам делать нечего',
    );

    // Даже по угаданному идентификатору
    assert.equal(await spool.removeFailure('test@mail.local', foreign.id), false);
    assert.equal((await spool.failures('сосед@mail.local')).length, 1);

    // Обратный ход: своё убирается
    assert.equal(await spool.removeFailure('test@mail.local', mine.id), true);
    assert.deepEqual(await spool.failures('test@mail.local'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('причина едет с черновиком заголовком и читается обратно', () => {
  const reason = {
    reason: 'Почтовый сервер получателя не отвечает',
    rejected: [{ address: 'нет@несуществующий.домен', message: '550 «не найден»' }],
    attempts: 5,
    lastAttemptAt: '2026-08-06T09:00:00.000Z',
    envelopeTo: ['нет@несуществующий.домен'],
  };
  const raw = Buffer.from('Subject: Тест\r\nTo: x@y.z\r\n\r\nтело письма', 'utf8');
  const marked = withFailureHeader(raw, reason);

  // Исходник письма не тронут: человек отправит ровно то, что писал
  assert.equal(marked.subarray(marked.length - raw.length).equals(raw), true);
  assert.deepEqual(readFailureFromRaw(marked), reason);

  // Кириллица и кавычки переживают оборот — заголовок остаётся ASCII
  assert.match(
    marked.subarray(0, marked.indexOf('\r\n')).toString('ascii'),
    /^X-Mail-True-Send-Failure: [A-Za-z0-9+/=]+$/,
  );

  // Обратный ход: обычный черновик никакой причины не несёт
  assert.equal(readFailureFromRaw(raw), null);
  // И тело письма со словом-двойником в тексте её не подделывает
  assert.equal(
    readFailureFromRaw(
      Buffer.from('Subject: X\r\n\r\nX-Mail-True-Send-Failure: подделка', 'utf8'),
    ),
    null,
    'заголовок ищется только в блоке заголовков, а не в теле',
  );
});

test('испорченный заголовок причины не роняет открытие черновика', () => {
  assert.equal(readFailureHeader('не base64 вовсе'), null);
  assert.equal(readFailureHeader(''), null);
  assert.equal(readFailureHeader(undefined), null);
  // base64 есть, а JSON внутри не наш
  assert.equal(readFailureHeader(Buffer.from('{"что-то":1}').toString('base64')), null);
});
