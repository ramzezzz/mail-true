/**
 * Тесты отписки от рассылки: разбор заголовков и защита от похода
 * во внутреннюю сеть по адресу из письма.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canUnsubscribe,
  isPrivateAddress,
  isSafeUnsubscribeUrl,
  parseUnsubscribe,
} from './unsubscribe.js';
import { parseMessageHeaders } from './parse.js';

const NEWSLETTER = Buffer.from(
  [
    'From: Рассылка <news@example.com>',
    'To: test@mail.local',
    'Subject: Еженедельная рассылка',
    'Return-Path: <bounce@example.com>',
    'List-Id: Weekly <weekly.example.com>',
    'List-Unsubscribe: <https://example.com/u?id=1>, <mailto:unsub@example.com?subject=stop>',
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'X-Mailer: TestMailer 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'текст',
    '',
  ].join('\r\n'),
  'utf8'
);

/**
 * Главный случай. mailparser сводит всю группу `list-*` в один разобранный
 * объект под ключом `list`, поэтому `headers.get('list-unsubscribe')`
 * возвращал undefined, а проверка `typeof === 'string'` отбрасывала и объект
 * `list`, и `return-path` (он разбирается в адресный объект). Письмо рассылки
 * приходило с `headers: {}` — кнопка «Отписаться» была недостижима в принципе.
 */
test('заголовки отписки доходят до клиента', async () => {
  const headers = await parseMessageHeaders(NEWSLETTER);
  assert.equal(
    headers['list-unsubscribe'],
    '<https://example.com/u?id=1>, <mailto:unsub@example.com?subject=stop>'
  );
  assert.equal(headers['list-unsubscribe-post'], 'List-Unsubscribe=One-Click');
  assert.equal(headers['list-id'], 'Weekly <weekly.example.com>');
});

test('Return-Path тоже перестал теряться', async () => {
  const headers = await parseMessageHeaders(NEWSLETTER);
  assert.equal(headers['return-path'], '<bounce@example.com>');
});

test('имена заголовков — строго в нижнем регистре', async () => {
  const headers = await parseMessageHeaders(NEWSLETTER);
  for (const name of Object.keys(headers)) {
    assert.equal(name, name.toLowerCase(), `заголовок ${name} не в нижнем регистре`);
  }
  assert.equal(headers['x-mailer'], 'TestMailer 1.0');
});

test('свёрнутый заголовок склеивается в одну строку', async () => {
  const folded = Buffer.from(
    [
      'From: a@example.com',
      'Subject: тема',
      'List-Unsubscribe: <https://example.com/very/long/link>,',
      "\t<mailto:unsub@example.com>",
      'Content-Type: text/plain',
      '',
      'тело',
      '',
    ].join('\r\n'),
    'utf8'
  );
  const headers = await parseMessageHeaders(folded);
  assert.equal(
    headers['list-unsubscribe'],
    '<https://example.com/very/long/link>, <mailto:unsub@example.com>'
  );
});

test('обычное письмо заголовков отписки не получает', async () => {
  const plain = Buffer.from(
    ['From: a@example.com', 'Subject: привет', 'Content-Type: text/plain', '', 'тело', ''].join(
      '\r\n'
    ),
    'utf8'
  );
  const headers = await parseMessageHeaders(plain);
  assert.equal(canUnsubscribe(headers), false);
});

// --- Разбор значения ---

test('разбирается и ссылка, и почтовый адрес, и признак одного клика', () => {
  const info = parseUnsubscribe({
    'list-unsubscribe': '<https://example.com/u?id=1>, <mailto:unsub@example.com?subject=stop&body=go>',
    'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
  });
  assert.equal(info.url, 'https://example.com/u?id=1');
  assert.equal(info.mailto?.address, 'unsub@example.com');
  assert.equal(info.mailto?.subject, 'stop');
  assert.equal(info.mailto?.body, 'go');
  assert.equal(info.oneClick, true);
});

test('без заголовка List-Unsubscribe-Post отписки в один клик нет', () => {
  const info = parseUnsubscribe({ 'list-unsubscribe': '<https://example.com/u>' });
  assert.equal(info.oneClick, false);
  assert.equal(info.url, 'https://example.com/u');
});

test('один клик по незащищённой ссылке не предлагается', () => {
  const info = parseUnsubscribe({
    'list-unsubscribe': '<http://example.com/u>',
    'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
  });
  assert.equal(info.oneClick, false, 'RFC 8058 требует https');
});

test('только почтовый адрес — тоже способ отписаться', () => {
  const info = parseUnsubscribe({ 'list-unsubscribe': '<mailto:unsub@example.com>' });
  assert.equal(info.url, null);
  assert.equal(info.mailto?.address, 'unsub@example.com');
  assert.equal(info.mailto?.subject, null);
});

test('мусор в заголовке не роняет разбор', () => {
  assert.deepEqual(parseUnsubscribe({}), { url: null, mailto: null, oneClick: false });
  assert.deepEqual(parseUnsubscribe({ 'list-unsubscribe': '' }), {
    url: null,
    mailto: null,
    oneClick: false,
  });
  const info = parseUnsubscribe({ 'list-unsubscribe': '<ftp://example.com/x>, <mailto:без-собаки>' });
  assert.equal(info.url, null);
  assert.equal(info.mailto, null);
});

// --- Защита от похода во внутреннюю сеть ---

/**
 * Адрес отписки приходит из письма, то есть от кого угодно, а сервер стоит
 * внутри стека рядом с Dovecot, Postgres и Redis. Запрос с сервера по такому
 * адресу без проверки — это SSRF.
 */
test('во внутреннюю сеть по адресу из письма сервер не ходит', () => {
  for (const url of [
    'https://127.0.0.1/u',
    'https://10.0.0.5/u',
    'https://192.168.1.1/u',
    'https://[::1]/u',
    'https://localhost/u',
    'https://mail-postgres/u',
    'http://example.com/u',
    'https://user:pass@example.com/u',
    'https://example.com:8443/u',
    'не адрес вовсе',
  ]) {
    assert.equal(isSafeUnsubscribeUrl(url), false, `${url} нельзя считать безопасным`);
  }
});

test('обычная ссылка отписки принимается', () => {
  assert.equal(isSafeUnsubscribeUrl('https://example.com/unsubscribe?id=1'), true);
  assert.equal(isSafeUnsubscribeUrl('https://news.example.com:443/u'), true);
});

test('частные диапазоны опознаются по разрешённому адресу', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} — внутренний адрес`);
  }
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:2800:220:1::248:1946']) {
    assert.equal(isPrivateAddress(address), false, `${address} — внешний адрес`);
  }
});
