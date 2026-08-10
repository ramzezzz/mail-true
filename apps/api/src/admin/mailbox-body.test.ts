/**
 * Что администратор видит, открыв письмо в чужом ящике.
 *
 * Раньше исходник резался по первой пустой строке, и всё остальное
 * отдавалось как «текст». Для русскоязычной почты это отказ почти в
 * каждом письме: простое письмо на кириллице едет в base64, типовое —
 * multipart/alternative с границами и двумя закодированными частями.
 * То есть главный сценарий раздела («обращение №1234: письмо не пришло,
 * смотрим») давал нечитаемую простыню.
 *
 * Проверяется сам разбор — на тех же байтах, что приходят из IMAP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { htmlToText } from '../mail/text.js';

/** Ровно то, что делает AdminMailboxService.readMessage. */
async function bodyOf(source: Buffer): Promise<string> {
  const parsed = await simpleParser(source, { skipImageLinks: true });
  return parsed.text && parsed.text.trim() !== ''
    ? parsed.text
    : parsed.html
      ? htmlToText(parsed.html)
      : '';
}

test('письмо на кириллице в base64 читается словами, а не кодом', async () => {
  const text = 'Здравствуйте! Договор во вложении.';
  const source = Buffer.from(
    [
      'From: petr@example.org',
      'To: admin@home.local',
      'Subject: =?UTF-8?B?0JTQvtCz0L7QstC+0YA=?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'utf8').toString('base64'),
      '',
    ].join('\r\n'),
    'utf8',
  );

  const body = await bodyOf(source);
  assert.match(body, /Здравствуйте/);
  // Ни одной строки base64 в выдаче остаться не должно.
  assert.ok(!body.includes('0JfQ'), 'разобранное письмо не должно содержать код');
});

test('у multipart/alternative берётся текстовая часть, а не границы', async () => {
  const source = Buffer.from(
    [
      'From: petr@example.org',
      'To: admin@home.local',
      'Subject: Otchet',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary=B1',
      '',
      '--B1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=D0=9E=D1=82=D1=87=D1=91=D1=82 =D0=B3=D0=BE=D1=82=D0=BE=D0=B2',
      '--B1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Отчёт готов</p>',
      '--B1--',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const body = await bodyOf(source);
  assert.match(body, /Отчёт готов/);
  assert.ok(!body.includes('--B1'), 'границы частей в текст попадать не должны');
  assert.ok(!body.includes('quoted-printable'), 'служебных заголовков в тексте быть не должно');
});

test('письмо только с HTML показывается текстом, а не разметкой', async () => {
  const source = Buffer.from(
    [
      'From: rassylka@example.org',
      'To: admin@home.local',
      'Subject: Novosti',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><head><style>body{margin:0}</style></head><body><p>Новости недели</p></body></html>',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const body = await bodyOf(source);
  assert.match(body, /Новости недели/);
  // Ни разметки, ни стилей: администратору показывается именно текст.
  assert.ok(!body.includes('<p>'));
  assert.ok(!body.includes('margin'));
});
