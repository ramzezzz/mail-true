/**
 * Живая проверка сервиса автонастройки: обходит все точки и проверяет
 * XML-ответы настоящим разбором (jsdom), а не «на глаз» — почтовые клиенты
 * молча отбрасывают невалидный XML.
 *
 * Запуск:  node dist/smoke.js [базовый URL] [Host-заголовок]
 *   node dist/smoke.js http://127.0.0.1:8025            # сервис напрямую
 *   node dist/smoke.js http://127.0.0.1:8080 autoconfig.mail.local  # через nginx
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const base = process.argv[2] ?? 'http://127.0.0.1:8025';
const hostHeader = process.argv[3];
const domain = process.env['MAIL_DOMAIN'] ?? 'mail.local';
const email = process.env['SMOKE_EMAIL'] ?? `test@${domain}`;

let pass = 0;
let fail = 0;
const ok = (msg: string): void => {
  console.log(`  [OK] ${msg}`);
  pass++;
};
const bad = (msg: string): void => {
  console.error(`  [FAIL] ${msg}`);
  fail++;
};

function parseXmlStrict(xml: string): Document {
  const dom = new JSDOM();
  const doc = new dom.window.DOMParser().parseFromString(xml, 'text/xml');
  assert.equal(
    doc.getElementsByTagName('parsererror').length,
    0,
    `невалидный XML: ${xml.slice(0, 200)}`
  );
  return doc;
}

/**
 * HTTP-запрос через node:http (не fetch): fetch/undici игнорирует ручной
 * заголовок Host, а он нужен для проверки виртуальных хостов nginx.
 */
function req(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; type: string; body: string }> {
  const url = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: init?.method ?? 'GET',
        headers: { ...init?.headers, ...(hostHeader ? { host: hostHeader } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers['content-type'] ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    r.on('error', reject);
    if (init?.body) r.write(init.body);
    r.end();
  });
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(`${name}: ${(err as Error).message}`);
  }
}

console.log(`Проверка ${base}${hostHeader ? ` (Host: ${hostHeader})` : ''}, домен ${domain}`);

await check('healthz', async () => {
  const r = await req('/healthz');
  assert.equal(r.status, 200);
  assert.match(r.body, /"ok":true/);
});

await check('Mozilla Autoconfig: /mail/config-v1.1.xml — валидный clientConfig 1.1', async () => {
  const r = await req(`/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`);
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/xml/);
  const doc = parseXmlStrict(r.body);
  assert.equal(doc.documentElement.tagName, 'clientConfig');
  assert.equal(doc.documentElement.getAttribute('version'), '1.1');
  assert.ok(doc.getElementsByTagName('incomingServer').length >= 2, 'нет incomingServer');
  assert.ok(doc.getElementsByTagName('outgoingServer').length >= 1, 'нет outgoingServer');
});

await check('Mozilla Autoconfig: путь /.well-known/autoconfig/...', async () => {
  const r = await req('/.well-known/autoconfig/mail/config-v1.1.xml');
  assert.equal(r.status, 200);
  parseXmlStrict(r.body);
});

const OUTLOOK_BODY = `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>${email}</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;

await check('Autodiscover: POST /autodiscover/autodiscover.xml', async () => {
  const r = await req('/autodiscover/autodiscover.xml', {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: OUTLOOK_BODY,
  });
  assert.equal(r.status, 200);
  const doc = parseXmlStrict(r.body);
  const types = [...doc.getElementsByTagName('Type')].map((t) => t.textContent);
  assert.deepEqual(types.sort(), ['IMAP', 'POP3', 'SMTP']);
  assert.equal(doc.getElementsByTagName('LoginName')[0]?.textContent, email);
});

await check('Autodiscover: заглавные буквы в пути (Outlook)', async () => {
  const r = await req('/Autodiscover/Autodiscover.xml', {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: OUTLOOK_BODY,
  });
  assert.equal(r.status, 200);
  assert.ok(parseXmlStrict(r.body).getElementsByTagName('Protocol').length >= 3);
});

await check('Autodiscover: GET с адресом в query', async () => {
  const r = await req(`/autodiscover/autodiscover.xml?Email=${encodeURIComponent(email)}`);
  assert.equal(r.status, 200);
  assert.ok(parseXmlStrict(r.body).getElementsByTagName('Protocol').length >= 3);
});

await check('Autodiscover: POST без адреса -> XML-ошибка 600', async () => {
  const r = await req('/autodiscover/autodiscover.xml', {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: '<Autodiscover/>',
  });
  assert.equal(r.status, 200);
  assert.equal(parseXmlStrict(r.body).getElementsByTagName('ErrorCode')[0]?.textContent, '600');
});

await check('Профиль Apple: /mobileconfig — валидный plist и Content-Type', async () => {
  const r = await req(`/mobileconfig?email=${encodeURIComponent(email)}`);
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/x-apple-aspen-config/);
  const doc = parseXmlStrict(r.body);
  assert.equal(doc.documentElement.tagName, 'plist');
  assert.match(r.body, /EmailTypeIMAP/);
});

await check('DNS: /api/dns-records — полный набор с DKIM из rspamd', async () => {
  const r = await req(`/api/dns-records?domain=${domain}`);
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body) as {
    records: Array<{ name: string; type: string; value: string; ready: boolean }>;
  };
  const names = data.records.map((x) => `${x.type} ${x.name}`);
  for (const need of [
    'MX @',
    'TXT @',
    'TXT _dmarc',
    'CNAME autoconfig',
    'CNAME autodiscover',
    'SRV _imaps._tcp',
    'SRV _submission._tcp',
    'SRV _pop3s._tcp',
    'SRV _autodiscover._tcp',
  ]) {
    assert.ok(names.includes(need), `нет записи ${need}`);
  }
  const dkim = data.records.find((x) => x.name.endsWith('._domainkey'));
  assert.ok(dkim, 'нет DKIM-записи');
  assert.ok(dkim.ready, 'DKIM-ключ не прочитан из тома rspamd');
  assert.match(dkim.value, /^v=DKIM1;.*p=[A-Za-z0-9+/]/, 'DKIM без публичного ключа');
});

await check('DNS: /api/dns-check — отвечает и корректно помечает статусы', async () => {
  const r = await req(`/api/dns-check?domain=${domain}`);
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body) as {
    results: Array<{ status: string }>;
    summary: { ok: number; problems: number };
  };
  assert.equal(data.results.length, 10);
  assert.equal(data.summary.ok + data.summary.problems, 10);
});

await check('Страница помощи: GET /', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.body, /Настройка почтовых программ/);
  assert.match(r.body, /993/);
});

console.log(`\nИтого: ${pass} OK, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
