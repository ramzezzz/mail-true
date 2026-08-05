/**
 * Юнит-тесты автоопределения настроек чужого сервера по адресу.
 *
 * Сеть в тестах не трогается: загрузчик XML и DNS-резолвер подменяются.
 * Разбор проверяется на выводе НАШЕГО генератора автонастройки
 * (apps/autoconfig): это и есть доказательство, что формат один и тот же.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMailSettings,
  domainOf,
  findKnownProvider,
  guessSettings,
  parseClientConfigXml,
  settingsFromClientConfig,
  type LocalMailSettings,
} from './autodetect.js';

/**
 * Ровно то, что отдаёт apps/autoconfig/src/autoconfig.ts (clientConfig 1.1):
 * порядок элементов и набор тегов скопированы с его вывода.
 */
const CLIENT_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="other.example">
    <domain>other.example</domain>
    <displayName>Почта Другая</displayName>
    <displayShortName>Другая</displayShortName>
    <incomingServer type="imap">
      <hostname>mail.other.example</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>mail.other.example</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="pop3">
      <hostname>mail.other.example</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>mail.other.example</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>
`;

const LOCAL: LocalMailSettings = {
  domains: ['mail.local'],
  hostname: 'mail.local',
  imapPort: 993,
  imapSecure: true,
  smtpPort: 587,
  smtpSecure: false,
  label: 'Mail.True',
};

test('domainOf: домен из адреса', () => {
  assert.equal(domainOf('User@Example.COM'), 'example.com');
  assert.equal(domainOf('без-собаки'), '');
});

test('parseClientConfigXml: все серверы разобраны', () => {
  const { providerLabel, servers } = parseClientConfigXml(CLIENT_CONFIG_XML);
  assert.equal(providerLabel, 'Почта Другая');
  assert.equal(servers.length, 4);
  assert.deepEqual(servers[0], {
    kind: 'incoming',
    type: 'imap',
    hostname: 'mail.other.example',
    port: 993,
    socketType: 'SSL',
  });
});

test('settingsFromClientConfig: предпочитается IMAP поверх TLS', () => {
  const parsed = settingsFromClientConfig(CLIENT_CONFIG_XML, 'user@other.example');
  assert.ok(parsed);
  assert.deepEqual(parsed.imap, { host: 'mail.other.example', port: 993, secure: true });
  assert.deepEqual(parsed.smtp, { host: 'mail.other.example', port: 587, secure: false });
  assert.equal(parsed.username, 'user@other.example');
  assert.equal(parsed.confident, true);
});

test('settingsFromClientConfig: без IMAP настроек нет', () => {
  const onlyPop = CLIENT_CONFIG_XML.replace(/type="imap"/g, 'type="pop3"');
  assert.equal(settingsFromClientConfig(onlyPop, 'user@other.example'), null);
});

test('findKnownProvider: известные сервисы', () => {
  assert.equal(findKnownProvider('yandex.ru')?.label, 'Яндекс');
  assert.equal(findKnownProvider('GMAIL.COM')?.label, 'Gmail');
  assert.equal(findKnownProvider('bk.ru')?.label, 'Mail.ru');
  assert.equal(findKnownProvider('example.org'), null);
});

test('guessSettings: предположение помечено как ненадёжное', () => {
  const guessed = guessSettings('user@example.org');
  assert.deepEqual(guessed.imap, { host: 'imap.example.org', port: 993, secure: true });
  assert.deepEqual(guessed.smtp, { host: 'smtp.example.org', port: 587, secure: false });
  assert.equal(guessed.source, 'guess');
  assert.equal(guessed.confident, false);
});

test('detectMailSettings: известный сервис берётся без обращения в сеть', async () => {
  const detected = await detectMailSettings('ivan@yandex.ru', {
    fetchXml: () => {
      throw new Error('сеть не должна опрашиваться для известного сервиса');
    },
    resolveSrv: () => {
      throw new Error('DNS не должен опрашиваться для известного сервиса');
    },
  });
  assert.equal(detected.source, 'known');
  assert.equal(detected.providerLabel, 'Яндекс');
  assert.equal(detected.imap.host, 'imap.yandex.ru');
  assert.equal(detected.confident, true);
});

test('detectMailSettings: свой домен определяется точно', async () => {
  const detected = await detectMailSettings('test@mail.local', { local: LOCAL });
  assert.equal(detected.source, 'local');
  assert.deepEqual(detected.imap, { host: 'mail.local', port: 993, secure: true });
  assert.deepEqual(detected.smtp, { host: 'mail.local', port: 587, secure: false });
});

test('detectMailSettings: настройки берутся из clientConfig чужого сервера', async () => {
  const asked: string[] = [];
  const detected = await detectMailSettings('user@other.example', {
    local: LOCAL,
    fetchXml: async (url) => {
      asked.push(url);
      return url.startsWith('https://autoconfig.') ? CLIENT_CONFIG_XML : null;
    },
    resolveSrv: async () => [],
  });
  assert.equal(detected.source, 'autoconfig');
  assert.equal(detected.imap.host, 'mail.other.example');
  assert.equal(detected.providerLabel, 'Почта Другая');
  assert.equal(asked.length, 1, 'после успешного ответа остальные адреса не опрашиваются');
});

test('detectMailSettings: запасной путь — DNS SRV', async () => {
  const detected = await detectMailSettings('user@srv.example', {
    fetchXml: async () => null,
    resolveSrv: async (name) => {
      if (name === '_imaps._tcp.srv.example') {
        return [{ name: 'imap.srv.example', port: 993, priority: 10 }];
      }
      if (name === '_submission._tcp.srv.example') {
        return [{ name: 'smtp.srv.example', port: 587, priority: 10 }];
      }
      return [];
    },
  });
  assert.equal(detected.source, 'srv');
  assert.deepEqual(detected.imap, { host: 'imap.srv.example', port: 993, secure: true });
  assert.deepEqual(detected.smtp, { host: 'smtp.srv.example', port: 587, secure: false });
  assert.equal(detected.confident, true);
});

test('detectMailSettings: ничего не нашли — честное предположение', async () => {
  const detected = await detectMailSettings('user@nowhere.example', {
    fetchXml: async () => null,
    resolveSrv: async () => [],
  });
  assert.equal(detected.source, 'guess');
  assert.equal(detected.confident, false);
});

test('detectMailSettings: probeNetwork=false не ходит в сеть вовсе', async () => {
  const detected = await detectMailSettings('user@nowhere.example', {
    probeNetwork: false,
    fetchXml: () => {
      throw new Error('сеть запрещена');
    },
  });
  assert.equal(detected.source, 'guess');
});
