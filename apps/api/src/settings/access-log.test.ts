/**
 * Разбор истории входов — на НАСТОЯЩИХ строках журналов.
 *
 * Строки ниже сняты с работающего стенда (`docker compose exec api
 * tail /var/log/mail/dovecot.log`), а не придуманы: проверка, написанная
 * по нашему представлению о журнале, сторожила бы это представление, а не
 * журнал. Именно на выдуманных строках такие разборы и ломаются молча.
 *
 * Отдельно проверяется то, ради чего раздел вообще существует:
 * владелец ящика видит ТОЛЬКО свои события.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeIp,
  dovecotAccessFromParts,
  isPrivateIp,
  markService,
  mergeAccessEvents,
  normalizeIp,
  ownAddresses,
  parseDovecotAccess,
  parsePostfixAccess,
  resetOwnAddresses,
  type AccessEvent,
} from './access-log.js';

/** «Сейчас» для разбора: в syslog-строке года нет, он берётся отсюда. */
const NOW = new Date('2026-08-06T20:00:00Z');

test('удачный вход по IMAP разбирается со всеми полями', () => {
  const line =
    'Aug 06 17:43:13 imap-login: Info: Login: user=<test@mail.local>, method=PLAIN, ' +
    'rip=172.31.0.9, lip=172.31.0.54, mpid=8488, TLS, session=<Q00QbGRYqOOsHwAJ>';
  const event = parseDovecotAccess(line, NOW);
  assert.ok(event);
  assert.equal(event.channel, 'imap');
  assert.equal(event.success, true);
  assert.equal(event.ip, '172.31.0.9');
  assert.equal(event.origin, 'dovecot');
});

test('вход по POP3 отличается от входа по IMAP', () => {
  const line =
    'Aug 06 17:43:13 pop3-login: Info: Login: user=<test@mail.local>, method=PLAIN, ' +
    'rip=203.0.113.7, lip=172.31.0.54, session=<abc>';
  const event = parseDovecotAccess(line, NOW);
  assert.equal(event?.channel, 'pop3');
  assert.equal(event?.ip, '203.0.113.7');
});

test('неверный пароль попадает в историю неудачей', () => {
  const line =
    'Aug 06 17:44:01 imap-login: Info: Disconnected: Aborted login (auth failed, 1 attempts ' +
    'in 2 secs): user=<test@mail.local>, method=PLAIN, rip=203.0.113.7, lip=172.31.0.54, TLS, ' +
    'session=<xyz>';
  const event = parseDovecotAccess(line, NOW);
  assert.ok(event);
  assert.equal(event.success, false);
  assert.equal(event.detail, 'Неверный пароль');
});

test('строки без ящика отбрасываются: их некому показать', () => {
  // Таких в журнале большинство — пробы состояния и оборванные подключения.
  const line =
    'Aug 06 17:43:28 imap-login: Info: Disconnected: Connection closed (no auth attempts ' +
    'in 0 secs): user=<>, rip=127.0.0.1, lip=127.0.0.1, secured, session=<g534bGRY7Nl/AAAB>';
  assert.equal(parseDovecotAccess(line, NOW), null);
});

test('работающая сессия IMAP — не вход и в историю не попадает', () => {
  // `imap(...)` без `-login` пишется на каждое закрытие соединения.
  // Без отбора по службе каждое событие удваивалось бы.
  const line = 'Aug 06 17:43:20 imap(test@mail.local)<8488><Q00Q>: Info: Logged out in=123 out=456';
  assert.equal(parseDovecotAccess(line, NOW), null);
});

test('доставка письма — не вход, хотя ящик в строке есть', () => {
  const line = 'Aug 06 17:43:33 lmtp(38): Info: Connect from 127.0.0.1';
  assert.equal(parseDovecotAccess(line, NOW), null);
});

