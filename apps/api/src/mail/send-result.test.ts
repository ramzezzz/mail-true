import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySmtpError, readSendOutcome } from './send-result.js';

/**
 * Главный случай. Письмо на два адреса, один из которых не существует,
 * отвечало `{"ok":true}` — при том, что Postfix отверг получателя с
 * `550 User unknown in local recipient table`. Поле `rejected` результата
 * отправки не читалось вовсе.
 */
test('частичный отказ получателей виден в разборе результата', () => {
  const info = {
    accepted: ['test@mail.local'],
    rejected: ['несуществующий@mail.local'],
    rejectedErrors: [
      Object.assign(new Error('Invalid recipient'), {
        recipient: 'несуществующий@mail.local',
        responseCode: 550,
        response: '550 5.1.1 <несуществующий@mail.local>: Recipient address rejected: User unknown',
      }),
    ],
    response: '250 2.0.0 Ok: queued',
  };

  const outcome = readSendOutcome(info);
  assert.deepEqual(outcome.accepted, ['test@mail.local']);
  assert.equal(outcome.rejected.length, 1);
  assert.equal(outcome.rejected[0]?.address, 'несуществующий@mail.local');
  assert.equal(outcome.rejected[0]?.code, 550);
  assert.match(outcome.rejected[0]?.message ?? '', /User unknown/);
});

test('полностью успешная отправка не выдумывает отказов', () => {
  const outcome = readSendOutcome({
    accepted: ['a@mail.local', 'b@mail.local'],
    rejected: [],
    rejectedErrors: [],
  });
  assert.equal(outcome.rejected.length, 0);
  assert.equal(outcome.accepted.length, 2);
});

test('адреса-объекты и пустой ответ не ломают разбор', () => {
  assert.deepEqual(readSendOutcome(undefined), { accepted: [], rejected: [] });
  const outcome = readSendOutcome({ accepted: [{ address: 'a@mail.local' }], rejected: [] });
  assert.deepEqual(outcome.accepted, ['a@mail.local']);
});

/**
 * Второй разобранный дефект: постоянный отказ SMTP выдавался как
 * `503 UPSTREAM_UNAVAILABLE` «почтовый сервер недоступен» — неправда дважды.
 */
test('отказ 550 «все получатели отклонены» — постоянный, а не недоступность', () => {
  const err = Object.assign(new Error("Can't send mail - all recipients were rejected"), {
    code: 'EENVELOPE',
    responseCode: 550,
    response: '550 5.1.1 Recipient address rejected: User unknown',
    rejected: ['нет@mail.local'],
    rejectedErrors: [
      Object.assign(new Error('rejected'), {
        recipient: 'нет@mail.local',
        responseCode: 550,
        response: '550 5.1.1 User unknown',
      }),
    ],
  });
  const failure = classifySmtpError(err);
  assert.equal(failure.permanent, true);
  assert.equal(failure.tooLarge, false);
  assert.equal(failure.code, 550);
  assert.equal(failure.rejected.length, 1);
  assert.match(failure.message, /отклонил получателей/i);
});

test('отказ по размеру письма опознаётся отдельно', () => {
  const err = Object.assign(new Error('Message too big'), {
    code: 'EMESSAGE',
    responseCode: 552,
    response: '552 5.3.4 Message size exceeds fixed limit',
  });
  const failure = classifySmtpError(err);
  assert.equal(failure.permanent, true);
  assert.equal(failure.tooLarge, true);
  assert.match(failure.message, /слишком большое/i);
});

test('обрыв связи с SMTP остаётся временной недоступностью', () => {
  for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET']) {
    const err = Object.assign(new Error('connection error'), { code });
    const failure = classifySmtpError(err);
    assert.equal(failure.permanent, false, code);
    assert.equal(failure.tooLarge, false, code);
  }
});

test('временный отказ 4xx повтору не мешает и постоянным не считается', () => {
  const err = Object.assign(new Error('Try again later'), {
    responseCode: 451,
    response: '451 4.3.0 Temporary failure',
  });
  assert.equal(classifySmtpError(err).permanent, false);
});
