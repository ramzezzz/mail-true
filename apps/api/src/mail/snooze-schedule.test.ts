/**
 * Сроки возврата отложенного письма.
 *
 * Проверяется главное обещание раздела: «завтра утром» — это утро ЧЕЛОВЕКА.
 * Сервер стоит в UTC, и без учёта пояса письмо, отложенное вечером в
 * Иркутске, возвращалось бы среди ночи; отложенное днём в Лос-Анджелесе —
 * накануне вечером.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SNOOZE_MAX_DELAY_MS,
  SNOOZE_MORNING_HOUR,
  checkSnoozeRequest,
  fromZonedWallClock,
  presetWakeTime,
  usableZone,
  zonedParts,
} from './snooze-schedule.js';

/** Стенные часы момента в поясе — тем же способом, каким их читает продукт. */
function wallClock(at: Date, zone: string): string {
  const p = zonedParts(at, zone);
  assert.ok(p, `пояс ${zone} не разобран`);
  return (
    `${String(p.year)}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ` +
    `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  );
}

test('«завтра утром» — это восемь утра в поясе человека, а не сервера', () => {
  // 21:30 по Москве 5 августа 2026 — это ещё 18:30 UTC того же дня.
  const now = new Date('2026-08-05T18:30:00Z');

  const moscow = presetWakeTime('tomorrow-morning', now, 'Europe/Moscow');
  assert.equal(wallClock(moscow, 'Europe/Moscow'), '2026-08-06 08:00');

  // Тот же момент в Иркутске — уже 2:30 ШЕСТОГО августа, поэтому «завтра
  // утром» для него наступит седьмого. Если считать по серверу, письмо
  // приехало бы к нему на сутки раньше — то есть ночью.
  const irkutsk = presetWakeTime('tomorrow-morning', now, 'Asia/Irkutsk');
  assert.equal(wallClock(irkutsk, 'Asia/Irkutsk'), '2026-08-07 08:00');
  assert.notEqual(moscow.getTime(), irkutsk.getTime());
});

test('«завтра утром» пересекает перевод стрелок и всё равно приходит в восемь', () => {
  // В ночь на 25 октября 2026 в Европе стрелки переводят назад: сутки
  // длятся 25 часов. Сложение «+24 часа» дало бы семь утра.
  const now = new Date('2026-10-24T12:00:00Z');
  const at = presetWakeTime('tomorrow-morning', now, 'Europe/Berlin');
  assert.equal(wallClock(at, 'Europe/Berlin'), '2026-10-25 08:00');
});

test('«в понедельник», сказанное в понедельник, — это следующая неделя', () => {
  // 3 августа 2026 — понедельник.
  const monday = new Date('2026-08-03T09:00:00Z');
  const at = presetWakeTime('monday', monday, 'Europe/Moscow');
  assert.equal(wallClock(at, 'Europe/Moscow'), '2026-08-10 08:00');

  // А сказанное в пятницу — это ближайший понедельник.
  const friday = new Date('2026-08-07T09:00:00Z');
  assert.equal(
    wallClock(presetWakeTime('monday', friday, 'Europe/Moscow'), 'Europe/Moscow'),
    '2026-08-10 08:00',
  );

  // И в воскресенье — завтрашний понедельник, а не сегодняшний.
  const sunday = new Date('2026-08-09T09:00:00Z');
  assert.equal(
    wallClock(presetWakeTime('monday', sunday, 'Europe/Moscow'), 'Europe/Moscow'),
    '2026-08-10 08:00',
  );
});

test('«через неделю» — ровно семь суток по календарю, в то же утро', () => {
  const now = new Date('2026-08-05T18:30:00Z');
  const at = presetWakeTime('next-week', now, 'Europe/Moscow');
  assert.equal(wallClock(at, 'Europe/Moscow'), '2026-08-12 08:00');
});

test('все готовые сроки лежат в будущем', () => {
  // Три часа ночи по Москве: «завтра утром» легко было бы посчитать
  // сегодняшним восьмичасовым, до которого пять часов, — но человек
  // просил именно завтра.
  const now = new Date('2026-08-05T00:00:00Z');
  for (const preset of ['tomorrow-morning', 'monday', 'next-week'] as const) {
    const at = presetWakeTime(preset, now, 'Europe/Moscow');
    assert.ok(at.getTime() > now.getTime(), `${preset} оказался в прошлом`);
  }
});

test('неизвестный пояс не отменяет возможность отложить письмо', () => {
  assert.equal(usableZone('Europe/Moscow'), 'Europe/Moscow');
  assert.equal(usableZone('Средиземье/Шир'), null);
  assert.equal(usableZone(''), null);
  assert.equal(usableZone(undefined), null);

  // Считается в UTC и об этом честно сказано — но отказа нет: отказать
  // человеку в откладывании из-за настроек браузера было бы хуже, чем
  // ошибиться на несколько часов.
  const check = checkSnoozeRequest(
    { preset: 'tomorrow-morning', timeZone: 'Средиземье/Шир' },
    new Date('2026-08-05T18:30:00Z'),
  );
  assert.equal(check.kind, 'at');
  if (check.kind !== 'at') return;
  assert.equal(check.zoneUsed, null);
  assert.equal(check.at.toISOString(), '2026-08-06T08:00:00.000Z');
  assert.equal(SNOOZE_MORNING_HOUR, 8);
});

test('стенные часы превращаются в момент и обратно без потерь', () => {
  const at = fromZonedWallClock(
    { year: 2026, month: 1, day: 15, hour: 8, minute: 0 },
    'Asia/Vladivostok',
  );
  assert.equal(wallClock(at, 'Asia/Vladivostok'), '2026-01-15 08:00');
});

test('срок в прошлом и «через минуту назад» отвергаются понятной фразой', () => {
  const now = new Date('2026-08-05T18:30:00Z');
  const past = checkSnoozeRequest({ until: '2026-08-05T18:29:00Z' }, now);
  assert.equal(past.kind, 'invalid');
  if (past.kind !== 'invalid') return;
  assert.match(past.reason, /срок/i);

  // Через минуту — законная просьба, а не описка: именно так проверяют
  // возможность на живом стенде.
  const soon = checkSnoozeRequest({ until: '2026-08-05T18:31:00Z' }, now);
  assert.equal(soon.kind, 'at');
});

test('срок дальше года отвергается, ближе — принимается', () => {
  const now = new Date('2026-08-05T18:30:00Z');
  const tooFar = new Date(now.getTime() + SNOOZE_MAX_DELAY_MS + 60_000);
  const far = checkSnoozeRequest({ until: tooFar.toISOString() }, now);
  assert.equal(far.kind, 'invalid');

  const almost = new Date(now.getTime() + SNOOZE_MAX_DELAY_MS - 60_000);
  assert.equal(checkSnoozeRequest({ until: almost.toISOString() }, now).kind, 'at');
});

test('нечитаемая дата и пустая просьба отвергаются, а не считаются нулём', () => {
  const now = new Date('2026-08-05T18:30:00Z');
  assert.equal(checkSnoozeRequest({ until: 'когда-нибудь' }, now).kind, 'invalid');
  assert.equal(checkSnoozeRequest({}, now).kind, 'invalid');
  assert.equal(checkSnoozeRequest({ preset: 'custom' }, now).kind, 'invalid');
});
