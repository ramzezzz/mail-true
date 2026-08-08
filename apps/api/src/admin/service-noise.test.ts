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
