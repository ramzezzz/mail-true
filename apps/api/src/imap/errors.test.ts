import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyImapError, isConnectionLost, toApiError } from './errors.js';

/**
 * Главный случай. Dovecot при упоре в `mail_max_userip_connections` обрывает
 * соединение ответом `* BYE ... Maximum number of connections from user+IP
 * exceeded`. Команда LOGIN при этом падает, и imapflow помечает ошибку полем
 * `authenticationFailed`. Раньше это поле и было единственным признаком —
 * поэтому вход становился невозможен вовсе: на ВЕРНЫЙ пароль приходило
 * «Неверный адрес или пароль», пользователь начинал перебирать пароли и
 * упирался в ограничение попыток.
 */
test('предел числа соединений Dovecot — не отказ по паролю', () => {
  const err = Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    response: '* BYE [ALERT] Maximum number of connections from user+IP exceeded',
  });
  assert.equal(classifyImapError(err), 'unavailable');
  assert.equal(toApiError(err).statusCode, 503);
  assert.equal(toApiError(err).code, 'UPSTREAM_UNAVAILABLE');
});

test('настоящий неверный пароль по-прежнему даёт 401 AUTH_FAILED', () => {
  const err = Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
    response: 'NO [AUTHENTICATIONFAILED] Authentication failed.',
  });
  assert.equal(classifyImapError(err), 'auth');
  const api = toApiError(err);
  assert.equal(api.statusCode, 401);
  assert.equal(api.code, 'AUTH_FAILED');
});

test('отказ по паролю опознаётся и по одному тексту, без кода ответа', () => {
  const err = Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    response: 'NO Authentication failed.',
  });
  assert.equal(classifyImapError(err), 'auth');
});

test('временные коды ответа сервера не считаются отказом по паролю', () => {
  for (const code of ['UNAVAILABLE', 'LIMIT', 'SERVERBUG', 'INUSE', 'CONTACTADMIN']) {
    const err = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      serverResponseCode: code,
      response: `NO [${code}] Temporary failure`,
    });
    assert.equal(classifyImapError(err), 'unavailable', `${code} — это не пароль`);
  }
});

test('обрыв связи опознаётся и классифицируется как недоступность', () => {
  const cases = [
    Object.assign(new Error('Connection not available'), { code: 'NoConnection' }),
    Object.assign(new Error('Connection closed'), { code: 'EConnectionClosed' }),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:143'), { code: 'ECONNREFUSED' }),
  ];
  for (const err of cases) {
    assert.equal(isConnectionLost(err), true, String(err.message));
    assert.equal(classifyImapError(err), 'unavailable');
  }
});

test('«Connection not available» опознаётся даже без поля code', () => {
  assert.equal(isConnectionLost(new Error('Connection not available')), true);
});

test('обычная прикладная ошибка обрывом соединения не считается', () => {
  assert.equal(isConnectionLost(new Error('Mailbox does not exist')), false);
  assert.equal(isConnectionLost(null), false);
  assert.equal(isConnectionLost('строка'), false);
});

test('неизвестная ошибка считается недоступностью, а не паролем', () => {
  assert.equal(classifyImapError(new Error('что-то пошло не так')), 'unavailable');
  assert.equal(classifyImapError(undefined), 'unavailable');
});
