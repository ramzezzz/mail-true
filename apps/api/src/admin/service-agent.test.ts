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
import { parseAudit, parseUpdateStatus, parseVersion } from './service-agent.js';

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

/* ------------------------------------------------------------------ */
/* Раздел «Обновления»                                                  */
/* ------------------------------------------------------------------ */

/** Ответ посредника ровно такой, какой он отдаёт на самом деле. */
const REAL_VERSION_BODY = {
  ok: true,
  commit: 'a'.repeat(40),
  short: 'aaaaaaa',
  branch: 'master',
  committedAt: '2026-08-09T10:00:00.000Z',
  subject: 'что-то полезное',
  dirty: false,
  // Числами наружу посредник не отдаёт НИЧЕГО — это его сознательное
  // решение (agent.pl, to_json): «строка, случайно состоящая из цифр,
  // должна доехать строкой».
  behind: '3',
  ahead: '0',
  pending: [{ hash: 'bbbbbbb', at: '2026-08-09T11:00:00.000Z', subject: 'правка' }],
  images: [],
};

test('«отстали на N коммитов» не теряется оттого, что число приехало строкой', () => {
  /*
   * ЧТО БЫЛО. Разбор требовал именно number, и `behind` всегда получался
   * нулём. По нему страница решает, есть ли что обновлять: кнопка
   * «Обновить продукт» была заблокирована ВСЕГДА, рядом печаталось «Не
   * применённого нет» — и тут же таблица «Что приедет при обновлении» со
   * списком приехавших коммитов, потому что строки доезжали нормально.
   * Обновиться из панели было нельзя вообще.
   *
   * Проверка не ловила этого потому, что подделка посредника отдавала
   * настоящее число. Здесь — то, что отдаёт настоящий посредник.
   */
  const parsed = parseVersion(REAL_VERSION_BODY);
  assert.equal(parsed.behind, 3, 'иначе кнопка обновления заблокирована навсегда');
  assert.equal(parsed.ahead, 0);
  assert.equal(parsed.pending.length, 1);
  assert.equal(parsed.dirty, false);
});

test('число принимается и в своём виде — на случай другого посредника', () => {
  const parsed = parseVersion({ ...REAL_VERSION_BODY, behind: 7 });
  assert.equal(parsed.behind, 7);
});

test('мусор вместо числа не превращается в NaN на экране', () => {
  const parsed = parseVersion({ ...REAL_VERSION_BODY, behind: 'много' });
  assert.equal(parsed.behind, 0);
});

test('код возврата неудачного обновления не подменяется нулём', () => {
  /*
   * Та же причина. Строка «Обновление не доведено до конца (код возврата
   * N)» печатала ноль при ЛЮБОЙ неудаче — то есть место, где должна быть
   * причина, занимал признак успеха.
   */
  const parsed = parseUpdateStatus({
    ok: true,
    state: 'failed',
    mode: 'code',
    exitCode: '1',
    startedAt: '2026-08-09T10:05:00.000Z',
    finishedAt: '2026-08-09T10:09:00.000Z',
    log: 'сборка упала',
  });
  assert.equal(parsed.state, 'failed');
  assert.equal(parsed.exitCode, 1, 'ноль здесь означал бы «всё хорошо»');
});
