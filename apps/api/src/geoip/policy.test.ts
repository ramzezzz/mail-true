/**
 * Решение «пускать или нет» по стране.
 *
 * Здесь закреплён перекос, ради которого всё и написано так: ответ «не
 * знаю» никогда не превращается в отказ. Цена ложного отказа — запертый
 * администратор без другого способа войти; цена ложного пропуска — вход,
 * который всё равно требует верного пароля и всё равно виден в журнале.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { GeoIpDatabase, parseCountryList } from './index.js';

const logger = pino({ level: 'silent' });

function db(policy: 'off' | 'log' | 'allow', allowed: string[] = []): GeoIpDatabase {
  // Путь заведомо несуществующий: так проверяется поведение БЕЗ базы —
  // то есть состояние сервера, на котором её не скачивали.
  return new GeoIpDatabase({ path: '/нет/такого/файла.csv', policy, allowed, logger });
}

test('выключенная проверка пускает всех и не трогает базу', () => {
  const verdict = db('off').check('203.0.113.7');
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.country, null);
});

test('без базы вход работает — даже при политике allow', () => {
  /*
   * Самое важное свойство. Проверка, которая при своей же поломке
   * запирает всех, хуже отсутствующей: базу могли не скачать, файл могли
   * потерять при переносе, том могли не смонтировать.
   */
  const verdict = db('allow', ['RU']).check('8.8.8.8');
  assert.equal(verdict.allowed, true);
  assert.match(verdict.reason, /база/);
});

test('локальные адреса не проверяются никогда', () => {
  // На этом держится и вход из офиса, и резервный вход в панель по
  // адресу сервера: запереть себя списком стран нельзя.
  for (const ip of ['192.168.1.10', '10.0.0.5', '172.16.4.4', '127.0.0.1', '::1']) {
    const verdict = db('allow', ['RU']).check(ip);
    assert.equal(verdict.allowed, true, ip);
    assert.equal(verdict.reason, 'локальная сеть');
  }
});

test('пустой адрес не роняет проверку', () => {
  assert.equal(db('allow', ['RU']).check('').allowed, true);
});

test('список стран разбирается терпимо к написанию', () => {
  assert.deepEqual(parseCountryList('RU, by ; KZ'), ['RU', 'BY', 'KZ']);
  // Повторы схлопываются, мусор отбрасывается: список правят руками, и
  // «RUS» вместо «RU» не должно молча стать разрешённой страной.
  assert.deepEqual(parseCountryList('ru RU rus 12 !'), ['RU']);
  assert.deepEqual(parseCountryList(''), []);
});
