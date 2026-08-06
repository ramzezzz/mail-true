/**
 * Проверка того, что вносят в списки антиспама.
 *
 * Смысл проверок не в педантизме. Multimap сравнивает строки БУКВАЛЬНО:
 * запись «Ivan@Example.COM» или «@partner.example» не совпадёт ни с чем и
 * будет молча лежать в файле, создавая полную видимость работающего
 * правила. Разбираться с таким «правило есть, а не работает» дороже, чем
 * не дать записать мусор.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEntry, findSpamList, matchMapId, SPAM_LISTS } from './spam-lists.js';

test('адрес приводится к нижнему регистру: multimap сравнивает буквально', () => {
  const check = checkEntry('address', '  Ivan@Partner.Example  ');
  assert.equal(check.ok, true);
  assert.equal(check.value, 'ivan@partner.example');
});

test('домен вместо адреса в списке адресов — понятная ошибка, а не молчаливый приём', () => {
  const check = checkEntry('address', 'partner.example');
  assert.equal(check.ok, false);
  assert.match(check.problem, /полный адрес/u);
});

test('адрес вместо домена в списке доменов подсказывает, что делать', () => {
  const check = checkEntry('domain', 'ivan@partner.example');
  assert.equal(check.ok, false);
  assert.match(check.problem, /Уберите часть до собаки/u);
});

test('домен без точки не принимается', () => {
  assert.equal(checkEntry('domain', 'localhost').ok, false);
  assert.equal(checkEntry('domain', 'partner.example').ok, true);
  assert.equal(checkEntry('domain', 'mail.partner.example').ok, true);
});

test('адрес сервера принимается и одиночным, и подсетью', () => {
  assert.equal(checkEntry('ip', '203.0.113.7').ok, true);
  assert.equal(checkEntry('ip', '203.0.113.0/24').ok, true);
  assert.equal(checkEntry('ip', '2001:db8::1').ok, true);
});

test('невозможная подсеть отклоняется', () => {
  const check = checkEntry('ip', '203.0.113.0/64');
  assert.equal(check.ok, false);
  assert.match(check.problem, /префикса/u);
});

test('строка-комментарий записью стать не может', () => {
  // Иначе запись «# partner.example» легла бы в файл комментарием: в
  // списке её видно, а правило по ней не работает.
  const check = checkEntry('domain', '# partner.example');
  assert.equal(check.ok, false);
  assert.match(check.problem, /комментарий/u);
});

test('карта находится по имени файла, а не по полному пути', () => {
  const maps = [
    { id: 1, uri: '/etc/rspamd/local.d/maps.d/dkim_whitelist.inc.local' },
    { id: 2, uri: '/etc/rspamd/maps.d/whitelist_from.map' },
    { id: 3, uri: 'https://maps.rspamd.com/freemail/free.txt.zst' },
  ];
  // Путь внутри контейнера и путь в репозитории — разные, и привязка к
  // первому ломалась бы при любой правке монтирования.
  assert.equal(matchMapId(maps, 'whitelist_from.map'), 2);
  assert.equal(matchMapId(maps, 'blacklist_from.map'), null);
});

test('каталог списков описывает и то, что править нельзя, и почему', () => {
  const readonly = SPAM_LISTS.filter((list) => !list.editable);
  // Два неправимых списка — свои домены и регулярные выражения по
  // содержимому. Оба обязаны объяснять причину: пустая подсказка у
  // отключённой кнопки равносильна «просто нельзя».
  assert.equal(readonly.length, 2);
  for (const list of readonly) assert.ok(list.hint.length > 20);
});

test('у каждого списка есть символ rspamd и вес — то, что реально делает правило', () => {
  for (const list of SPAM_LISTS) {
    assert.match(list.symbol, /^[A-Z_]+$/u);
    assert.notEqual(list.score, 0);
    // Разрешающие списки уменьшают оценку, запрещающие увеличивают.
    // Перепутанный знак означал бы белый список, отправляющий письма
    // в спам, — и заметить это по интерфейсу было бы нельзя.
    assert.equal(list.score < 0, list.tone === 'allow');
  }
});

test('список ищется по идентификатору', () => {
  assert.equal(findSpamList('whitelist_from')?.file, 'whitelist_from.map');
  assert.equal(findSpamList('нет такого'), undefined);
});