test('отправка с проверкой пароля читается из журнала Postfix', () => {
  const line =
    'Aug 06 16:46:09 mail postfix/submission/smtpd[129]: 7102517C8E: ' +
    'client=mtcheck-api-1.mtcheck_default[172.31.0.9], sasl_method=PLAIN, ' +
    'sasl_username=test@mail.local';
  const event = parsePostfixAccess(line, NOW);
  assert.ok(event);
  assert.equal(event.channel, 'smtp');
  assert.equal(event.ip, '172.31.0.9');
  assert.equal(event.origin, 'postfix');
});

test('приём чужой почты на 25-м порту входом не считается', () => {
  // Там пароль не спрашивают вовсе — это не доступ к ящику.
  const line =
    'Aug 06 16:46:09 mail postfix/smtpd[130]: NOQUEUE: client=other.example[198.51.100.4]';
  assert.equal(parsePostfixAccess(line, NOW), null);
});

/** Строка входа по IMAP с заданного адреса. */
function imapLogin(rip: string): AccessEvent {
  const event = dovecotAccessFromParts(
    'imap-login',
    `Login: user=<test@mail.local>, method=PLAIN, rip=${rip}, lip=172.31.0.54`,
    NOW,
  );
  assert.ok(event);
  return event;
}

test('подключение самого веб-интерфейса помечается служебным', () => {
  resetOwnAddresses();
  const marked = markService(imapLogin('127.0.0.1'), ownAddresses());
  assert.equal(marked.service, true);
  assert.match(marked.detail, /[Сс]лужебное/);
});

test('вход с чужого адреса служебным не считается', () => {
  resetOwnAddresses();
  assert.equal(markService(imapLogin('203.0.113.7'), ownAddresses()).service, false);
});

/*
 * ПЕРЕСБОРКА КОНТЕЙНЕРА. Docker выдаёт новому контейнеру следующий
 * свободный адрес: процесс считает своим 172.28.0.7, а вчерашние строки
 * журнала написаны про 172.28.0.2 — ровно это видно в dovecot.log на
 * стенде. На прежнем коде (сравнение только с текущими интерфейсами)
 * вчерашние служебные подключения превращались в «вход по IMAP из
 * локальной сети», то есть раздел сам поднимал ложную тревогу.
 */
test('адрес прежнего контейнера остаётся служебным после пересборки', () => {
  const remembered = new Set(['172.28.0.2', '172.28.0.7']);
  const before = markService(imapLogin('172.28.0.2'), remembered);
  assert.equal(before.service, true, 'вчерашнее подключение — тоже наше');
  assert.equal(markService(imapLogin('172.28.0.7'), remembered).service, true);
  // Обратный ход: чужая машина из той же подсети служебной не становится —
  // помним АДРЕСА, а не подсеть стека, которая может совпасть с офисной
  assert.equal(markService(imapLogin('172.28.0.55'), remembered).service, false);
});

test('адрес IPv4-в-IPv6 приводится к обычному виду', () => {
  // Node отдаёт адрес подключения так, Dovecot пишет иначе — без
  // приведения свой же адрес не узнавался бы.
  assert.equal(normalizeIp('::ffff:172.31.0.9'), '172.31.0.9');
});

test('вид адреса определяется без обращения к внешним службам', () => {
  assert.equal(describeIp('127.0.0.1'), 'сам сервер');
  assert.equal(describeIp('192.168.1.5'), 'локальная сеть');
  assert.equal(describeIp('172.31.0.9'), 'локальная сеть');
  assert.equal(describeIp('203.0.113.7'), 'интернет');
  assert.equal(describeIp(null), 'адрес неизвестен');
  assert.equal(isPrivateIp('100.70.0.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('события из разных источников встают в одну ленту по времени', () => {
  const make = (at: string, detail: string): AccessEvent => ({
    at,
    channel: 'web',
    success: true,
    ip: null,
    userAgent: null,
    service: false,
    detail,
    origin: 'app',
  });
  const merged = mergeAccessEvents(
    [make('2026-08-06T10:00:00.000Z', 'веб')],
    [make('2026-08-06T10:00:30.000Z', 'imap'), make('2026-08-06T09:00:00.000Z', 'старое')],
  );
  assert.deepEqual(
    merged.map((e) => e.detail),
    ['imap', 'веб', 'старое'],
  );
});
