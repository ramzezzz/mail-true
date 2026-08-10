/**
 * Проверка разбора своего TLS-сертификата.
 *
 * Все случаи здесь — настоящие: сертификаты выпущены своим удостоверяющим
 * центром (см. tls-fixtures.ts), а не собраны из строк. Иначе проверка
 * сторожила бы разбор текста, а не то, ради чего написана: она обязана
 * ловить пару, которая не сходится, и цепочку, которой не хватает.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { X509Certificate } from 'node:crypto';
import {
  EXPIRY_WARN_DAYS,
  expectedCertificateNames,
  nameMatches,
  splitPem,
  validateCertificateBundle,
} from '../tls-certificate.js';
import {
  GOOD_CRT,
  GOOD_KEY,
  INTERMEDIATE_CRT,
  OTHER_KEY,
  PARTIAL_CRT,
  PARTIAL_KEY,
  ROOT_CRT,
} from './tls-fixtures.js';

const DOMAIN = 'mtweb.test';
const HOSTNAME = 'mail.mtweb.test';
const { required, optional } = expectedCertificateNames(DOMAIN, HOSTNAME);

/** Время, в котором сертификаты действуют: сразу после выпуска. */
const NOW = new Date(new X509Certificate(GOOD_CRT).validFrom);
NOW.setUTCDate(NOW.getUTCDate() + 1);

/** Свой корень «доверен» — так выглядит машина, которой его раздали. */
const TRUSTED = new Set([new X509Certificate(ROOT_CRT).subject]);

function check(overrides: Record<string, unknown> = {}) {
  return validateCertificateBundle({
    certificatePem: GOOD_CRT,
    privateKeyPem: GOOD_KEY,
    chainPem: `${INTERMEDIATE_CRT}\n${ROOT_CRT}`,
    expectedNames: required,
    optionalNames: optional,
    now: NOW,
    ...overrides,
  });
}

function ids(result: ReturnType<typeof check>, level: 'fail' | 'warn' | 'ok'): string[] {
  return result.issues.filter((i) => i.level === level).map((i) => i.id);
}

test('полный набор — сертификат, ключ и цепочка — принимается', () => {
  const result = check({ trustedRootSubjects: TRUSTED });
  assert.equal(result.ok, true, result.issues.map((i) => `${i.level}:${i.id}`).join(', '));
  assert.deepEqual(ids(result, 'fail'), []);
  assert.ok(result.fullchainPem.includes('BEGIN CERTIFICATE'));
  // В файл идут лист и промежуточный: именно это получат клиенты.
  assert.ok(splitPem(result.fullchainPem).length >= 2);
  assert.equal(result.certificate?.commonName, 'mail.mtweb.test');
});

test('ключ от другого сертификата — отказ, а не «применилось и не работает»', () => {
  // Самая дорогая ошибка: оба файла по отдельности исправны, службы
  // стартуют и перестают отвечать по TLS целиком.
  const result = check({ privateKeyPem: OTHER_KEY, trustedRootSubjects: TRUSTED });
  assert.equal(result.ok, false);
  assert.ok(ids(result, 'fail').includes('key-mismatch'));
  const issue = result.issues.find((i) => i.id === 'key-mismatch');
  assert.match(issue?.detail ?? '', /разная пара/);
  assert.match(issue?.hint ?? '', /openssl/);
  // Ничего не записываем: применить такую пару нельзя.
  assert.equal(result.fullchainPem, '');
});

test('без промежуточных сертификатов — отказ с названием того, чего не хватает', () => {
  // Браузер покажет зелёный замок (промежуточные у него свои), а Outlook
  // и Android скажут «недоверенный узел». Это и есть та ошибка, которую
  // ищут неделями со словами «у меня всё работает».
  const result = check({ chainPem: '', trustedRootSubjects: TRUSTED });
  assert.equal(result.ok, false);
  assert.ok(ids(result, 'fail').includes('chain-missing'));
  const issue = result.issues.find((i) => i.id === 'chain-missing');
  assert.match(issue?.detail ?? '', /Intermediate/);
  assert.match(issue?.hint ?? '', /Outlook/);
});

test('цепочка на собственный корень — предупреждение, а не отказ', () => {
  // Корпоративный удостоверяющий центр — законный случай: работать будет,
  // но только там, где его корень раздали.
  const result = check({ trustedRootSubjects: new Set<string>() });
  assert.equal(result.ok, true);
  assert.ok(ids(result, 'warn').includes('chain-private-root'));
});

