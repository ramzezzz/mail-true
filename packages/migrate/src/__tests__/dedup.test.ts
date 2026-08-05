/** Тесты ключа дедупликации. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKey, normalizeMessageId, parseDedupHeaders } from '../dedup.js';

describe('normalizeMessageId', () => {
  it('срезает угловые скобки и пробелы', () => {
    assert.equal(normalizeMessageId('  <abc@example.com>  '), 'abc@example.com');
    assert.equal(normalizeMessageId('abc@example.com'), 'abc@example.com');
  });

  it('сохраняет регистр (Message-ID чувствителен к регистру)', () => {
    assert.equal(normalizeMessageId('<AbC@Example.Com>'), 'AbC@Example.Com');
  });

  it('пустые значения → null', () => {
    assert.equal(normalizeMessageId(undefined), null);
    assert.equal(normalizeMessageId('  '), null);
    assert.equal(normalizeMessageId('<>'), null);
  });
});

describe('dedupKey', () => {
  it('при наличии Message-ID ключ зависит только от него', () => {
    const a = dedupKey({ messageId: '<m1@x>', subject: 'Привет' }, 100);
    const b = dedupKey({ messageId: 'm1@x', subject: 'Другая тема' }, 999);
    assert.equal(a, b);
    assert.ok(a.startsWith('mid:'));
  });

  it('без Message-ID ключ строится из заголовков и размера', () => {
    const h = { date: 'Tue, 1 Jul 2025 10:00:00 +0300', from: 'a@x', to: 'b@y', subject: 'Тест' };
    const a = dedupKey(h, 1234);
    const b = dedupKey({ ...h }, 1234);
    assert.equal(a, b);
    assert.ok(a.startsWith('sha:'));
  });

  it('разный размер → разные ключи', () => {
    const h = { date: 'd', from: 'f', to: 't', subject: 's' };
    assert.notEqual(dedupKey(h, 1), dedupKey(h, 2));
  });

  it('разные заголовки → разные ключи', () => {
    const h = { date: 'd', from: 'f', to: 't', subject: 's' };
    assert.notEqual(dedupKey(h, 1), dedupKey({ ...h, subject: 'x' }, 1));
  });

  it('нечувствителен к переносам строк и лишним пробелам в заголовках', () => {
    const a = dedupKey({ subject: 'Очень  длинная\r\n тема' }, 5);
    const b = dedupKey({ subject: 'очень длинная тема' }, 5);
    assert.equal(a, b);
  });
});

describe('parseDedupHeaders', () => {
  it('разбирает сырые заголовки с folding', () => {
    const raw = Buffer.from(
      'Message-ID: <id-1@kerio.local>\r\n' +
        'Date: Tue, 1 Jul 2025 10:00:00 +0300\r\n' +
        'From: Ivan <ivan@example.com>\r\n' +
        'To: petr@example.com,\r\n sidor@example.com\r\n' +
        'Subject: Otchet\r\n za iyun\r\n' +
        'X-Other: junk\r\n\r\n',
    );
    const h = parseDedupHeaders(raw);
    assert.equal(h.messageId, '<id-1@kerio.local>');
    assert.equal(h.to, 'petr@example.com, sidor@example.com');
    assert.equal(h.subject, 'Otchet za iyun');
  });

  it('пустой буфер → пустые заголовки', () => {
    const h = parseDedupHeaders(Buffer.alloc(0));
    assert.equal(h.messageId, undefined);
  });

  it('связка parse + key: письма без Message-ID различаются по содержимому', () => {
    const raw1 = Buffer.from('Date: D1\r\nFrom: a@x\r\nTo: b@y\r\nSubject: S\r\n\r\n');
    const raw2 = Buffer.from('Date: D2\r\nFrom: a@x\r\nTo: b@y\r\nSubject: S\r\n\r\n');
    assert.notEqual(dedupKey(parseDedupHeaders(raw1), 10), dedupKey(parseDedupHeaders(raw2), 10));
    assert.equal(dedupKey(parseDedupHeaders(raw1), 10), dedupKey(parseDedupHeaders(raw1), 10));
  });
});
