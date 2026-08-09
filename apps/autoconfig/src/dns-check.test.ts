/**
 * Тесты живой проверки DNS.
 *
 * Разбирается дефект: если вместо CNAME опубликована A-запись, проверка
 * возвращала «ok» БЕЗУСЛОВНО. Комментарий обещал сравнение адресов, но
 * сравнения в коде не было — проверка на чужом домене выдавала зелёный
 * статус для совершенно постороннего сервера, а Outlook уходил не туда.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDnsRecords, checkDns } from './dns.js';
import type { DnsResolverLike } from './dns.js';
import { testSettings } from './testutil.js';

/** Подставной резольвер: отвечает по таблице, на всё остальное — ENOTFOUND. */
function fakeResolver(tables: {
  cname?: Record<string, string[]>;
  a?: Record<string, string[]>;
  mx?: Record<string, Array<{ priority: number; exchange: string }>>;
  txt?: Record<string, string[][]>;
  srv?: Record<string, Array<{ priority: number; weight: number; port: number; name: string }>>;
}): DnsResolverLike {
  const miss = (name: string): never => {
    throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
  };
  return {
    async resolveCname(n) {
      return tables.cname?.[n] ?? miss(n);
    },
    async resolve4(n) {
      return tables.a?.[n] ?? miss(n);
    },
    async resolveMx(n) {
      return tables.mx?.[n] ?? miss(n);
    },
    async resolveTxt(n) {
      return tables.txt?.[n] ?? miss(n);
    },
    async resolveSrv(n) {
      return tables.srv?.[n] ?? miss(n);
    },
  };
}

const cnameRecords = buildDnsRecords(testSettings, 'mail.local', null).filter(
  (r) => r.type === 'CNAME',
);

test('dns-check: чужая A-запись вместо CNAME — это mismatch, а не «ok»', async () => {
  // autoconfig.mail.local ведёт на постороннего провайдера, а наш сервер — .10
  const resolver = fakeResolver({
    a: {
      'autoconfig.mail.local': ['203.0.113.77'],
      'autodiscover.mail.local': ['203.0.113.77'],
      'mail.local': ['198.51.100.10'],
    },
  });
  const results = await checkDns(testSettings, 'mail.local', cnameRecords, resolver);
  assert.equal(results.length, 2);
  for (const r of results) {
    // До исправления здесь безусловно возвращалось 'ok'
    assert.equal(r.status, 'mismatch', `${r.name}: ${r.comment}`);
    assert.match(r.comment, /чужой сервер|203\.0\.113\.77/);
  }
});

test('dns-check: A-запись с адресом нашего сервера — допустимо, «ok»', async () => {
  const resolver = fakeResolver({
    a: {
      'autoconfig.mail.local': ['198.51.100.10'],
      'autodiscover.mail.local': ['198.51.100.10'],
      'mail.local': ['198.51.100.10'],
    },
  });
  const results = await checkDns(testSettings, 'mail.local', cnameRecords, resolver);
  for (const r of results) {
    assert.equal(r.status, 'ok', `${r.name}: ${r.comment}`);
  }
});

test('dns-check: настоящий CNAME на наш хост — «ok»', async () => {
  const resolver = fakeResolver({
    cname: {
      'autoconfig.mail.local': ['mail.local'],
      'autodiscover.mail.local': ['mail.local.'],
    },
  });
  const results = await checkDns(testSettings, 'mail.local', cnameRecords, resolver);
  for (const r of results) assert.equal(r.status, 'ok', `${r.name}: ${r.comment}`);
});

test('dns-check: CNAME на чужой хост — mismatch (как и было)', async () => {
  const resolver = fakeResolver({
    cname: {
      'autoconfig.mail.local': ['autoconfig.old-provider.example'],
      'autodiscover.mail.local': ['autodiscover.old-provider.example'],
    },
  });
  const results = await checkDns(testSettings, 'mail.local', cnameRecords, resolver);
  for (const r of results) assert.equal(r.status, 'mismatch');
});

test('dns-check: нет ни CNAME, ни A — «не опубликована»', async () => {
  const results = await checkDns(testSettings, 'mail.local', cnameRecords, fakeResolver({}));
  for (const r of results) assert.equal(r.status, 'missing');
});

test('dns-check: адрес нашего сервера не резолвится — сравнивать не с чем, не «ok»', async () => {
  const resolver = fakeResolver({
    a: { 'autoconfig.mail.local': ['203.0.113.77'], 'autodiscover.mail.local': ['203.0.113.77'] },
  });
  const results = await checkDns(testSettings, 'mail.local', cnameRecords, resolver);
  for (const r of results) {
    assert.notEqual(r.status, 'ok');
    assert.match(r.comment, /сравнить не с чем/);
  }
});

/* ------------------------------------------------------------------ */
/* Проверка по существу, а не побуквенно                                */
/* ------------------------------------------------------------------ */

const txtRecords = (dkim: string | null) =>
  buildDnsRecords(testSettings, 'mail.local', dkim).filter((r) => r.type === 'TXT');

/** Результат по имени записи. */
function pick(results: Awaited<ReturnType<typeof checkDns>>, name: string) {
  return results.find((r) => r.name === name);
}

