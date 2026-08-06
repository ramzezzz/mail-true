/** Тесты формирования MessageSummary из данных IMAP FETCH. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FetchMessageObject, MessageStructureObject } from 'imapflow';
import { buildSummary, flagsFromSet, labelsFromSet, threadIdOf } from './summary.js';

/** BODYSTRUCTURE: multipart/mixed (text/html + вложение pdf + inline png). */
const structure: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/html', size: 500 },
    {
      part: '2',
      type: 'application/pdf',
      size: 1024,
      disposition: 'attachment',
      dispositionParameters: { filename: 'счёт.pdf' },
    },
    {
      part: '3',
      type: 'image/png',
      size: 2048,
      disposition: 'inline',
      id: '<logo@mail>',
      dispositionParameters: { filename: 'logo.png' },
    },
  ],
};

function fakeMsg(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    seq: 1,
    uid: 101,
    size: 4096,
    flags: new Set(['\\Seen', '$Forwarded', 'MyLabel']),
    envelope: {
      date: new Date('2026-08-01T10:00:00Z'),
      subject: 'Отчёт за июль',
      messageId: '<abc@mail.local>',
      from: [{ name: 'Иван Петров', address: 'ivan@mail.local' }],
      to: [{ name: '', address: 'test@mail.local' }],
      cc: [{ address: 'boss@mail.local' }],
    },
    bodyStructure: structure,
    internalDate: new Date('2026-08-01T10:00:05Z'),
    ...overrides,
  } as FetchMessageObject;
}

test('buildSummary: базовые поля', () => {
  const s = buildSummary({ folderId: 'inbox', msg: fakeMsg(), snippet: 'Привет, вот отчёт' });
  assert.equal(s.id, 'inbox:101');
  assert.equal(s.folderId, 'inbox');
  assert.equal(s.uid, 101);
  assert.equal(s.subject, 'Отчёт за июль');
  assert.equal(s.snippet, 'Привет, вот отчёт');
  assert.equal(s.date, '2026-08-01T10:00:00.000Z');
  assert.deepEqual(s.from, { name: 'Иван Петров', address: 'ivan@mail.local' });
  assert.equal(s.to.length, 1);
  assert.equal(s.cc[0]?.address, 'boss@mail.local');
  assert.equal(s.sizeBytes, 4096);
});

test('buildSummary: флаги и метки', () => {
  const s = buildSummary({ folderId: 'inbox', msg: fakeMsg() });
  assert.equal(s.flags.seen, true);
  assert.equal(s.flags.forwarded, true);
  assert.equal(s.flags.flagged, false);
  assert.deepEqual(s.labels, ['MyLabel']);
  assert.equal(s.pinned, false);
});

test('buildSummary: вложения — inline-картинки не считаются', () => {
  const s = buildSummary({ folderId: 'inbox', msg: fakeMsg() });
  assert.equal(s.hasAttachments, true);
  assert.deepEqual(s.attachmentNames, ['счёт.pdf']);
});

test('buildSummary: письмо без envelope не падает', () => {
  const msg = fakeMsg({ envelope: undefined as never, flags: undefined as never });
  const s = buildSummary({ folderId: 'trash', msg });
  assert.equal(s.subject, '');
  assert.equal(s.from.address, '');
  assert.equal(s.flags.seen, false);
  assert.equal(s.threadId, 'trash:101');
});

test('threadIdOf: ответы группируются с исходным письмом', () => {
  const rootId = threadIdOf({ messageId: '<root@mail>' }, 'x');
  const replyId = threadIdOf({ messageId: '<reply@mail>', inReplyTo: '<root@mail>' }, 'y');
  assert.equal(rootId, replyId);
});

test('flagsFromSet: все системные флаги', () => {
  const flags = flagsFromSet(
    new Set(['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '\\Deleted', '$Forwarded', '$MDNSent']),
  );
  assert.deepEqual(flags, {
    seen: true,
    flagged: true,
    answered: true,
    forwarded: true,
    draft: true,
    deleted: true,
    mdnSent: true,
  });
});

/**
 * `$MDNSent` — не пользовательская метка, а ответ на просьбу уведомить
 * о прочтении (RFC 3503). В список меток он не попадает, поэтому без
 * отдельного поля интерфейс не отличил бы «ещё не спрашивали» от «уже
 * ответили» и спрашивал бы при каждом открытии письма.
 */
test('flagsFromSet: без $MDNSent поле честно false, а не отсутствует', () => {
  assert.equal(flagsFromSet(new Set(['\\Seen'])).mdnSent, false);
});

test('labelsFromSet: системные ключевые слова отфильтрованы', () => {
  assert.deepEqual(labelsFromSet(new Set(['\\Seen', '$Forwarded', '$MDNSent', 'Важное'])), ['Важное']);
});
