/** Тесты разбора полного письма (mailparser + санитизация + cid). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FetchMessageObject, MessageStructureObject } from 'imapflow';
import { parseFullMessage, parseAuthResults } from './parse.js';

const BOUNDARY = 'test-boundary-123';

/** Простое multipart/related письмо: html с inline-картинкой + скрипт внутри. */
const rawSource = Buffer.from(
  [
    'From: "Иван" <ivan@mail.local>',
    'To: test@mail.local',
    'Subject: =?utf-8?B?0J/RgNC40LLQtdGC?=', // «Привет»
    'Message-ID: <msg1@mail.local>',
    'In-Reply-To: <root@mail.local>',
    'References: <root@mail.local>',
    'Date: Mon, 03 Aug 2026 12:00:00 +0300',
    'Authentication-Results: mail.local; spf=pass; dkim=fail; dmarc=none',
    `Content-Type: multipart/related; boundary="${BOUNDARY}"`,
    'MIME-Version: 1.0',
    '',
    `--${BOUNDARY}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Привет!</p><script>alert("xss")</script>' +
      '<img src="cid:pic1@mail"><img src="https://tracker.example/p.png">',
    `--${BOUNDARY}`,
    'Content-Type: image/png',
    'Content-ID: <pic1@mail>',
    'Content-Disposition: inline; filename="pic.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n'),
  'utf8'
);

const structure: MessageStructureObject = {
  type: 'multipart/related',
  childNodes: [
    { part: '1', type: 'text/html', size: 200 },
    {
      part: '2',
      type: 'image/png',
      size: 12,
      id: '<pic1@mail>',
      disposition: 'inline',
      dispositionParameters: { filename: 'pic.png' },
    },
  ],
};

const fetchMsg = {
  seq: 1,
  uid: 7,
  size: rawSource.length,
  flags: new Set<string>(),
  bodyStructure: structure,
  envelope: {
    date: new Date('2026-08-03T09:00:00Z'),
    subject: 'Привет',
    messageId: '<msg1@mail.local>',
    from: [{ name: 'Иван', address: 'ivan@mail.local' }],
    to: [{ address: 'test@mail.local' }],
  },
} as unknown as FetchMessageObject;

test('parseFullMessage: тело, заголовки, cid и блокировка внешних картинок', async () => {
  const { message, blockedRemote } = await parseFullMessage({
    folderId: 'inbox',
    msg: fetchMsg,
    source: rawSource,
    allowRemote: false,
  });

  assert.equal(message.id, 'inbox:7');
  assert.equal(message.subject, 'Привет');
  assert.equal(message.messageId, '<msg1@mail.local>');
  assert.equal(message.inReplyTo, '<root@mail.local>');
  assert.deepEqual(message.references, ['<root@mail.local>']);

  // HTML продезинфицирован
  assert.ok(message.bodyHtml);
  assert.ok(!message.bodyHtml.includes('<script'), 'script вырезан');
  assert.ok(!message.bodyHtml.includes('alert('), 'содержимое script вырезано');
  // cid переписан на маршрут части
  assert.ok(
    message.bodyHtml.includes('/parts/2'),
    `cid должен указывать на часть 2, получено: ${message.bodyHtml}`
  );
  // внешняя картинка заблокирована: src заменён заглушкой, оригинал — в data-mt-src
  assert.ok(!/(?<!data-mt-)src="https:\/\/tracker\.example\/p\.png"/.test(message.bodyHtml));
  assert.ok(message.bodyHtml.includes('data-mt-src="https://tracker.example/p.png"'));
  assert.equal(blockedRemote, 1);

  // Вложения из BODYSTRUCTURE
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0]?.partId, '2');
  assert.equal(message.attachments[0]?.contentId, 'pic1@mail');
  assert.equal(message.attachments[0]?.inline, true);

  // Authentication-Results
  assert.equal(message.authentication.spf, 'pass');
  assert.equal(message.authentication.dkim, 'fail');
  assert.equal(message.authentication.dmarc, 'none');

  assert.ok(message.bodyText);
  assert.ok(message.snippet.includes('Привет'));
});

test('parseFullMessage: allowRemote оставляет внешние картинки', async () => {
  const { message, blockedRemote } = await parseFullMessage({
    folderId: 'inbox',
    msg: fetchMsg,
    source: rawSource,
    allowRemote: true,
  });
  assert.ok(message.bodyHtml?.includes('src="https://tracker.example/p.png"'));
  assert.equal(blockedRemote, 0);
});

test('parseAuthResults: разбор заголовка', () => {
  assert.deepEqual(parseAuthResults('mail.local; spf=softfail (x); dkim=pass; dmarc=permerror'), {
    spf: 'softfail',
    dkim: 'pass',
    dmarc: 'permerror',
  });
  assert.deepEqual(parseAuthResults(undefined), { spf: 'none', dkim: 'none', dmarc: 'none' });
  assert.deepEqual(parseAuthResults('garbage'), { spf: 'none', dkim: 'none', dmarc: 'none' });
});

/**
 * Письмо с испорченным разделителем частей не должно выглядеть пустым.
 *
 * Найдено проверкой на настоящей почте: в заголовке объявлен один
 * разделитель, а в теле стоит другой. Разбор не находит ни одной части, и
 * письмо показывалось СОВЕРШЕННО пустым — тема и отправитель есть, текста
 * нет, и добраться до него нельзя ничем: «показать исходник» у нас нет.
 *
 * Такие письма ходят: разделитель портят самописные рассылки и пересылка
 * через старые шлюзы.
 */
test('текст письма с неверным разделителем берётся из исходника', async () => {
  const source = Buffer.from(
    [
      'From: rassylka@example.com',
      'To: kolya@mail.local',
      'Subject: Slomannyi razdelitel',
      'Content-Type: multipart/mixed; boundary="OBYAVLENNYI"',
      '',
      '--NASTOYASHCHIY',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Tekst vnutri nepravilnogo razdelitelya.',
      '--NASTOYASHCHIY--',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const { message } = await parseFullMessage({
    folderId: 'inbox',
    msg: { uid: 7, bodyStructure: undefined } as never,
    source,
    allowRemote: false,
  });

  assert.ok(
    (message.bodyText ?? '').includes('Tekst vnutri nepravilnogo razdelitelya'),
    `текст должен быть виден, получено: ${JSON.stringify(message.bodyText)}`,
  );
  assert.equal(message.bodyRecovered, true, 'и человеку должно быть сказано, что письмо не разобралось');
});

test('обычное письмо признаком «не разобралось» не помечается', async () => {
  const source = Buffer.from(
    [
      'From: ivan@example.com',
      'To: kolya@mail.local',
      'Subject: Obychnoe pismo',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Vsyo v poryadke.',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const { message } = await parseFullMessage({
    folderId: 'inbox',
    msg: { uid: 8, bodyStructure: undefined } as never,
    source,
    allowRemote: false,
  });

  assert.match(message.bodyText ?? '', /Vsyo v poryadke/);
  assert.equal(message.bodyRecovered, undefined, 'лишний признак заставил бы объяснять то, чего не было');
});
