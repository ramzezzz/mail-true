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
