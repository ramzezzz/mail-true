/**
 * Проверки того, что связывает установщик с install/install.sh:
 * файл ответов, журнал, ключ доступа, разбор infra/.env.
 *
 * Каждая из этих мелочей уже умеет ломаться молча: кавычка в пароле,
 * возврат каретки в журнале, «\r» в файле настроек.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { InstallerKey, generateKey, normalizeKey } from './auth.js';
import { versionAtLeast } from './checks.js';
import { buildAnswersFile, explainFailure, shellQuote } from './install.js';
import { LogBuffer } from './logbuf.js';
import { parseEnv } from './state.js';
import { DEFAULT_PORTS, type Answers } from './validate.js';

function answers(overrides: Partial<Answers> = {}): Answers {
  return {
    domain: 'example.ru',
    hostname: 'mail.example.ru',
    adminEmail: 'admin@example.ru',
    adminLogin: 'admin',
    adminPassword: 'Xy7#kq2Lm9pR',
    adminPasswordRepeat: 'Xy7#kq2Lm9pR',
    tls: 'selfsigned',
    leEmail: '',
    customCert: '',
    customChain: '',
    customKey: '',
    bindAddress: '0.0.0.0',
    clamav: false,
    aiEnabled: true,
    ports: { ...DEFAULT_PORTS },
    subnet: '172.28.0.0/16',
    resolverIp: '172.28.0.53',
    dovecotIp: '172.28.0.54',
    messageMaxBytes: 26_214_400,
    uploadMaxBytes: 26_214_400,
    composeBodyMaxBytes: 12_582_912,
    defaultQuotaBytes: 1_073_741_824,
    ...overrides,
  };
}

test('пароль с кавычкой доезжает до install.sh целым', () => {
  // Файл ответов подключается через `. файл`, то есть разбирается bash-ом.
  // Апостроф в пароле без экранирования превратил бы файл в синтаксическую
  // ошибку, и установка упала бы на строке, к паролю отношения не имеющей.
  const quoted = shellQuote("па'роль$`\\");
  assert.equal(quoted, `'па'\\''роль$\`\\'`);

  const file = buildAnswersFile(answers({ adminPassword: "it's ok" }));
  assert.match(file, /MAILTRUE_ADMIN_PASSWORD='it'\\''s ok'/);
});

test('в файле ответов есть все порты, которые спрашивает мастер', () => {
  const file = buildAnswersFile(answers());
  for (const key of ['SMTP_PORT', 'IMAPS_PORT', 'NGINX_HTTPS_PORT', 'POSTGRES_PORT']) {
    assert.ok(file.includes(`MAILTRUE_${key}=`), `нет MAILTRUE_${key}`);
  }
});

test('антивирус передаётся словом, которое понимает install.sh', () => {
  assert.match(buildAnswersFile(answers({ clamav: true })), /MAILTRUE_CLAMAV=yes/);
  assert.match(buildAnswersFile(answers({ clamav: false })), /MAILTRUE_CLAMAV=no/);
});

test('журнал понимает возврат каретки так же, как терминал', () => {
  // install.sh перерисовывает строку ожидания: «ждём готовности: postgres…».
  // Без разбора «\r» в браузере вырастала бы стена одинаковых строк.
  const log = new LogBuffer();
  log.append('шаг\n');
  log.append('ждём: a\rждём: ab\rждём: abc\n');
  log.append('готово\n');
  assert.deepEqual(log.since(0).lines, ['шаг', 'ждём: abc', 'готово']);
});

test('журнал показывает незавершённую строку до перевода строки', () => {
  const log = new LogBuffer();
  log.append('идёт сборка');
  assert.deepEqual(log.since(0).lines, ['идёт сборка']);
  log.append(' — готово\n');
  assert.deepEqual(log.since(0).lines, ['идёт сборка — готово']);
});

test('журнал отдаёт только новые строки', () => {
  const log = new LogBuffer();
  log.append('раз\nдва\n');
  const first = log.since(0);
  assert.equal(first.next, 2);
  log.append('три\n');
  assert.deepEqual(log.since(first.next).lines, ['три']);
});

test('отказ пересказывается словами установщика, а не кодом', () => {
  const said = explainFailure(['что-то делали', 'Ошибка: не удалось поднять базу данных', ''], 1);
  assert.equal(said, 'не удалось поднять базу данных');

  const fallback = explainFailure(['последняя строка вывода'], 137);
  assert.match(fallback, /последняя строка вывода/);
  assert.match(fallback, /Повторить|повторить|идемпотент/);
});

test('ключ доступа читается глазами: без похожих символов', () => {
  for (let i = 0; i < 50; i += 1) {
    const key = generateKey();
    assert.match(key, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
    assert.ok(!/[IOL01]/.test(key), `в ключе не должно быть похожих символов: ${key}`);
  }
});

test('ключ сверяется без оглядки на регистр и пробелы', () => {
  const key = new InstallerKey('ABCD-EFGH');
  assert.equal(normalizeKey('  abcd-efgh '), 'ABCD-EFGH');
  assert.equal(key.verify(' abcd-efgh ').ok, true);
  assert.equal(key.verify('ABCD-EFGI').ok, false);
});

test('десять неверных ключей подряд закрывают установщик', () => {
  let now = 0;
  const key = new InstallerKey('ABCD-EFGH', () => now);
  for (let i = 0; i < 9; i += 1) {
    const verdict = key.verify('нет');
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /Осталось попыток/);
  }
  const locked = key.verify('нет');
  assert.equal(locked.ok, false);
  assert.match(locked.reason, /закрыт на 15 минут/);
  // И верный ключ в это время тоже не пускает — иначе запирать незачем.
  assert.equal(key.verify('ABCD-EFGH').ok, false);
  now += 16 * 60 * 1000;
  assert.equal(key.verify('ABCD-EFGH').ok, true);
});

test('разбор infra/.env переживает концы строк Windows', () => {
  // Файл-образец однажды уже уехал в репозиторий с CRLF: тогда
  // POSTGRES_USER становился «mailserver» с невидимым хвостом, и psql
  // отвечал «role does not exist» при полностью исправной базе.
  const env = parseEnv('POSTGRES_USER=mailserver\r\n# комментарий\r\nMAIL_DOMAIN=example.ru\r\n');
  assert.equal(env.get('POSTGRES_USER'), 'mailserver');
  assert.equal(env.get('POSTGRES_USER')?.length, 10);
  assert.equal(env.get('MAIL_DOMAIN'), 'example.ru');
  assert.equal(env.has('# комментарий'), false);
});

test('пустое значение в .env — это значение, а не отсутствие ключа', () => {
  const env = parseEnv('INSTALL_COMPLETED_AT=\n');
  assert.equal(env.has('INSTALL_COMPLETED_AT'), true);
  assert.equal(env.get('INSTALL_COMPLETED_AT'), '');
});

test('версия docker compose сравнивается по числам, а не по строкам', () => {
  assert.equal(versionAtLeast('2.24.1', '2.24'), true);
  assert.equal(versionAtLeast('2.9.0', '2.24'), false);
  assert.equal(versionAtLeast('2.24', '2.24'), true);
  assert.equal(versionAtLeast('5.2.0', '2.24'), true);
});
