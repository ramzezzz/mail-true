/** Тесты формирования XML Mozilla Autoconfig (clientConfig 1.1). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClientConfigXml } from './autoconfig.js';
import { parseXml, testSettings } from './testutil.js';

test('clientConfig: валидный XML со строгой структурой', () => {
  const xml = buildClientConfigXml(testSettings, 'user@mail.local');
  const doc = parseXml(xml);

  const root = doc.documentElement;
  assert.equal(root.tagName, 'clientConfig');
  assert.equal(root.getAttribute('version'), '1.1');

  const provider = root.getElementsByTagName('emailProvider')[0];
  assert.ok(provider, 'нет emailProvider');
  assert.equal(provider.getAttribute('id'), 'mail.local');
  assert.equal(provider.getElementsByTagName('domain')[0]?.textContent, 'mail.local');

  const incoming = [...provider.getElementsByTagName('incomingServer')];
  assert.equal(
    incoming.length,
    4,
    'должно быть 4 incomingServer (IMAP SSL/STARTTLS, POP3 SSL/STARTTLS)',
  );
  assert.deepEqual(
    incoming.map((s) => [s.getAttribute('type'), s.getElementsByTagName('port')[0]?.textContent]),
    [
      ['imap', '993'],
      ['imap', '143'],
      ['pop3', '995'],
      ['pop3', '110'],
    ],
  );

  // Порядок дочерних элементов сервера строго фиксирован
  const first = incoming[0]!;
  assert.deepEqual(
    [...first.children].map((c) => c.tagName),
    ['hostname', 'port', 'socketType', 'username', 'authentication'],
  );
  assert.equal(first.getElementsByTagName('socketType')[0]?.textContent, 'SSL');
  assert.equal(first.getElementsByTagName('username')[0]?.textContent, '%EMAILADDRESS%');
  assert.equal(first.getElementsByTagName('authentication')[0]?.textContent, 'password-cleartext');

  // Два исходящих сервера: 587 STARTTLS (основной — клиент берёт первый)
  // и 465 «TLS сразу» для тех, кто предпочитает или умеет только его.
  const outgoing = [...provider.getElementsByTagName('outgoingServer')];
  assert.equal(outgoing.length, 2);
  assert.equal(outgoing[0]!.getAttribute('type'), 'smtp');
  assert.equal(outgoing[0]!.getElementsByTagName('port')[0]?.textContent, '587');
  assert.equal(outgoing[0]!.getElementsByTagName('socketType')[0]?.textContent, 'STARTTLS');
  assert.equal(outgoing[1]!.getElementsByTagName('port')[0]?.textContent, '465');
  assert.equal(outgoing[1]!.getElementsByTagName('socketType')[0]?.textContent, 'SSL');
});

test('clientConfig: алиасный домен добавляется вторым <domain>', () => {
  const doc = parseXml(buildClientConfigXml(testSettings, 'user@alias.example'));
  const domains = [...doc.getElementsByTagName('domain')].map((d) => d.textContent);
  assert.deepEqual(domains, ['mail.local', 'alias.example']);
});

test('clientConfig: без адреса — один домен, XML валиден', () => {
  const doc = parseXml(buildClientConfigXml(testSettings));
  assert.equal(doc.getElementsByTagName('domain').length, 1);
});
