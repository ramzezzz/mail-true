import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { handleFatal, installProcessGuards } from './process-guards.js';

interface Recorded {
  obj: Record<string, unknown>;
  msg: string;
}

function recordingLogger(): { logger: Logger; errors: Recorded[] } {
  const errors: Recorded[] = [];
  const logger = {
    error: (obj: Record<string, unknown>, msg: string) => errors.push({ obj, msg }),
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  return { logger, errors };
}

/**
 * Главный случай. Обработчиков `uncaughtException` и `unhandledRejection`
 * не было вовсе, а необработанное событие 'error' на источнике событий
 * (IMAP-соединение пула, IDLE-соединение WebSocket) убивает процесс Node
 * целиком — вместе со всеми чужими сессиями. Дважды за проход процесс API
 * умирал именно так.
 */
test('необработанное исключение переживается и попадает в журнал', () => {
  const { logger, errors } = recordingLogger();
  const target = new EventEmitter() as unknown as NodeJS.Process;
  const guards = installProcessGuards(logger, target);
  try {
    // Если бы слушателя не было, EventEmitter выбросил бы ошибку наружу
    (target as unknown as EventEmitter).emit('uncaughtException', new Error('обрыв IMAP'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.obj.kind, 'uncaughtException');
    assert.equal(errors[0]?.obj.fatalGuard, true);
  } finally {
    guards.uninstall();
  }
});

test('необработанное отклонение обещания тоже переживается', () => {
  const { logger, errors } = recordingLogger();
  const target = new EventEmitter() as unknown as NodeJS.Process;
  const guards = installProcessGuards(logger, target);
  try {
    (target as unknown as EventEmitter).emit('unhandledRejection', new Error('никто не поймал'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.obj.kind, 'unhandledRejection');
  } finally {
    guards.uninstall();
  }
});

test('слушатели снимаются полностью', () => {
  const { logger } = recordingLogger();
  const emitter = new EventEmitter();
  const guards = installProcessGuards(logger, emitter as unknown as NodeJS.Process);
  guards.uninstall();
  assert.equal(emitter.listenerCount('uncaughtException'), 0);
  assert.equal(emitter.listenerCount('unhandledRejection'), 0);
});

test('сломанный журнал не превращается в новую аварию', () => {
  const broken = {
    error: () => {
      throw new Error('журнал недоступен');
    },
  } as unknown as Logger;
  assert.doesNotThrow(() => handleFatal(broken, 'uncaughtException', new Error('исходная')));
});

test('на настоящем процессе слушатели ставятся и снимаются', () => {
  const { logger } = recordingLogger();
  const before = process.listenerCount('uncaughtException');
  const guards = installProcessGuards(logger);
  assert.equal(process.listenerCount('uncaughtException'), before + 1);
  guards.uninstall();
  assert.equal(process.listenerCount('uncaughtException'), before);
});
