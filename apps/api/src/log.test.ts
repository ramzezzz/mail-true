import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { errorForLog, errorInfo } from './log.js';

/** Пишет запись pino в память и возвращает её размер и содержимое. */
function record(payload: object, message: string): { size: number; line: string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const logger = pino({ level: 'trace' }, stream);
  logger.warn(payload, message);
  const line = chunks.join('');
  return { size: Buffer.byteLength(line), line };
}

/** Ошибка pg в том виде, в каком она приходит из пула. */
function pgLikeError(): Error {
  const err = new Error('terminating connection due to administrator command');
  return Object.assign(err, {
    name: 'DatabaseError',
    code: '57P01',
    severity: 'FATAL',
    length: 116,
    file: 'postgres.c',
    line: '3197',
    routine: 'ProcessInterrupts',
    // Драйвер тянет за собой состояние соединения — из-за него запись и пухнет
    client: {
      connectionParameters: { host: '127.0.0.1', port: 5432, database: 'mailserver' },
      queryQueue: [],
      buffer: 'x'.repeat(4096),
    },
  });
}

/**
 * Главный случай. В обработчиках `pool.on('error')` в pino передавался весь
 * объект ошибки `pg` целиком — а он тянет за собой сериализованное состояние
 * соединения. При «шторме перезапусков», когда база недоступна, потребление
 * памяти процессом подскакивало с 64 МБ примерно до 200 МБ.
 */
test('запись об ошибке базы в разы легче, чем объект целиком', () => {
  const err = pgLikeError();
  const whole = record({ err }, 'Ошибка пула Postgres (админка)');
  const compact = record(errorInfo(err), 'Ошибка пула Postgres (админка)');

  assert.ok(
    compact.size * 4 < whole.size,
    `сжатая запись ${compact.size} Б против ${whole.size} Б — разница слишком мала`
  );
  // Состояние соединения в журнал попадать не должно вовсе
  assert.equal(compact.line.includes('connectionParameters'), false);
  assert.equal(compact.line.includes('xxxx'), false);
  assert.equal(compact.line.includes('"stack"'), false);
});

test('в записи остаётся всё, по чему опознают причину', () => {
  const err = pgLikeError();
  const info = errorInfo(err);
  assert.equal(info['err'], 'terminating connection due to administrator command');
  assert.equal(info['code'], '57P01');
  assert.equal(info['errType'], 'DatabaseError');
});

test('код сетевой ошибки сохраняется', () => {
  const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.equal(errorInfo(err)['code'], 'ECONNRESET');
});

test('дополнительные поля добавляются рядом', () => {
  const info = errorInfo(new Error('нет связи'), { email: 'test@mail.local' });
  assert.equal(info['email'], 'test@mail.local');
  assert.equal(info['err'], 'нет связи');
});

test('обычная ошибка не обрастает лишним', () => {
  const info = errorInfo(new Error('просто ошибка'));
  assert.deepEqual(info, { err: 'просто ошибка' });
});

test('не-ошибки тоже пригодны к записи', () => {
  assert.equal(errorInfo('строка')['err'], 'строка');
  assert.equal(errorInfo(null)['err'], 'null');
  assert.equal(errorInfo(undefined)['err'], 'неизвестная ошибка');
  /*
   * Объект без внятного message раньше записывался как «[object Object]» —
   * и это закреплялось здесь как норма. Норма плохая: журнал читают как раз
   * в те минуты, когда случилось непонятное, и «[object Object]» означает
   * потерянный след. Теперь такой объект разворачивается в JSON.
   */
  assert.equal(errorInfo({ message: '' })['err'], '{"message":""}');
  assert.equal(errorInfo({ code: 'ECONNRESET' })['err'], '{"code":"ECONNRESET"}');

  // Круговая ссылка в JSON не разворачивается — сказать о ней нужно словами.
  const looped: Record<string, unknown> = {};
  looped['self'] = looped;
  assert.equal(errorInfo(looped)['err'], 'нечитаемая ошибка');
});

/* ------------------------------------------------------------------ */
/* Запись про «Too long argument» весила 225 КБ                        */
/* ------------------------------------------------------------------ */

/**
 * Ошибка от Dovecot приезжала вместе с текстом команды, в котором лежал
 * весь список номеров писем. Одна запись журнала — 225 КБ.
 */
test('длинный текст ошибки обрезается, а не уходит в журнал целиком', () => {
  const huge = 'Too long argument: FETCH ' + Array.from({ length: 20_000 }, (_, i) => i + 1).join(',');
  assert.ok(huge.length > 100_000, 'исходный текст должен быть заведомо огромным');
  const line = JSON.stringify(errorInfo(new Error(huge)));
  assert.ok(line.length < 1000, `запись журнала весит ${String(line.length)} символов`);
  assert.match(line, /Too long argument/);
  assert.match(line, /обрезано/);
});

test('errorForLog оставляет стек, но не тащит чужие поля объекта ошибки', () => {
  const err = Object.assign(new Error('обрыв соединения'), {
    // Так выглядят поля клиентов почты и базы: состояние соединения и команда
    connection: { secret: 'x'.repeat(50_000) },
    command: 'y'.repeat(50_000),
    code: 'ECONNRESET',
  });
  const line = JSON.stringify(errorForLog(err));
  assert.ok(line.length < 3000, `запись журнала весит ${String(line.length)} символов`);
  assert.match(line, /обрыв соединения/);
  assert.match(line, /ECONNRESET/);
  assert.equal(line.includes('secret'), false);
  assert.match(line, /stack/);
});
