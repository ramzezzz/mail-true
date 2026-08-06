/** Тесты Microsoft Autodiscover: разбор запроса Outlook и формирование ответа. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutodiscoverError,
  buildAutodiscoverResponse,
  parseAutodiscoverRequest,
} from './autodiscover.js';
import { parseXml, testSettings } from './testutil.js';

const OUTLOOK_REQUEST = `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>test@mail.local</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;

test('autodiscover: разбор запроса Outlook', () => {
  const parsed = parseAutodiscoverRequest(OUTLOOK_REQUEST);
  assert.equal(parsed.email, 'test@mail.local');
  assert.match(parsed.schema ?? '', /responseschema\/2006a/);
});

test('autodiscover: разбор нечувствителен к регистру тегов', () => {
  const parsed = parseAutodiscoverRequest(
    '<autodiscover><request><emailaddress> user@mail.local </emailaddress></request></autodiscover>',
  );
  assert.equal(parsed.email, 'user@mail.local');
});

test('autodiscover: запрос без адреса', () => {
  assert.equal(parseAutodiscoverRequest('<Autodiscover/>').email, null);
});

test('autodiscover: ответ — валидный XML со схемой Outlook', () => {
  const xml = buildAutodiscoverResponse(testSettings, 'test@mail.local');
  const doc = parseXml(xml);

  const root = doc.documentElement;
  assert.equal(root.tagName, 'Autodiscover');
  assert.equal(
    root.getAttribute('xmlns'),
    'http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006',
  );
  const response = root.getElementsByTagName('Response')[0];
  assert.ok(response, 'нет Response');
  assert.equal(
    response.getAttribute('xmlns'),
    'http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a',
  );

  const account = response.getElementsByTagName('Account')[0];
  assert.ok(account, 'нет Account');
  assert.equal(account.getElementsByTagName('AccountType')[0]?.textContent, 'email');
  assert.equal(account.getElementsByTagName('Action')[0]?.textContent, 'settings');

  const protocols = [...account.getElementsByTagName('Protocol')];
  const byType = new Map(protocols.map((p) => [p.getElementsByTagName('Type')[0]?.textContent, p]));
  assert.deepEqual([...byType.keys()].sort(), ['IMAP', 'POP3', 'SMTP']);

  const imap = byType.get('IMAP')!;
  assert.equal(imap.getElementsByTagName('Server')[0]?.textContent, 'mail.local');
  assert.equal(imap.getElementsByTagName('Port')[0]?.textContent, '993');
  assert.equal(imap.getElementsByTagName('SSL')[0]?.textContent, 'on');
  assert.equal(imap.getElementsByTagName('LoginName')[0]?.textContent, 'test@mail.local');

  const smtp = byType.get('SMTP')!;
  assert.equal(smtp.getElementsByTagName('Port')[0]?.textContent, '587');
  assert.equal(smtp.getElementsByTagName('Encryption')[0]?.textContent, 'TLS');

  const pop3 = byType.get('POP3')!;
  assert.equal(pop3.getElementsByTagName('Port')[0]?.textContent, '995');
});

test('autodiscover: ответ-ошибка валиден и содержит код', () => {
  const doc = parseXml(buildAutodiscoverError(600, 'Invalid Request'));
  assert.equal(doc.getElementsByTagName('ErrorCode')[0]?.textContent, '600');
  assert.equal(doc.getElementsByTagName('Message')[0]?.textContent, 'Invalid Request');
});
