/** Тесты формирования профиля Apple (.mobileconfig, XML plist). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMobileConfig, stableUuid } from './mobileconfig.js';
import { parseXml, testSettings } from './testutil.js';

/** Достаёт значение по ключу из plist-словаря (следующий элемент после <key>). */
function plistValue(doc: Document, key: string): { tag: string; text: string } | null {
  for (const el of doc.getElementsByTagName('key')) {
    if (el.textContent === key) {
      const next = el.nextElementSibling;
      if (next) return { tag: next.tagName, text: next.textContent ?? '' };
    }
  }
  return null;
}

test('mobileconfig: валидный plist с настройками IMAP/SMTP', () => {
  const xml = buildMobileConfig(testSettings, 'test@mail.local');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  const doc = parseXml(xml);

  assert.equal(doc.documentElement.tagName, 'plist');
  assert.equal(doc.documentElement.getAttribute('version'), '1.0');

  assert.deepEqual(plistValue(doc, 'EmailAccountType'), { tag: 'string', text: 'EmailTypeIMAP' });
  assert.deepEqual(plistValue(doc, 'EmailAddress'), { tag: 'string', text: 'test@mail.local' });
  assert.deepEqual(plistValue(doc, 'IncomingMailServerHostName'), { tag: 'string', text: 'mail.local' });
  assert.deepEqual(plistValue(doc, 'IncomingMailServerPortNumber'), { tag: 'integer', text: '993' });
  assert.equal(plistValue(doc, 'IncomingMailServerUseSSL')?.tag, 'true');
  assert.deepEqual(plistValue(doc, 'OutgoingMailServerPortNumber'), { tag: 'integer', text: '587' });
  assert.equal(plistValue(doc, 'OutgoingPasswordSameAsIncomingPassword')?.tag, 'true');
  assert.deepEqual(plistValue(doc, 'PayloadType'), { tag: 'string', text: 'com.apple.mail.managed' });
});

test('mobileconfig: UUID детерминированы и различны для profile/payload', () => {
  const a = buildMobileConfig(testSettings, 'test@mail.local');
  const b = buildMobileConfig(testSettings, 'test@mail.local');
  assert.equal(a, b, 'повторная генерация должна давать идентичный профиль');

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const u1 = stableUuid('payload:test@mail.local');
  const u2 = stableUuid('profile:test@mail.local');
  assert.match(u1, uuidRe);
  assert.match(u2, uuidRe);
  assert.notEqual(u1, u2);
  assert.notEqual(stableUuid('payload:other@mail.local'), u1);
});

test('mobileconfig: PayloadIdentifier профиля свой у каждого ящика', () => {
  // iOS и macOS считают профили с одинаковым PayloadIdentifier одним и тем
  // же: с константой установка профиля для второго ящика того же сервера
  // ЗАМЕНЯЛА первый вместо добавления.
  const ids = (email: string): string[] => {
    const doc = parseXml(buildMobileConfig(testSettings, email));
    const out: string[] = [];
    for (const el of doc.getElementsByTagName('key')) {
      if (el.textContent === 'PayloadIdentifier') out.push(el.nextElementSibling?.textContent ?? '');
    }
    return out;
  };

  const first = ids('ivanov@mail.local');
  const second = ids('petrov@mail.local');
  assert.equal(first.length, 2, 'ожидались идентификаторы полезной нагрузки и профиля');
  assert.equal(second.length, 2);

  for (let i = 0; i < first.length; i++) {
    assert.notEqual(first[i], second[i], `PayloadIdentifier #${i} одинаков у разных ящиков`);
    assert.match(first[i] ?? '', /^local\.mail\.mailprofile\./);
  }
  // Один и тот же ящик — тот же идентификатор (повторная установка обновляет)
  assert.deepEqual(ids('ivanov@mail.local'), first);
});

test('mobileconfig: спецсимволы в адресе экранируются', () => {
  const xml = buildMobileConfig(testSettings, "o'brien&co@mail.local");
  parseXml(xml); // не должен падать
  assert.ok(xml.includes('o&apos;brien&amp;co@mail.local'));
});
