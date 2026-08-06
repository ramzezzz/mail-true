/**
 * Главный вопрос возможности «напомнить, если не ответили»: пришёл ответ
 * или нет.
 *
 * Проверяется здесь, а не на стенде, потому что на стенде эти случаи не
 * устроить по требованию: чтобы увидеть ответ без In-Reply-To, нужна
 * почтовая программа, которая его не ставит; чтобы увидеть автоответ об
 * отпуске — собеседник в отпуске.
 *
 * Разбор рисков (docs/gaps.md, п. 4) требует несимметричности: «Лучше не
 * заметить ответ реже, чем напомнить впустую». Ниже это и закреплено —
 * запасная проверка нарочно широкая, а всё, что похоже на не-ответ
 * (автоответ, отчёт о недоставке, собственное письмо), ответом не считается.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchReply, normalizeSubject, type AwaitedLetter } from './await-reply.js';

const letter: AwaitedLetter = {
  messageId: 'ask-1@mail.local',
  subject: 'Согласуем смету до пятницы',
  recipients: ['kolya@example.com'],
  sentAt: new Date('2026-08-05T09:00:00Z'),
  selfAddress: 'ivan@mail.local',
};

function candidate(patch: Partial<Parameters<typeof matchReply>[1]> = {}) {
  return {
    fromAddress: 'kolya@example.com',
    subject: 'Re: Согласуем смету до пятницы',
    date: new Date('2026-08-05T12:00:00Z'),
    references: [] as string[],
    inReplyTo: [] as string[],
    ...patch,
  };
}

test('ссылка на наш Message-ID — это ответ, и проверка называет себя', () => {
  assert.equal(matchReply(letter, candidate({ inReplyTo: ['ask-1@mail.local'] })), 'references');
  assert.equal(
    matchReply(letter, candidate({ references: ['<ask-1@mail.local>'], subject: 'Другая тема' })),
    'references',
  );
});

test('без ссылок ответ узнаётся по собеседнику и теме', () => {
  // Так шлют «ответы» из веб-форм, CRM и систем заявок: In-Reply-To нет.
  assert.equal(matchReply(letter, candidate()), 'subject');
});

test('приставки ответа и регистр теме не мешают', () => {
  assert.equal(normalizeSubject('Re: Fwd: RE: Квартальный ОТЧЁТ'), 'квартальный отчёт');
  assert.equal(normalizeSubject('Ответ: Смета'), 'смета');
  assert.equal(
    matchReply(letter, candidate({ subject: 'RE: СОГЛАСУЕМ СМЕТУ ДО ПЯТНИЦЫ' })),
    'subject',
  );
});

test('чужое письмо с той же темой ответом не считается', () => {
  assert.equal(matchReply(letter, candidate({ fromAddress: 'spam@example.net' })), null);
});

test('письмо собеседника на другую тему ответом не считается', () => {
  assert.equal(matchReply(letter, candidate({ subject: 'Совсем про другое' })), null);
});

test('письмо, пришедшее ДО нашего, ответом не считается', () => {
  // Иначе ответом стало бы то самое письмо, на которое мы сами отвечали.
  assert.equal(matchReply(letter, candidate({ date: new Date('2026-08-04T09:00:00Z') })), null);
});

test('автоответ об отпуске ответом не считается', () => {
  /*
   * Самый обидный ложный ответ: собеседник в отпуске, отвечать будет
   * через две недели, а напоминание мы бы сняли.
   */
  assert.equal(matchReply(letter, candidate({ autoSubmitted: 'auto-replied' })), null);
  // RFC 3834: «no» означает, что письмо написал человек.
  assert.equal(matchReply(letter, candidate({ autoSubmitted: 'no' })), 'subject');
});

test('отчёт о недоставке ответом не считается', () => {
  assert.equal(matchReply(letter, candidate({ fromAddress: 'MAILER-DAEMON@example.com' })), null);
  assert.equal(matchReply(letter, candidate({ fromAddress: '' })), null);
});

test('своё же письмо вдогонку ответом не считается', () => {
  assert.equal(
    matchReply(
      { ...letter, recipients: ['ivan@mail.local'] },
      candidate({ fromAddress: 'Ivan@Mail.Local' }),
    ),
    null,
  );
});

test('ссылка сильнее темы: ответ узнаётся даже при смене темы', () => {
  const changed = candidate({ subject: 'Fwd: другое', inReplyTo: ['ask-1@mail.local'] });
  assert.equal(matchReply(letter, changed), 'references');
});

test('письмо без темы запасной проверкой не ловится', () => {
  // Пустая тема совпала бы с любым другим письмом без темы.
  assert.equal(matchReply({ ...letter, subject: '' }, candidate({ subject: '' })), null);
});
