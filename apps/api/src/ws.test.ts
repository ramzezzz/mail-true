/**
 * Наблюдение за ящиком и отпечаток браузера.
 *
 * Главное здесь — срок жизни наблюдения без открытых вкладок. Пока
 * уведомления показывала сама страница, наблюдение закрывалось вместе с
 * последним сокетом, и это было правильно. С уведомлениями при ЗАКРЫТОЙ
 * вкладке то же самое означает, что о новом письме НЕКОМУ узнать: push
 * не уйдёт, потому что события не случится. Возможность при этом выглядит
 * работающей — подписка есть, проверочное уведомление приходит, — и
 * молчит на настоящих письмах. Отсюда проверки ниже.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIdOf, watchExpired, WATCH_KEEP_ALIVE_MS } from './ws.js';

test('отпечаток браузера читается из строки запроса и обрезается', () => {
  assert.equal(clientIdOf({ client: 'abc-123' }), 'abc-123');
  assert.equal(clientIdOf({ client: '  abc-123  ' }), 'abc-123');
  assert.equal(clientIdOf({ client: 'x'.repeat(200) }), 'x'.repeat(64));
});

test('отсутствующий и пустой отпечаток — это отсутствие отпечатка', () => {
  // Без отпечатка push уйдёт и в тот браузер, где открыта вкладка:
  // неприятно, но лучше, чем уронить соединение из-за строки запроса.
  assert.equal(clientIdOf({}), null);
  assert.equal(clientIdOf(null), null);
  assert.equal(clientIdOf({ client: '' }), null);
  assert.equal(clientIdOf({ client: '   ' }), null);
  assert.equal(clientIdOf({ client: 42 }), null);
});

test('наблюдение с открытой вкладкой не закрывается никогда', () => {
  const now = Date.now();
  // Даже с давно вышедшим сроком: срок относится только к жизни БЕЗ вкладок
  assert.equal(watchExpired({ sockets: { size: 1 }, keepAliveUntil: 0 }, now), false);
  assert.equal(watchExpired({ sockets: { size: 3 }, keepAliveUntil: now - 1000 }, now), false);
});

test('без вкладок и без подписок наблюдение закрывается сразу', () => {
  // keepAliveUntil = 0 означает «подписок на доставку у ящика нет»
  assert.equal(watchExpired({ sockets: { size: 0 }, keepAliveUntil: 0 }, Date.now()), true);
});

test('ради уведомлений наблюдение переживает закрытую вкладку — но не навсегда', () => {
  const now = Date.now();
  const kept = { sockets: { size: 0 }, keepAliveUntil: now + WATCH_KEEP_ALIVE_MS };
  assert.equal(watchExpired(kept, now), false, 'сразу после закрытия вкладки — живёт');
  assert.equal(
    watchExpired(kept, now + WATCH_KEEP_ALIVE_MS - 1),
    false,
    'через почти сутки — живёт',
  );
  assert.equal(
    watchExpired(kept, now + WATCH_KEEP_ALIVE_MS),
    true,
    'ровно через сутки — закрываем',
  );
  assert.equal(watchExpired(kept, now + 2 * WATCH_KEEP_ALIVE_MS), true);
});

test('срок жизни наблюдения — сутки, а не «побольше на всякий случай»', () => {
  // Соединение занимает место в Dovecot, а пароль ящика всё это время
  // лежит в памяти процесса. Число здесь — сделка, и менять её молча нельзя.
  assert.equal(WATCH_KEEP_ALIVE_MS, 24 * 3600 * 1000);
});
