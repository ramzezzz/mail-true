/**
 * Разбор ответа посредника на /audit.
 *
 * Проверяется свойство, из-за которого проверка однажды молча исчезла с
 * экрана: посредник написан на Perl без библиотеки JSON, и числа
 * приезжают строками. Разбор, требующий именно number, выбрасывал ВСЕ
 * порты — а пустой список неотличим от «портов нет вовсе», то есть
 * поломка выглядела как ненаписанная проверка.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudit } from './service-agent.js';

test('порт, пришедший строкой, не теряется', () => {
  const parsed = parseAudit({
    ports: [{ service: 'dovecot', container: '993', host: '993', proto: 'tcp', bind: '0.0.0.0' }],
  });
  assert.equal(parsed.ports.length, 1);
  assert.equal(parsed.ports[0]?.host, 993);
  assert.equal(parsed.ports[0]?.container, 993);
});

test('число принимается и в своём виде — на случай другого посредника', () => {
  const parsed = parseAudit({
    ports: [{ service: 'postfix', container: 25, host: 25, proto: 'tcp', bind: '0.0.0.0' }],
  });
  assert.equal(parsed.ports[0]?.host, 25);
});

test('«слушает наружу» — это ответ посредника, а не догадка по адресу', () => {
  // Признак приходит от того, кто спрашивал Docker. Выводить его здесь
  // из строки адреса значило бы держать вторую копию той же логики —
  // и однажды они разошлись бы.
  const parsed = parseAudit({
    ports: [
      {
        service: 'nginx',
        container: '80',
        host: '80',
        proto: 'tcp',
        bind: '0.0.0.0',
        public: true,
      },
      {
        service: 'autoconfig',
        container: '8080',
        host: '8025',
        proto: 'tcp',
        bind: '127.0.0.1',
        public: false,
      },
    ],
  });
  assert.deepEqual(
    parsed.ports.map((p) => p.public),
    [true, false],
  );
});

test('строка без имени службы или без порта отбрасывается', () => {
  const parsed = parseAudit({
    ports: [
      { container: '25', host: '25' },
      { service: 'postfix', host: 'не число' },
      { service: 'postfix', container: '25', host: '25' },
    ],
  });
  assert.equal(parsed.ports.length, 1);
});

test('порты не пришли вовсе — пустой список, а не отказ', () => {
  // Посредник мог быть старой версии: он ответит без этого поля, и это
  // не повод ронять весь раздел «Наблюдение».
  const parsed = parseAudit({ ok: true });
  assert.deepEqual(parsed.ports, []);
  assert.equal(parsed.env.readable, false);
});

test('числа о файле настроек тоже принимаются строками', () => {
  const parsed = parseAudit({
    env: {
      readable: true,
      mode: '0600',
      groupReadable: false,
      worldReadable: false,
      crlfLines: '0',
      keys: '124',
      sameAsExample: '2',
    },
  });
  assert.equal(parsed.env.keys, 124);
  assert.equal(parsed.env.sameAsExample, 2);
  assert.equal(parsed.env.crlfLines, 0);
  assert.equal(parsed.env.mode, '0600');
});

test('непришедшее поле остаётся непришедшим, а не нулём', () => {
  /*
   * «Не ответил» и «ноль» — разные вещи, и раздел показывает их
   * по-разному: ноль совпадений с примером означает «проверено, чисто»,
   * а отсутствие поля — «эта проверка не выполнялась». Подставлять сюда
   * ноль значило бы выдавать непроверенное за проверенное.
   */
  const parsed = parseAudit({ env: { readable: true, mode: '0600' } });
  assert.equal(parsed.env.sameAsExample, undefined);
  assert.equal(parsed.env.crlfLines, undefined);
  assert.equal(parsed.env.groupReadable, undefined);
});
