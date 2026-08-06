/**
 * Защита журнала от повторов.
 *
 * Проверяется не «пишется ли предупреждение» — это и раньше работало, —
 * а ЧАСТОТА. Всё фоновое в админке ходит по расписанию (5–60 с), а поломки
 * живут часами: без глушения одна неустранённая причина давала от 1 440 до
 * 17 280 одинаковых строк в сутки, и настоящие предупреждения в журнале
 * тонули. Тест меряет именно количество записей.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pino, type Logger } from 'pino';
import { RepeatGuard, failureKey, noteRecovered, warnOnce } from './repeat-log.js';

/** Журнал, из которого видно каждую написанную строку. */
function recorder(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: 'info' },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

void test('одна и та же причина попадает в журнал один раз, а не на каждом заходе', () => {
  const { logger, lines } = recorder();
  let clock = 0;
  const guard = new RepeatGuard({ now: () => clock });
  const err = new Error('соединение отклонено');

  // Сборщик истории ходит раз в 5 секунд: за час это 720 заходов,
  // и ещё один — ровно на границе часа, когда положено напомнить.
  for (let i = 0; i <= 720; i += 1) {
    warnOnce(guard, logger, err, 'Заход не удался');
    clock += 5_000;
  }

  // Первая запись — новость, вторая — часовое напоминание на 720-м заходе.
  assert.equal(lines.length, 2, `ожидалось 2 записи, получено ${lines.length}`);
  assert.match(lines[0] ?? '', /"repeat":"first"/);
  assert.match(lines[1] ?? '', /"repeat":"reminder"/);
  // Число подавленных повторов обязано быть в напоминании: иначе по журналу
  // не отличить «моргнуло раз» от «лежит час».
  assert.match(lines[1] ?? '', /"suppressed":719/);
});

void test('смена причины — это новость, её пишем сразу', () => {
  const { logger, lines } = recorder();
  let clock = 0;
  const guard = new RepeatGuard({ now: () => clock });

  warnOnce(guard, logger, new Error('база недоступна'), 'Проход не удался');
  clock += 1_000;
  warnOnce(guard, logger, new Error('база недоступна'), 'Проход не удался');
  clock += 1_000;
  // Другая ошибка — другая поломка, глушить её прошлой нельзя.
  warnOnce(guard, logger, new Error('нет места на диске'), 'Проход не удался');

  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? '', /"repeat":"changed"/);
  assert.match(lines[1] ?? '', /"suppressed":1/);
});

void test('восстановление сообщается один раз и только если поломка была', () => {
  const { logger, lines } = recorder();
  const guard = new RepeatGuard();

  // Поломки не было — писать не о чем, иначе журнал заполнится «всё хорошо».
  assert.equal(noteRecovered(guard, logger, 'Снова работает'), false);
  assert.equal(lines.length, 0);

  warnOnce(guard, logger, new Error('нет связи'), 'Не удалось');
  warnOnce(guard, logger, new Error('нет связи'), 'Не удалось');
  warnOnce(guard, logger, new Error('нет связи'), 'Не удалось');
  assert.equal(lines.length, 1);

  assert.equal(noteRecovered(guard, logger, 'Снова работает'), true);
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? '', /"suppressed":2/);

  // Второй раз подряд о восстановлении не сообщаем.
  assert.equal(noteRecovered(guard, logger, 'Снова работает'), false);
  assert.equal(lines.length, 2);
});

void test('после восстановления та же поломка снова считается новостью', () => {
  const { logger, lines } = recorder();
  const guard = new RepeatGuard();
  const err = new Error('нет связи');

  warnOnce(guard, logger, err, 'Не удалось');
  noteRecovered(guard, logger, 'Снова работает');
  // Мигающая связь должна быть видна: это не «то же самое», это новый обрыв.
  warnOnce(guard, logger, err, 'Не удалось');

  assert.equal(lines.length, 3);
  assert.match(lines[2] ?? '', /"repeat":"first"/);
});

void test('признак причины строится по тексту и коду, но не по стеку', () => {
  const a = new Error('соединение отклонено');
  const b = new Error('соединение отклонено');
  // Две одинаковые по сути ошибки из разных мест кода обязаны считаться
  // одной причиной, иначе глушение не сработает вовсе.
  assert.equal(failureKey(a), failureKey(b));

  const withCode = Object.assign(new Error('соединение отклонено'), { code: 'ECONNREFUSED' });
  assert.notEqual(failureKey(a), failureKey(withCode));
});