test('dns-check: DKIM без выпущенного ключа — «проверить нечем», а не «совпадает»', async () => {
  /*
   * Пока rspamd не выпустил ключ, ожидаемого значения не существует.
   * Раньше такой случай считался успехом при ЛЮБОЙ опубликованной
   * записи: самопроверка печатала зелёное «опубликована и совпадает» на
   * чужой ключ, оставшийся от прежнего провайдера, а письма при этом
   * подписывались не тем ключом или не подписывались вовсе.
   */
  const resolver = fakeResolver({
    txt: { 'mail._domainkey.mail.local': [['v=DKIM1; k=rsa; p=ЧУЖОЙКЛЮЧ']] },
  });
  const results = await checkDns(testSettings, 'mail.local', txtRecords(null), resolver);
  const dkim = pick(results, 'mail._domainkey.mail.local');
  assert.equal(dkim?.status, 'unknown');
  assert.match(dkim?.comment ?? '', /не выпущен/u);
});

test('dns-check: чужой ключ DKIM при своём выпущенном — mismatch с объяснением', async () => {
  const resolver = fakeResolver({
    txt: { 'mail._domainkey.mail.local': [['v=DKIM1; k=rsa; p=ЧУЖОЙ']] },
  });
  const results = await checkDns(
    testSettings,
    'mail.local',
    txtRecords('v=DKIM1; k=rsa; p=НАШ'),
    resolver,
  );
  const dkim = pick(results, 'mail._domainkey.mail.local');
  assert.equal(dkim?.status, 'mismatch');
  assert.match(dkim?.comment ?? '', /не тем ключом/u);
});

test('dns-check: более строгий SPF (-all) не объявляется ошибкой', async () => {
  // Побуквенное сравнение подталкивало «починить» верную запись, ослабив её.
  const resolver = fakeResolver({ txt: { 'mail.local': [['v=spf1 mx -all']] } });
  const results = await checkDns(testSettings, 'mail.local', txtRecords(null), resolver);
  assert.equal(pick(results, 'mail.local')?.status, 'ok');
});

test('dns-check: SPF без механизма для наших отправителей — mismatch', async () => {
  const resolver = fakeResolver({ txt: { 'mail.local': [['v=spf1 -all']] } });
  const results = await checkDns(testSettings, 'mail.local', txtRecords(null), resolver);
  const spf = pick(results, 'mail.local');
  assert.equal(spf?.status, 'mismatch');
  assert.match(spf?.comment ?? '', /mx/u);
});

test('dns-check: «+all» в SPF назван дырой, а не мелким расхождением', async () => {
  const resolver = fakeResolver({ txt: { 'mail.local': [['v=spf1 mx +all']] } });
  const results = await checkDns(testSettings, 'mail.local', txtRecords(null), resolver);
  const spf = pick(results, 'mail.local');
  assert.equal(spf?.status, 'mismatch');
  assert.match(spf?.comment ?? '', /кому угодно/u);
});

test('dns-check: свой адрес отчётов DMARC — не ошибка', async () => {
  const resolver = fakeResolver({
    txt: { '_dmarc.mail.local': [['v=DMARC1; p=reject; rua=mailto:dmarc@example.org']] },
  });
  const results = await checkDns(testSettings, 'mail.local', txtRecords(null), resolver);
  assert.equal(pick(results, '_dmarc.mail.local')?.status, 'ok');
});

test('dns-check: DMARC с p=none принят, но сказано, что он ничего не предписывает', async () => {
  const resolver = fakeResolver({ txt: { '_dmarc.mail.local': [['v=DMARC1; p=none']] } });
  const results = await checkDns(testSettings, 'mail.local', txtRecords(null), resolver);
  const dmarc = pick(results, '_dmarc.mail.local');
  assert.equal(dmarc?.status, 'ok');
  assert.match(dmarc?.comment ?? '', /ничего не предписывает/u);
});

test('dns-check: MX на имя без адреса — не «указывает на наш сервер»', async () => {
  /*
   * Имя совпало, а A-записи у него нет: почту на такой домен не примет
   * никто. Зелёный статус здесь означал бы, что проверка подтверждает
   * работоспособность, которой нет.
   */
  const mxRecords = buildDnsRecords(testSettings, 'mail.local', null).filter(
    (r) => r.type === 'MX',
  );
  const resolver = fakeResolver({
    mx: { 'mail.local': [{ priority: 10, exchange: 'mail.local' }] },
    // A-записи для mail.local нет вовсе
  });
  const results = await checkDns(testSettings, 'mail.local', mxRecords, resolver);
  const mx = results[0];
  assert.equal(mx?.status, 'mismatch');
  assert.match(mx?.comment ?? '', /нет адреса/u);
});

test('dns-check: MX на имя с адресом по-прежнему зелёный', async () => {
  const mxRecords = buildDnsRecords(testSettings, 'mail.local', null).filter(
    (r) => r.type === 'MX',
  );
  const resolver = fakeResolver({
    mx: { 'mail.local': [{ priority: 10, exchange: 'mail.local' }] },
    a: { 'mail.local': ['198.51.100.10'] },
  });
  const results = await checkDns(testSettings, 'mail.local', mxRecords, resolver);
  assert.equal(results[0]?.status, 'ok');
});
