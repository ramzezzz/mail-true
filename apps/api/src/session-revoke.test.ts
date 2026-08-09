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

/*
 * Указатель сессий обязан переживать продление.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Сессия живёт скользящим сроком: браузер опрашивает сервер сам, и
 * открытая вкладка держит её сколько угодно долго без повторного входа.
 * А указатель «ящик → сессии» получал срок только при ВХОДЕ (ttl × 2) и
 * через две недели истекал у живой сессии. После этого revokeByEmail
 * находил пустое множество и возвращал ноль: смена пароля, блокировка и
 * удаление ящика переставали закрывать доступ — молча.
 *
 * Чтение почты у такой сессии отвалилось бы (вход в Dovecot со старым
 * паролем не пройдёт), но выгрузка ящика идёт СЛУЖЕБНЫМ пользователем:
 * угнанная сессия и после смены пароля могла заказать и скачать архив со
 * всей перепиской.
 *
 * Проверяется на памяти — в Redis-хранилище логика та же, но она уже не
 * теряет идентификаторы: продление трогает и указатель.
 */
test('счёт живых сессий ящика: выход гасит наблюдателя только у последнего', async () => {
  const store = new MemorySessionStore();
  await store.set('a1', data('ivan@mail.local'), 3600);
  await store.set('a2', data('ivan@mail.local'), 3600);
  await store.set('b1', data('anna@mail.local'), 3600);

  assert.equal(await store.countByEmail('ivan@mail.local'), 2);

  // Вышли с телефона — на рабочем компьютере человек остался в почте.
  await store.delete('a1');
  assert.equal(await store.countByEmail('ivan@mail.local'), 1, 'наблюдателя погасили бы зря');

  await store.delete('a2');
  assert.equal(await store.countByEmail('ivan@mail.local'), 0, 'ушёл последний — гасим');
  assert.equal(await store.countByEmail('anna@mail.local'), 1, 'чужие сессии не при чём');
});

test('счёт не учитывает истёкшие сессии', async () => {
  const store = new MemorySessionStore();
  await store.set('a1', data('ivan@mail.local'), 0);
  assert.equal(await store.countByEmail('ivan@mail.local'), 0);
});

test('адрес в счёте сравнивается без учёта регистра', async () => {
  const store = new MemorySessionStore();
  await store.set('a1', data('Ivan@Mail.local'), 3600);
  assert.equal(await store.countByEmail('ivan@mail.local'), 1);
});
