/**
 * Юнит-тесты проверок антиспама, подписи исходящих и своего резольвера.
 *
 * Главное здесь — не «зелёный ответ на зелёный стенд», а обратное: когда
 * rspamd отвечает, но подпись не ставит, сводка обязана сказать об этом
 * прямо. Именно эта беда не видна больше нигде.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAntispam,
  checkResolver,
  readSigningVerdict,
  signingProbeMessage,
} from './services.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ---------------------------------------------------------------- */
/* Подпись исходящих                                                  */
/* ---------------------------------------------------------------- */

test('readSigningVerdict: готовая подпись в ответе означает «подписывается»', () => {
  const verdict = readSigningVerdict(
    { 'dkim-signature': 'v=1; a=rsa-sha256; d=mail.local; s=mail; b=abc' },
    'mail.local',
  );
  assert.equal(verdict.state, 'ok');
  assert.match(verdict.detail, /mail\.local/);
});

test('readSigningVerdict: символ DKIM_SIGNED тоже подходит', () => {
  const verdict = readSigningVerdict(
    { symbols: { DKIM_SIGNED: { name: 'DKIM_SIGNED', options: ['mail.local:s=mail'] } } },
    'mail.local',
  );
  assert.equal(verdict.state, 'ok');
});

test('readSigningVerdict: rspamd отвечает, но не подписывает — это отказ', () => {
  // Самая тихая беда: антиспам «работает», а письма уходят без подписи.
  const verdict = readSigningVerdict({ symbols: { MIME_GOOD: {} } }, 'mail.local');
  assert.equal(verdict.state, 'fail');
  assert.match(verdict.detail, /БЕЗ подписи DKIM/);
});

test('signingProbeMessage: отправитель — почтмейстер проверяемого домена', () => {
  // Подпись ставится по домену из From (use_domain = "header"), поэтому
  // адрес отправителя в образце — не украшение.
  assert.match(signingProbeMessage('mail.local'), /^From: postmaster@mail\.local\r\n/);
});

/* ---------------------------------------------------------------- */
/* Антиспам                                                          */
/* ---------------------------------------------------------------- */

test('checkAntispam: rspamd не отвечает — красное и у антиспама, и у подписи', async () => {
  const result = await checkAntispam({
    host: 'rspamd',
    port: 11334,
    password: 'secret',
    domain: 'mail.local',
    fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')),
  });
  assert.equal(result.antispam.state, 'fail');
  assert.match(result.antispam.detail, /БЕЗ проверки на спам и БЕЗ подписи DKIM/);
  assert.equal(result.dkim.state, 'fail');
});

test('checkAntispam: живой rspamd, который подписывает', async () => {
  const seen: string[] = [];
  const result = await checkAntispam({
    host: 'rspamd',
    port: 11334,
    password: 'secret',
    domain: 'mail.local',
    fetchImpl: (url) => {
      seen.push(url);
      if (url.endsWith('/ping')) return Promise.resolve(new Response('pong'));
      return Promise.resolve(response({ 'dkim-signature': 'v=1; d=mail.local' }));
    },
  });
  assert.equal(result.antispam.state, 'ok');
  assert.equal(result.dkim.state, 'ok');
  assert.deepEqual(seen, ['http://rspamd:11334/ping', 'http://rspamd:11334/checkv2']);
});

test('checkAntispam: живой rspamd, который перестал подписывать', async () => {
  const result = await checkAntispam({
    host: 'rspamd',
    port: 11334,
    password: 'secret',
    domain: 'mail.local',
    fetchImpl: (url) =>
      url.endsWith('/ping')
        ? Promise.resolve(new Response('pong'))
        : Promise.resolve(response({ symbols: { MIME_GOOD: {} } })),
  });
  assert.equal(result.antispam.state, 'ok', 'сам антиспам жив');
  assert.equal(result.dkim.state, 'fail', 'а подписи нет — и это должно быть видно');
});

test('checkAntispam: без пароля контроллера подпись не проверяется, но и не врёт', async () => {
  const result = await checkAntispam({
    host: 'rspamd',
    port: 11334,
    password: '',
    domain: 'mail.local',
    fetchImpl: () => Promise.resolve(new Response('pong')),
  });
  assert.equal(result.antispam.state, 'ok');
  assert.equal(result.dkim.state, 'unknown');
  assert.match(result.dkim.detail, /RSPAMD_PASSWORD/);
});

/* ---------------------------------------------------------------- */
/* Свой резольвер                                                     */
/* ---------------------------------------------------------------- */

test('checkResolver: резольвер отвечает', async () => {
  const check = await checkResolver({
    address: '172.28.0.53',
    resolveNsImpl: () => Promise.resolve(['a.root-servers.net', 'b.root-servers.net']),
  });
  assert.equal(check.state, 'ok');
  assert.match(check.detail, /172\.28\.0\.53/);
});

test('checkResolver: молчащий резольвер — отказ с объяснением последствий', async () => {
  const check = await checkResolver({
    address: '172.28.0.53',
    resolveNsImpl: () => Promise.reject(new Error('ETIMEOUT')),
  });
  assert.equal(check.state, 'fail');
  assert.match(check.detail, /внешним спискам/);
});

test('checkResolver: пустой ответ — тоже отказ', async () => {
  const check = await checkResolver({
    address: '172.28.0.53',
    resolveNsImpl: () => Promise.resolve([]),
  });
  assert.equal(check.state, 'fail');
});

test('checkResolver: резольвер не настроен — «неизвестно», а не «работает»', async () => {
  const check = await checkResolver({ address: '' });
  assert.equal(check.state, 'unknown');
  assert.match(check.detail, /RESOLVER_IP/);
});
