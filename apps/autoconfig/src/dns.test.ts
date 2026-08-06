/** Тесты формирования набора DNS-записей и разбора DKIM-файла rspamd. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDnsRecords, buildZoneFile, parseDkimDnsTxt } from './dns.js';
import { testSettings } from './testutil.js';

// Реальный формат вывода rspamadm dkim_keygen (значение разбито на строки)
const RSPAMD_DNS_TXT = `mail._domainkey IN TXT ( "v=DKIM1; k=rsa; "
\t"p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0jawqKcBkxLp"
\t"XM4E6s9CrFafL2JX2hwOyIkAQAB"
) ;`;

test('dkim: склейка многострочного значения из файла rspamd', () => {
  const value = parseDkimDnsTxt(RSPAMD_DNS_TXT);
  assert.ok(value);
  assert.match(
    value,
    /^v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0jawqKcBkxLpXM4E6s9CrFafL2JX2hwOyIkAQAB$/,
  );
});

test('dkim: мусор на входе -> null', () => {
  assert.equal(parseDkimDnsTxt('no dkim here'), null);
  assert.equal(parseDkimDnsTxt(''), null);
});

test('dns-records: полный набор записей', () => {
  const dkim = parseDkimDnsTxt(RSPAMD_DNS_TXT);
  const records = buildDnsRecords(testSettings, 'mail.local', dkim);

  const find = (name: string, type: string) =>
    records.find((r) => r.name === name && r.type === type);

  assert.equal(find('@', 'MX')?.value, '10 mail.local.');
  assert.equal(find('@', 'TXT')?.value, 'v=spf1 mx ~all');
  assert.match(find('mail._domainkey', 'TXT')?.value ?? '', /^v=DKIM1; k=rsa; p=/);
  assert.equal(find('mail._domainkey', 'TXT')?.ready, true);
  assert.match(
    find('_dmarc', 'TXT')?.value ?? '',
    /^v=DMARC1; p=quarantine; rua=mailto:postmaster@mail\.local/,
  );
  assert.equal(find('autoconfig', 'CNAME')?.value, 'mail.local.');
  assert.equal(find('autodiscover', 'CNAME')?.value, 'mail.local.');
  assert.equal(find('_imaps._tcp', 'SRV')?.value, '0 1 993 mail.local.');
  assert.equal(find('_submission._tcp', 'SRV')?.value, '0 1 587 mail.local.');
  assert.equal(find('_pop3s._tcp', 'SRV')?.value, '0 1 995 mail.local.');
  assert.equal(find('_autodiscover._tcp', 'SRV')?.value, '0 0 443 mail.local.');
  assert.equal(records.length, 10);
});

test('dns-records: без DKIM-ключа запись помечается как не готовая', () => {
  const records = buildDnsRecords(testSettings, 'mail.local', null);
  const dkim = records.find((r) => r.name === 'mail._domainkey');
  assert.equal(dkim?.ready, false);
});

test('zone-file: длинные TXT разбиваются на 255-символьные строки', () => {
  const longValue = 'v=DKIM1; k=rsa; p=' + 'A'.repeat(400);
  const records = buildDnsRecords(testSettings, 'mail.local', longValue);
  const zone = buildZoneFile(testSettings, 'mail.local', records);
  assert.match(zone, /\$ORIGIN mail\.local\./);
  assert.match(zone, /@\t3600\tIN\tMX\t10 mail\.local\./);
  // Значение DKIM > 255 символов — обязана появиться скобочная запись
  assert.match(zone, /\( "/);
  for (const chunk of zone.split('"').filter((_, i) => i % 2 === 1)) {
    assert.ok(chunk.length <= 255, `строка TXT длиннее 255: ${chunk.length}`);
  }
});
