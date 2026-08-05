/**
 * Уведомления о прочтении.
 *
 * Проверяется ровно то, что видит получатель: что уведомление — это
 * `multipart/report` с машиночитаемой частью, а не просто письмо со словами,
 * и что чужие данные из заголовков (адрес, тема, Message-ID) не могут
 * дописать в наше письмо ни строчки.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReadReceipt,
  encodeHeaderWord,
  isPlainAddress,
  readReceiptRequest,
} from './read-receipt.js';

test('адрес для уведомления берётся из Disposition-Notification-To', () => {
  assert.deepEqual(
    readReceiptRequest({ 'disposition-notification-to': 'Иван <ivan@mail.local>' }),
    { address: 'ivan@mail.local', name: 'Иван' },
  );
  assert.deepEqual(readReceiptRequest({ 'disposition-notification-to': 'ivan@mail.local' }), {
    address: 'ivan@mail.local',
    name: null,
  });
  // Несколько адресов — уведомление одно, берём первый
  assert.equal(
    readReceiptRequest({ 'disposition-notification-to': 'a@mail.local, b@mail.local' })?.address,
    'a@mail.local',
  );
});

test('письмо без просьбы уведомить не даёт адреса', () => {
  assert.equal(readReceiptRequest({}), null);
  assert.equal(readReceiptRequest({ 'disposition-notification-to': '' }), null);
  assert.equal(readReceiptRequest({ 'disposition-notification-to': 'не адрес' }), null);
});

test('адрес с пробелом или переводом строки отвергается целиком', () => {
  // Иначе адрес из чужого письма дописал бы в наше уведомление свой заголовок
  assert.equal(isPlainAddress('ivan@mail.local\r\nBcc: all@mail.local'), false);
  assert.equal(isPlainAddress('ivan@mail.local Bcc: all@mail.local'), false);
  assert.equal(isPlainAddress('ivan@mail.local'), true);
  assert.equal(isPlainAddress('ivan@local'), false);
});

test('кириллица в заголовке кодируется по RFC 2047', () => {
  assert.equal(encodeHeaderWord('Report'), 'Report');
  const encoded = encodeHeaderWord('Отчёт');
  assert.ok(encoded.startsWith('=?UTF-8?B?'), encoded);
  assert.equal(
    Buffer.from(encoded.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'),
    'Отчёт',
  );
});

test('уведомление — это multipart/report с машиночитаемой частью', () => {
  const raw = buildReadReceipt({
    from: 'test@mail.local',
    to: 'ivan@mail.local',
    originalSubject: 'Договор',
    originalMessageId: '<orig-1@mail.local>',
    hostname: 'mail.local',
    date: new Date('2026-08-06T09:00:00Z'),
  }).toString('utf8');

  assert.match(raw, /Content-Type: multipart\/report; report-type=disposition-notification;/);
  assert.match(raw, /Content-Type: message\/disposition-notification/);
  assert.match(raw, /Disposition: manual-action\/MDN-sent-manually; displayed/);
  assert.match(raw, /Final-Recipient: rfc822;test@mail\.local/);
  assert.match(raw, /Original-Message-ID: <orig-1@mail\.local>/);
  // Уведомление — ответ машины: без этого автоответчики зацикливаются
  assert.match(raw, /Auto-Submitted: auto-replied/);
  assert.match(raw, /^To: <ivan@mail\.local>$/m);
});

test('тема исходного письма не может дописать в уведомление свой заголовок', () => {
  const raw = buildReadReceipt({
    from: 'test@mail.local',
    to: 'ivan@mail.local',
    originalSubject: 'Тема\r\nBcc: victim@mail.local',
    originalMessageId: '<a@b>\r\nBcc: victim@mail.local',
    hostname: 'mail.local',
  }).toString('utf8');

  assert.equal(/Bcc:/.test(raw), false, 'подставленный заголовок не должен попасть в письмо');
});

test('письмо без Message-ID не получает пустых ссылок на него', () => {
  const raw = buildReadReceipt({
    from: 'test@mail.local',
    to: 'ivan@mail.local',
    originalSubject: 'Без идентификатора',
    originalMessageId: null,
    hostname: 'mail.local',
  }).toString('utf8');

  assert.equal(/In-Reply-To:/.test(raw), false);
  assert.equal(/Original-Message-ID:/.test(raw), false);
});