test('имена, которых нет, называются поимённо и с последствиями', () => {
  const result = validateCertificateBundle({
    certificatePem: PARTIAL_CRT,
    privateKeyPem: PARTIAL_KEY,
    chainPem: `${INTERMEDIATE_CRT}\n${ROOT_CRT}`,
    expectedNames: required,
    optionalNames: optional,
    now: NOW,
    trustedRootSubjects: TRUSTED,
  });
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.id === 'names');
  assert.ok(issue, 'должна быть претензия к именам');
  assert.match(issue.detail, /admin\.mtweb\.test/);
  /*
   * autoconfig теперь желательный, а не обязательный: его отсутствие —
   * отдельное предупреждение, а не отказ. Претензии должны быть обе, и
   * каждая в своей строгости.
   */
  const optionalIssue = result.issues.find((i) => i.id === 'names-optional');
  assert.ok(optionalIssue, 'должно быть предупреждение про желательные имена');
  assert.equal(optionalIssue.level, 'warn');
  assert.match(optionalIssue.detail, /autoconfig\.mtweb\.test/);
  // Не просто «не хватает», а что именно перестанет работать.
  assert.match(issue.detail, /панель управления/);
  assert.match(optionalIssue.detail, /автонастройка/);
  assert.ok(result.missingNames.includes('admin.mtweb.test'));
});

test('истёкший сертификат отвергается, а истекающий скоро — предупреждает с датой', () => {
  const cert = new X509Certificate(GOOD_CRT);
  const after = new Date(cert.validTo);
  after.setUTCDate(after.getUTCDate() + 5);
  const expired = check({ now: after, trustedRootSubjects: TRUSTED });
  assert.equal(expired.ok, false);
  assert.ok(ids(expired, 'fail').includes('expired'));

  const soon = new Date(cert.validTo);
  soon.setUTCDate(soon.getUTCDate() - (EXPIRY_WARN_DAYS - 5));
  const warning = check({ now: soon, trustedRootSubjects: TRUSTED });
  assert.equal(warning.ok, true);
  const issue = warning.issues.find((i) => i.id === 'expiring');
  assert.ok(issue, 'должно быть предупреждение о сроке');
  assert.match(issue.detail, /\d{4}/, 'в предупреждении обязана быть дата');
});

test('сертификат, который ещё не начал действовать, тоже отвергается', () => {
  const before = new Date(new X509Certificate(GOOD_CRT).validFrom);
  before.setUTCDate(before.getUTCDate() - 3);
  const result = check({ now: before, trustedRootSubjects: TRUSTED });
  assert.equal(result.ok, false);
  assert.ok(ids(result, 'fail').includes('not-yet-valid'));
});

test('не-PEM отвергается понятными словами и командой перевода', () => {
  // Самое частое: присылают .pfx или DER.
  const der = Buffer.from(new X509Certificate(GOOD_CRT).raw).toString('binary');
  const result = check({ certificatePem: der });
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.id === 'format');
  assert.match(issue?.detail ?? '', /двоичный|DER|PKCS#12/);
  assert.match(issue?.hint ?? '', /openssl pkcs12/);
});

test('ключ не в PEM отвергается отдельно от сертификата', () => {
  const result = check({ privateKeyPem: 'просто текст' });
  assert.equal(result.ok, false);
  assert.ok(ids(result, 'fail').includes('key-format'));
});

test('цепочка может прийти одним файлом вместе с сертификатом', () => {
  // Удостоверяющие центры отдают и так, и так — обе формы обязаны работать.
  const result = check({
    certificatePem: `${GOOD_CRT}\n${INTERMEDIATE_CRT}\n${ROOT_CRT}`,
    chainPem: '',
    trustedRootSubjects: TRUSTED,
  });
  assert.equal(result.ok, true, result.issues.map((i) => `${i.level}:${i.id}`).join(', '));
});

test('подстановочное имя покрывает один уровень, а не любой', () => {
  assert.equal(nameMatches('*.example.ru', 'mail.example.ru'), true);
  assert.equal(nameMatches('*.example.ru', 'a.b.example.ru'), false);
  assert.equal(nameMatches('*.example.ru', 'example.ru'), false);
  assert.equal(nameMatches('mail.example.ru', 'mail.example.ru'), true);
  assert.equal(nameMatches('MAIL.EXAMPLE.RU', 'mail.example.ru'), true);
});

test('обязательны почта, панель и имя сервера; автонастройка — желательна', () => {
  /*
   * autoconfig переехал в желательные. Без него почтовые программы не
   * заберут настройки сами, и человек введёт адреса руками — это
   * неудобство, а не неработающая почта. Пока он был обязательным,
   * панель отказывалась ставить рабочий коммерческий сертификат на
   * mail. + admin. + имя сервера: любой «отказ» закрывает применение
   * целиком, и человек уходил копировать файлы по ssh мимо всех
   * проверок.
   */
  const names = expectedCertificateNames('example.ru', 'mx1.example.ru');
  assert.deepEqual(names.required, ['mx1.example.ru', 'mail.example.ru', 'admin.example.ru']);
  assert.deepEqual(names.optional, [
    'example.ru',
    'autoconfig.example.ru',
    'autodiscover.example.ru',
  ]);
});
