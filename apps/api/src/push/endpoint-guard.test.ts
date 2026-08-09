/**
 * Куда серверу можно стучаться с уведомлением.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗАКРЫВАЕТСЯ
 * ------------------------------------------------------------------
 * Адрес службы доставки принимался любой, лишь бы начинался с https, а
 * дальше сервер сам ходил по нему POST-запросом — на каждое новое
 * письмо — и отдавал первые триста символов ответа обратно в панель
 * («проверочное уведомление»).
 *
 * То есть любой, кто вошёл в СВОЮ почту, мог подписаться на
 * `https://внутренний-узел/что-угодно`, нажать «проверить» и прочитать
 * кусок ответа оттуда, куда снаружи не достучаться. Ключи подписки
 * генерируются за секунду и ничего не подтверждают.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEndpointShape, isPrivateAddress, PushEndpointError } from './endpoint-guard.js';

/** Адреса настоящих служб доставки — они обязаны проходить. */
const REAL = [
  'https://fcm.googleapis.com/fcm/send/dHJ1ZQ:APA91bF...',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
  'https://web.push.apple.com/QLMhTr9zn8',
  'https://wns2-by3p.notify.windows.com/w/?token=BQYAAAB',
];

void test('адреса настоящих служб доставки принимаются', () => {
  for (const endpoint of REAL) {
    assert.doesNotThrow(() => checkEndpointShape(endpoint), `отвергнут живой адрес: ${endpoint}`);
  }
});

void test('внутренние имена отвергаются', () => {
  for (const endpoint of [
    'https://localhost/push',
    'https://api.local/push',
    'https://postgres.internal/push',
    'https://nas.lan/push',
    'https://router.home/push',
  ]) {
    assert.throws(() => checkEndpointShape(endpoint), PushEndpointError, endpoint);
  }
});

void test('числовой адрес вместо имени отвергается: так подписки не выдаёт ни один браузер', () => {
  for (const endpoint of [
    'https://192.168.1.10/push',
    'https://127.0.0.1/push',
    'https://[::1]/push',
    'https://169.254.169.254/latest/meta-data/',
  ]) {
    assert.throws(() => checkEndpointShape(endpoint), PushEndpointError, endpoint);
  }
});

void test('нестандартный порт отвергается', () => {
  // Служба доставки браузера не живёт на 8080 и тем более на 6379.
  assert.throws(() => checkEndpointShape('https://example.com:6379/push'), /порт/u);
  assert.doesNotThrow(() => checkEndpointShape('https://example.com:443/push'));
});

void test('http отвергается вместе с прочими схемами', () => {
  for (const endpoint of [
    'http://fcm.googleapis.com/push',
    'file:///etc/passwd',
    'gopher://example.com/',
  ]) {
    assert.throws(() => checkEndpointShape(endpoint), PushEndpointError, endpoint);
  }
});

/* ------------------------------------------------------------------ */
/* Разбор адресов                                                       */
/* ------------------------------------------------------------------ */

void test('непубличные диапазоны опознаются', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.251',
    '169.254.169.254', // метаданные облаков — самая ходовая цель
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1', // тот же приватный адрес, записанный как IPv6
  ]) {
    assert.equal(isPrivateAddress(address), true, `пропущен непубличный адрес ${address}`);
  }
});

void test('публичные адреса не отвергаются', () => {
  for (const address of ['8.8.8.8', '203.0.113.10', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `отвергнут публичный адрес ${address}`);
  }
});

void test('не адрес вовсе считается непубличным: сомнение — не в пользу запроса', () => {
  for (const value of ['', 'localhost', 'не адрес', '999.1.1.1']) {
    assert.equal(isPrivateAddress(value), true);
  }
});
