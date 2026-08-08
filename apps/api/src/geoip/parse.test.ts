/**
 * Страна по адресу.
 *
 * Проверяется то, из-за чего эта проверка может тихо соврать: границы
 * диапазонов, порядок сортировки (двоичный поиск на неотсортированных
 * данных не падает, а отвечает неправильно), негодные строки в скачанном
 * файле и приведение форм записи адреса.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyIndex, ipv4ToNumber, ipv6ToHigh64, lookupCountry, parseCountryCsv } from './parse.js';

const SAMPLE = [
  '1.0.0.0,1.0.0.255,AU',
  '5.0.0.0,5.255.255.255,DE',
  '77.88.0.0,77.88.255.255,RU',
  '2a02:6b8::,2a02:6b8:ffff:ffff:ffff:ffff:ffff:ffff,RU',
].join('\n');

test('адрес внутри диапазона получает свою страну', () => {
  const index = parseCountryCsv(SAMPLE);
  assert.equal(lookupCountry(index, '77.88.55.88'), 'RU');
  assert.equal(lookupCountry(index, '5.10.20.30'), 'DE');
});

test('границы диапазона включены', () => {
  // Классическая ошибка на единицу: первый и последний адрес сети
  // выпадали бы из страны, а это адреса шлюзов и NAT — то есть ровно те,
  // с которых чаще всего и приходят.
  const index = parseCountryCsv(SAMPLE);
  assert.equal(lookupCountry(index, '1.0.0.0'), 'AU');
  assert.equal(lookupCountry(index, '1.0.0.255'), 'AU');
  assert.equal(lookupCountry(index, '1.0.1.0'), null);
});

test('адрес вне всех диапазонов — «не знаю», а не первая попавшаяся страна', () => {
  const index = parseCountryCsv(SAMPLE);
  assert.equal(lookupCountry(index, '9.9.9.9'), null);
  assert.equal(lookupCountry(index, '203.0.113.7'), null);
});

test('IPv6 ищется по старшим 64 битам', () => {
  const index = parseCountryCsv(SAMPLE);
  assert.equal(lookupCountry(index, '2a02:6b8:0:1::feed'), 'RU');
  assert.equal(lookupCountry(index, '2a03::1'), null);
});

test('порядок строк в файле не влияет на ответ', () => {
  // Выгрузка приходит отсортированной, но полагаться на это нельзя:
  // перепутанный порядок дал бы не ошибку, а тихо неверные ответы.
  const shuffled = [
    '77.88.0.0,77.88.255.255,RU',
    '1.0.0.0,1.0.0.255,AU',
    '5.0.0.0,5.255.255.255,DE',
  ].join('\n');
  const index = parseCountryCsv(shuffled);
  assert.equal(lookupCountry(index, '1.0.0.10'), 'AU');
  assert.equal(lookupCountry(index, '77.88.8.8'), 'RU');
});

test('битые строки пропускаются, остальной файл разбирается', () => {
  /*
   * База скачивается из интернета. Одна испорченная строка в двухстах
   * тысячах — не повод остаться вовсе без определения страны, но и не
   * повод молчать: счётчик пропущенных виден в панели.
   */
  const text = [
    '# комментарий',
    '1.0.0.0,1.0.0.255,AU',
    'мусор',
    '2.0.0.0,2.0.0.255,ЯЯ',
    '3.0.0.5,3.0.0.1,DE',
    '',
    '4.0.0.0,4.0.0.255,FR',
  ].join('\n');
  const index = parseCountryCsv(text);
  assert.equal(lookupCountry(index, '1.0.0.7'), 'AU');
  assert.equal(lookupCountry(index, '4.0.0.7'), 'FR');
  assert.equal(index.skipped, 3);
});

test('поля в кавычках принимаются', () => {
  const index = parseCountryCsv('"8.8.8.0","8.8.8.255","US"');
  assert.equal(lookupCountry(index, '8.8.8.8'), 'US');
});

test('пустая база отвечает «не знаю» и не падает', () => {
  assert.equal(lookupCountry(emptyIndex(), '77.88.55.88'), null);
});

test('разбор адреса: мусор не превращается в число', () => {
  assert.equal(ipv4ToNumber('1.2.3.4'), 16_909_060);
  assert.equal(ipv4ToNumber('255.255.255.255'), 4_294_967_295);
  assert.equal(ipv4ToNumber('1.2.3'), undefined);
  assert.equal(ipv4ToNumber('1.2.3.256'), undefined);
  assert.equal(ipv4ToNumber('1.2.3.x'), undefined);
});

test('форма ::ffff:1.2.3.4 не разбирается как IPv6', () => {
  /*
   * Это IPv4, записанный по-другому, и приводить его к обычному виду
   * обязан вызывающий. Если бы он искался как IPv6, один и тот же адрес
   * попадал бы то в одну половину базы, то в другую — и страна зависела
   * бы от того, каким путём пришёл запрос.
   */
  assert.equal(ipv6ToHigh64('::ffff:1.2.3.4'), undefined);
});

test('сокращённая запись IPv6 разворачивается', () => {
  assert.equal(ipv6ToHigh64('::1'), 0n);
  assert.equal(ipv6ToHigh64('2a02:6b8::'), 0x2a0206b800000000n);
  assert.equal(ipv6ToHigh64('2a02:6b8:0:0:1:2:3:4'), 0x2a0206b800000000n);
  assert.equal(ipv6ToHigh64('не адрес'), undefined);
});
