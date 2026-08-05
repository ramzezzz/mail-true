/** Общие помощники для юнит-тестов (не содержит самих тестов). */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { MailSettings } from './config.js';

export const testSettings: MailSettings = {
  domain: 'mail.local',
  hostname: 'mail.local',
  providerName: 'Mail.True',
  providerShortName: 'Mail.True',
  imap: { sslPort: 993, startTlsPort: 143 },
  pop3: { sslPort: 995, startTlsPort: 110 },
  smtp: { startTlsPort: 587 },
  dkimSelector: 'mail',
  dkimDnsDir: '/nonexistent',
  dmarcRua: 'postmaster@mail.local',
  dnsTtl: 3600,
};

/** Строгий разбор XML: jsdom вставляет parsererror при любой ошибке разметки. */
export function parseXml(xml: string): Document {
  const dom = new JSDOM();
  const doc = new dom.window.DOMParser().parseFromString(xml, 'text/xml');
  const err = doc.getElementsByTagName('parsererror');
  assert.equal(err.length, 0, `XML не разбирается: ${err[0]?.textContent ?? ''}`);
  return doc;
}
