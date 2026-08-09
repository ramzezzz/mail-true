/**
 * Смена пароля обязана выкидывать того, кто уже вошёл.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Способа закрыть чужую сессию не существовало вовсе. Сессия хранит
 * пароль, каким он был при входе, продлевается на каждом запросе (а
 * браузер опрашивает сервер сам), и открытое соединение с ящиком
 * переиспользуется без сверки пароля.
 *
 * Живой сценарий: человек видит в разделе «Вход и действия» чужой вход,
 * просит администратора сменить пароль — и это ничего не меняет. Тот, кто
 * увёл cookie, продолжает читать почту; выкинет его только случайность,
 * если он сделает паузу дольше срока простоя соединения.
 *
 * То же и с блокировкой ящика: Dovecot отсеивает заблокированных при
 * проверке пароля, а уже открытую сессию это не трогает — уволенный
 * сотрудник с открытой вкладкой читает почту дальше.
 *
 * Перечислить сессии ящика раньше было нечем: ключи именуются
 * идентификатором сессии, а поиск по значению в Redis — перебор всей базы.
 * Поэтому вместе с отзывом появился указатель «ящик → его сессии».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySessionStore } from './session.js';

function data(email: string) {
  return { email, passwordEnc: 'enc', createdAt: Date.now() };
}

test('отзыв закрывает все сессии ящика и только их', async () => {
  const store = new MemorySessionStore();
  await store.set('a1', data('ivan@mail.local'), 3600);
  await store.set('a2', data('ivan@mail.local'), 3600);
  await store.set('b1', data('anna@mail.local'), 3600);

  const closed = await store.revokeByEmail('ivan@mail.local');

  assert.equal(closed, 2, 'закрыты не все сессии ящика');
  assert.equal(await store.get('a1'), null);
  assert.equal(await store.get('a2'), null);
  assert.ok(await store.get('b1'), 'чужая сессия пострадала');
});

test('адрес сравнивается без учёта регистра', async () => {
  // Ящик заводят как `Ivan@Mail.local`, а входят строчными — и наоборот.
  const store = new MemorySessionStore();
  await store.set('a1', data('Ivan@Mail.local'), 3600);
  assert.equal(await store.revokeByEmail('ivan@mail.local'), 1);
  assert.equal(await store.get('a1'), null);
});

test('отзыв у ящика без сессий ничего не ломает', async () => {
  const store = new MemorySessionStore();
  assert.equal(await store.revokeByEmail('nikto@mail.local'), 0);
});
