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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clientIdOf, watchExpired, WATCH_KEEP_ALIVE_MS } from './ws.js';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./ws.ts', import.meta.url).href.replace('/dist/', '/src/')),
  'utf8',
);

/** Код без комментариев: разбор рядом не должен изображать правку. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

/* ------------------------------------------------------------------ */
/* Обрыв IDLE                                                           */
/* ------------------------------------------------------------------ */

test('оборвавшееся наблюдение поднимается заново, а не остаётся мёртвым', () => {
  /*
   * ЧТО БЫЛО. Обрыв IDLE снимал наблюдателя и рассылал сокетам
   * 'idle-lost'. Поднять наблюдение было некому: сам WebSocket оставался
   * открытым, значит браузер не переподключался, а ensureWatcher зовётся
   * только из subscribe. С этого момента у ящика не оставалось ни одного
   * источника событий — ни списка, ни уведомлений на вкладке, ни push, —
   * и лечилось это только перезагрузкой страницы.
   */
  assert.match(CODE, /this\.scheduleRearm\(watcher\)/u, 'после обрыва нужна попытка поднять');
  assert.match(CODE, /private async rearm\(watcher: Watcher\)/u);
  assert.match(CODE, /type: 'idle-restored'/u, 'вкладкам нужно сказать, что связь вернулась');
});

test('намеренно закрытое наблюдение обратно не поднимается', () => {
  // Выход, смена пароля и блокировка ящика закрывают наблюдение
  // осознанно. Поднять его обратно значило бы продолжить читать чужую
  // почту с паролем, которого у человека уже нет.
  const closer = CODE.slice(CODE.indexOf('private closeWatcher'));
  assert.match(closer, /watcher\.dropped = true/u);
  const rearm = CODE.slice(CODE.indexOf('private scheduleRearm'));
  assert.match(rearm, /if \(watcher\.dropped/u);
});

test('поднимать нечего, если вкладок нет и срок наблюдения вышел', () => {
  const rearm = CODE.slice(
    CODE.indexOf('private scheduleRearm'),
    CODE.indexOf('private async rearm'),
  );
  assert.match(rearm, /watchExpired\(watcher, Date\.now\(\)\)/u);
});
