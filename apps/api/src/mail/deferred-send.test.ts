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
  retryDelayMs,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  withFailureHeader,
  type DeferredEntry,
  type DeliveryOutcome,
} from './deferred-send.js';

/** Момент, когда письму снова пора: срок отката плюс запас. */
function afterBackoff(from: Date, attempts: number): Date {
  return new Date(from.getTime() + retryDelayMs(attempts) + 1000);
}

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
    const added = await spool.add(
      entry('2026-08-06T09:00:00.000Z'),
      Buffer.from('Subject: X\r\n\r\nтело'),
    );

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
    // Ждём отката: сразу после неудачи письмо намеренно не «пора отправлять»
    assert.equal(await sender.tick(afterBackoff(now, 1)), 1);
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

    // Каждая следующая попытка — после отката (см. retryDelayMs), поэтому
    // время между проходами идёт вперёд: одним обходом попытки не сгорают
    let now = new Date('2026-08-06T09:05:00.000Z');
    await sender.tick(now);
    now = afterBackoff(now, 1);
    await sender.tick(now);
    assert.equal(kept, 0, 'пока попытки не кончились, письмо остаётся в очереди');
    now = afterBackoff(now, 2);
    await sender.tick(now);
    assert.equal(kept, 1);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('уборка в черновики не удалась — письмо остаётся в очереди, а не исчезает', async () => {
  /*
   * Самая дорогая из ошибок этого файла, и она была тихой.
   *
   * Раньше здесь стояло `onGiveUp(...).catch(() => undefined)` и сразу
   * `remove()`: отказ уборки проглатывался, письмо стиралось с диска, а в
   * журнал уходило «сохранено в черновиках» — то есть неправда.
   *
   * Достижимо это не в теории: onGiveUp начинается с расшифровки пароля
   * из конверта, и после смены SESSION_SECRET (плановая ротация, перенос
   * установки, восстановление тома) расшифровка бросает на первой же
   * строке — до того, как хоть что-то сделано.
   */
  const { spool, dir } = await tempSpool();
  try {
    await spool.add(
      entry('2026-08-06T09:00:00.000Z'),
      Buffer.from('письмо, которое нельзя терять'),
    );
    const sender = new DeferredSender({
      spool,
      deliver: async () => 'failed',
      onGiveUp: async () => {
        throw new Error('расшифровать пароль нечем: секрет сессий сменили');
      },
    });

    await sender.tick(new Date('2026-08-06T09:05:00.000Z'));

    const left = await spool.all();
    assert.equal(left.length, 1, 'письмо стёрто, хотя убрать его в черновики не удалось');
    const raw = await spool.raw(left[0]!.id);
    assert.equal(
      raw?.toString('utf8'),
      'письмо, которое нельзя терять',
      'тело письма обязано остаться нетронутым',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('письмо, которое не удалось убрать в черновики, второй раз не отправляется', async () => {
  /*
   * САМАЯ ДОРОГАЯ ИЗ ОШИБОК ЭТОГО ОБХОДА, И ОНА РАССЫЛАЛА ПИСЬМА.
   *
   * Письмо, которое не удалось положить в «Черновики» (переполненный ящик,
   * сменившийся пароль, пропавшая папка), намеренно остаётся в очереди —
   * иначе оно исчезло бы совсем. Но срок отправки у него в прошлом, а
   * проверки «на это письмо уже поставлен крест» перед вызовом deliver не
   * было вовсе: работник отдавал его SMTP на КАЖДОМ обходе, то есть раз
   * в полминуты, бесконечно.
   *
   * Что видел человек: извещение «письмо не отправлено», он писал и
   * отправлял заново — а получатель тем временем собирал копию исходного
   * каждые полминуты.
   */
  const { spool, dir } = await tempSpool();
  try {
    await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('письмо'));
    let delivered = 0;
    const sender = new DeferredSender({
      spool,
      deliver: async () => {
        delivered += 1;
        return 'failed';
      },
      onGiveUp: async () => {
        throw new Error('ящик не принял письмо: кончилось место');
      },
    });

    await sender.tick(new Date('2026-08-06T09:05:00.000Z'));
    assert.equal(delivered, 1);
    assert.equal((await spool.all()).length, 1, 'письмо обязано остаться в очереди');

    // Обходов дальше сколько угодно — почтовому серверу письмо больше не
    // отдают ни разу. Повторяется только попытка УБОРКИ.
    await sender.tick(new Date('2026-08-06T09:35:00.000Z'));
    await sender.tick(new Date('2026-08-06T10:05:00.000Z'));
    assert.equal(delivered, 1, 'письмо ушло получателю ещё раз — и не один');
    assert.equal((await spool.all()).length, 1);

    // Крест лежит в конверте, а не в памяти: перезапуск сервера не должен
    // возобновлять рассылку сам собой
    const afterRestart = new DeferredSpool(dir);
    assert.equal((await afterRestart.all())[0]?.gaveUp, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('исчерпанные попытки тоже не дают отправить письмо ещё раз', async () => {
  const { spool, dir } = await tempSpool();
  try {
    await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('письмо'));
    let delivered = 0;
    const sender = new DeferredSender({
      spool,
      deliver: async () => {
        delivered += 1;
        return 'retry';
      },
      onGiveUp: async () => {
        throw new Error('ящик не принял письмо');
      },
      maxAttempts: 2,
    });

    let now = new Date('2026-08-06T09:05:00.000Z');
    await sender.tick(now);
    now = afterBackoff(now, 1);
    await sender.tick(now);
    assert.equal(delivered, 2, 'обе попытки должны были состояться');

    // Попытки кончились, уборка не удалась — письмо лежит. Отправлять его
    // больше нельзя ни на этом обходе, ни на следующем.
    now = afterBackoff(now, 2);
    await sender.tick(now);
    await sender.tick(afterBackoff(now, 3));
    assert.equal(delivered, 2, 'письмо отдали SMTP после того, как попытки кончились');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('между попытками есть откат — иначе пять попыток сгорают за секунды', async () => {
  /*
   * ЧТО БЫЛО. Неудачная попытка увеличивала счётчик и НЕ трогала срок:
   * письмо оставалось «пора отправлять» и бралось следующим же обходом.
   * А обход ходит не только раз в полминуты — на каждую отправку с отменой
   * ставится внеочередной будильник, и он будит работника со всей очередью
   * сразу.
   *
   * Чего это стоило: перезапуск Postfix из панели (штатное действие, сорок
   * секунд) превращал ВСЮ очередь в неудавшиеся черновики с извещениями
   * «письмо не отправлено» — включая отложенные «на понедельник, 9:00»,
   * до которых оставались сутки.
   */
  const { spool, dir } = await tempSpool();
  try {
    const added = await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('письмо'));
    let delivered = 0;
    const sender = new DeferredSender({
      spool,
      deliver: async () => {
        delivered += 1;
        return 'retry';
      },
      onGiveUp: async () => undefined,
      maxAttempts: 5,
    });

    const start = new Date('2026-08-06T09:05:00.000Z');
    await sender.tick(start);
    assert.equal(delivered, 1);

    // Сорок секунд перезапуска почтового сервера — это ОДНА неудачная
    // попытка, а не все пять. Сколько бы раз работника ни будили в эти
    // секунды, письмо он не трогает.
    for (const seconds of [1, 5, 20, 40]) {
      await sender.tick(new Date(start.getTime() + seconds * 1000));
    }
    assert.equal(delivered, 1, 'все попытки сгорели, пока служба перезапускалась');

    const waiting = await spool.get(added.id);
    assert.equal(waiting?.attempts, 1);
    assert.equal(
      Date.parse(waiting?.sendAt ?? '') - start.getTime(),
      retryDelayMs(1),
      'срок следующей попытки не назначен — письмо снова «пора отправлять»',
    );

    // Обратный ход: откат кончился — попытка состоялась
    await sender.tick(afterBackoff(start, 1));
    assert.equal(delivered, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('откат растёт вдвое и упирается в потолок', () => {
  // Минута, две, четыре, восемь: пятая попытка приходится примерно на
  // пятнадцатую минуту — столько живёт и перезапуск служб, и обновление
  // продукта, и короткий обрыв связи.
  assert.equal(retryDelayMs(1), RETRY_BASE_DELAY_MS);
  assert.equal(retryDelayMs(2), RETRY_BASE_DELAY_MS * 2);
  assert.equal(retryDelayMs(3), RETRY_BASE_DELAY_MS * 4);
  assert.equal(retryDelayMs(4), RETRY_BASE_DELAY_MS * 8);
  // Потолок: ждать сутками бессмысленно — письмо к тому времени уже
  // неактуально, и человеку полезнее получить его обратно в «Черновики»
  assert.equal(retryDelayMs(20), RETRY_MAX_DELAY_MS);
  assert.equal(retryDelayMs(1000), RETRY_MAX_DELAY_MS);
  // Мусор на входе не должен превращаться в «отправить прямо сейчас»
  assert.equal(retryDelayMs(0), RETRY_BASE_DELAY_MS);
  assert.equal(retryDelayMs(-3), RETRY_BASE_DELAY_MS);
});

test('отметка попытки переживает обрыв: конверт не остаётся обрезанным', async () => {
  /*
   * Инвариант из шапки файла: наличие `.json` значит «запись целая».
   * Отметка попытки была единственным местом, где конверт переписывался
   * ПОВЕРХ, без временного имени. Пропадание питания посреди записи
   * оставляло обрезанный файл: `all()` такую запись пропускает — письмо
   * не ушло бы никогда, а тело осталось бы лежать в очереди навсегда.
   *
   * Проверяем результат, а не способ: после отметки запись обязана
   * читаться целиком и хранить увеличенный счётчик.
   */
  const { spool, dir } = await tempSpool();
  try {
    await spool.add(entry('2026-08-06T09:00:00.000Z'), Buffer.from('письмо'));
    const [before] = await spool.all();
    assert.ok(before);

    const attempts = await spool.bumpAttempt(before.id);
    assert.equal(attempts, 1);

    const after = await spool.get(before.id);
    assert.ok(after, 'конверт после отметки попытки не читается — запись обрезана');
    assert.equal(after.attempts, 1);
    assert.equal(after.owner, before.owner, 'при перезаписи потерялись поля конверта');
    // Временных файлов после себя не оставляем: они попадут в all() как
    // мусор и будут висеть в очереди вечно.
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
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
  const at = (days: number) => new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString();

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
    readFailureFromRaw(Buffer.from('Subject: X\r\n\r\nX-Mail-True-Send-Failure: подделка', 'utf8')),
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
