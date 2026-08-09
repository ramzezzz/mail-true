/**
 * Служебные строки журнала — то, что система пишет про саму себя.
 *
 * Проверка появилась после живого сервера: в «Журналах почты» и в «Ящиках
 * и доступе» шла сплошная лента отчётов проверки живости — по паре строк
 * каждые пять-десять секунд, — и настоящая доставка в ней терялась.
 *
 * Здесь закреплены обе стороны: служебное узнаётся, а настоящее НЕ
 * попадает под нож. Вторая половина важнее: скрыть чужой вход в ящик или
 * отказ доставки — хуже, чем показать лишний служебный стук.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isServiceNoise } from './mail-log.js';
import { queryFlag, querySchema, tailSchema } from './routes/logs.js';

const NOISE = [
  // Dovecot: проверка портов — соединение без единой попытки входа.
  'imap-login: Disconnected: Connection closed (no auth attempts in 0 secs): user=<>, rip=127.0.0.1, lip=127.0.0.1, secured, session=<QMSoa41Yjox/AAAB>',
  'imap-login: Disconnected: Aborted login by logging out (no auth attempts in 0 secs): user=<>, rip=172.28.0.9, lip=172.28.0.54',
  // Dovecot LMTP: поздоровались и разошлись, письма не было.
  'lmtp(43): Connect from 127.0.0.1',
  'lmtp(43): Disconnect from 127.0.0.1: Connection closed (state=GREETING)',
  // Postfix: соединение, закрытое сразу после QUIT.
  'connect from mailtrue-api-1.mailtrue_default[172.28.0.9]',
  'disconnect from mailtrue-api-1.mailtrue_default[172.28.0.9] quit=1 commands=1',
];

const REAL = [
  // Настоящая доставка.
  'D9A4F1A0B12: from=<ivan@example.ru>, size=2841, nrcpt=1 (queue active)',
  'D9A4F1A0B12: to=<admin@home.local>, relay=dovecot, delay=0.24, status=sent (delivered via dovecot service)',
  // Настоящий вход в ящик — тоже «Disconnected», но с попыткой входа.
  'imap-login: Login: user=<admin@home.local>, method=PLAIN, rip=203.0.113.7, lip=172.28.0.54, TLS',
  'imap-login: Disconnected: Inactivity (auth failed, 1 attempts in 12 secs): user=<admin@home.local>, rip=203.0.113.7',
  // Чужой сервер отдал письмо и попрощался — commands больше одной.
  'disconnect from mail.example.ru[203.0.113.9] ehlo=1 mail=1 rcpt=1 data=1 quit=1 commands=5',
  // Отказ доставки.
  'D9A4F1A0B12: to=<nobody@example.ru>, relay=none, status=bounced (Host not found)',
  // Подключение чужого сервера: похоже на служебное, но имя не наше.
  'connect from unknown[203.0.113.9]',
];

test('служебные строки узнаются', () => {
  for (const line of NOISE) {
    assert.equal(isServiceNoise(line), true, `не распознано как служебное: ${line}`);
  }
});

test('настоящие события не прячутся', () => {
  for (const line of REAL) {
    assert.equal(isServiceNoise(line), false, `настоящее событие принято за служебное: ${line}`);
  }
});

test('пустая строка служебной не считается', () => {
  assert.equal(isServiceNoise(''), false);
  assert.equal(isServiceNoise('   '), false);
});

/*
 * ФЛАЖОК «ПОКАЗЫВАТЬ СЛУЖЕБНЫЕ СТРОКИ» НЕ РАБОТАЛ ВООБЩЕ.
 *
 * В строке запроса всё — строки, и признак приходил как «false». В схеме
 * стояло `z.coerce.boolean()`, то есть `Boolean('false')`, а непустая
 * строка — истина. Отсев в log-files.ts не срабатывал ни разу: раздел
 * «Журналы» был завален отчётами проверок живости при любом положении
 * флажка, а весь разбор выше — про то, какие строки этот отсев прячет, —
 * держался ни на чём.
 *
 * Панель шлёт признак ВСЕГДА (query() в api/client.ts делает String(false)),
 * поэтому «просто не слать false» дефект не лечит.
 */
test('«false» из строки запроса означает НЕТ, а не «непустая строка»', () => {
  assert.equal(querySchema.parse({ serviceNoise: 'false' }).serviceNoise, false);
  assert.equal(tailSchema.parse({ serviceNoise: 'false', after: '0' }).serviceNoise, false);
  // И прочие написания «нет», которые может прислать кто угодно.
  assert.equal(querySchema.parse({ serviceNoise: '0' }).serviceNoise, false);
  assert.equal(querySchema.parse({ serviceNoise: '' }).serviceNoise, false);
});

test('«true» и «1» по-прежнему означают ДА', () => {
  assert.equal(querySchema.parse({ serviceNoise: 'true' }).serviceNoise, true);
  assert.equal(querySchema.parse({ serviceNoise: '1' }).serviceNoise, true);
  assert.equal(tailSchema.parse({ serviceNoise: 'true', after: '0' }).serviceNoise, true);
});

test('без признака служебные строки спрятаны', () => {
  assert.equal(querySchema.parse({}).serviceNoise, false);
});

/*
 * Тот же признак в истории антиспама.
 *
 * `spamOnly` разбирался через `z.coerce.boolean()` — то есть строка
 * «false» из запроса означала ИСТИНУ. В истории показывался только спам
 * при любом положении флажка, а ищут в ней обычно обратное: чистое
 * письмо, которое куда-то делось. Дефект тот же самый и уже третий по
 * счёту (список писем, журналы служб, теперь история) — поэтому разбор
 * общий, а не переписанный в третий раз.
 */
test('история антиспама: «false» из строки запроса — это ложь', () => {
  assert.equal(queryFlag.parse('false'), false);
  assert.equal(queryFlag.parse('0'), false);
  assert.equal(queryFlag.parse(undefined), false);
  assert.equal(queryFlag.parse('true'), true);
  assert.equal(queryFlag.parse('1'), true);
  assert.equal(queryFlag.parse(true), true);
});
