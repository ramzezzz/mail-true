/**
 * Письмо из папки с длинным русским названием.
 *
 * Идентификатор письма у нас — `f-<base64url(путь папки)>:<uid>`. Кириллица
 * занимает по два байта на букву, а base64url прибавляет к ним ещё треть:
 * папка «Договоры с подрядчиками…» из семи десятков букв даёт идентификатор
 * длиннее двухсот символов. Ровно двести и стояло пределом в двух местах
 * написания письма, хотя во всём остальном продукте предел общий и втрое
 * больше (MAX_ENTITY_ID_LENGTH).
 *
 * Что это значило для человека: письмо из такой папки нельзя было ни
 * переслать вложением, ни ответить на его просьбу уведомить о прочтении.
 * Сервер отвечал «Некорректные данные запроса», из которого не следует ни
 * что не так, ни что с этим делать; вопрос «уведомить отправителя?»
 * возвращался при каждом открытии письма.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { registerErrorHandling } from '../http-errors.js';
import { encodePathId, MAX_ENTITY_ID_LENGTH } from '../mail/folders.js';
import type { AppDeps } from '../types.js';
import { UploadStore } from '../uploads.js';
import { composeRoutes } from './compose.js';

/** Настоящее название папки, какое заводят в бухгалтерии. */
const LONG_FOLDER =
  'Договоры с подрядчиками и поставщиками по строительству складского комплекса в Подмосковье';
const LONG_ID = `${encodePathId(LONG_FOLDER)}:41`;

/** Письмо в этой папке просит уведомить о прочтении. */
const HEADERS = Buffer.from(
  [
    'From: Ирина <irina@mail.local>',
    'Disposition-Notification-To: <irina@mail.local>',
    '',
    '',
  ].join('\r\n'),
  'utf8',
);

class FakeClient {
  async list(): Promise<unknown[]> {
    const folder = (path: string, specialUse: string | undefined): unknown => ({
      path,
      name: path,
      delimiter: '/',
      parentPath: '',
      specialUse,
      flags: new Set<string>(),
      status: { messages: 0, unseen: 0, uidValidity: 1n },
    });
    return [
      folder('INBOX', '\\Inbox'),
      folder('Sent', '\\Sent'),
      folder('Drafts', '\\Drafts'),
      folder(LONG_FOLDER, undefined),
    ];
  }

  readonly capabilities = new Set<string>();

  async append(): Promise<{ uid: number }> {
    return { uid: 500 };
  }

  async getMailboxLock(): Promise<{ release(): void }> {
    return { release: () => undefined };
  }

  async noop(): Promise<void> {}

  async fetchOne(): Promise<{
    uid: number;
    source: Buffer;
    headers: Buffer;
    envelope: { subject: string; messageId: string };
    flags: Set<string>;
  }> {
    return {
      uid: 41,
      source: Buffer.from('Subject: Акт сверки\r\n\r\nтекст\r\n', 'utf8'),
      headers: HEADERS,
      envelope: { subject: 'Акт сверки', messageId: '<akt@mail.local>' },
      flags: new Set<string>(),
    };
  }

  async messageDelete(): Promise<boolean> {
    return true;
  }

  async messageFlagsAdd(): Promise<boolean> {
    return true;
  }

  async search(): Promise<number[]> {
    return [];
  }
}

async function buildHarness(): Promise<{ app: FastifyInstance; close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mail-true-longid-'));
  const uploads = new UploadStore(join(dir, 'uploads'));
  await uploads.init();
  const config = {
    // Отправлять этим проверкам некуда: они останавливаются раньше — на
    // разборе запроса, ради которого и написаны.
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: 1,
    SMTP_SECURE: false,
    TLS_REJECT_UNAUTHORIZED: false,
    MESSAGE_MAX_BYTES: 25 * 1024 * 1024,
    COMPOSE_BODY_MAX_BYTES: 12 * 1024 * 1024,
    UPLOAD_MAILBOX_MAX_BYTES: 250 * 1024 * 1024,
    UPLOAD_DIR: join(dir, 'uploads'),
  } as unknown as AppConfig;

  const client = new FakeClient();
  // Длина параметра адреса — как у настоящего сервера (см. app.ts): у
  // Fastify по умолчанию сто символов, и без этой строки проверка спотыкалась
  // бы о разбор адреса, так и не дойдя до схемы запроса.
  const app = Fastify({
    logger: false,
    maxParamLength: MAX_ENTITY_ID_LENGTH * 2,
  }) as unknown as FastifyInstance;
  app.decorate('deps', {
    pool: {
      withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
        fn(client as unknown as ImapFlow),
    },
    uploads,
    config,
    secretBox: { encrypt: (v: string) => v, decrypt: (v: string) => v },
  } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(composeRoutes, { prefix: '/api' });
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('идентификатор письма из папки с длинным русским названием длиннее прежних 200 символов', () => {
  // Проверка не про код, а про сам повод: без неё соседние проверки могли бы
  // молча выродиться в проверку на коротком идентификаторе.
  assert.ok(
    LONG_ID.length > 200,
    `идентификатор вышел коротким (${String(LONG_ID.length)}) — пример перестал воспроизводить дефект`,
  );
  assert.ok(LONG_ID.length <= MAX_ENTITY_ID_LENGTH);
});

test('письмо из такой папки можно переслать вложением', async () => {
  const h = await buildHarness();
  try {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: {
        to: [{ name: null, address: 'kolya@mail.local' }],
        cc: [],
        bcc: [],
        subject: 'Fwd: Акт сверки',
        bodyHtml: '<div>пересылаю</div>',
        attachmentIds: [],
        attachMessageIds: [LONG_ID],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  } finally {
    await h.close();
  }
});

test('на просьбу уведомить о прочтении из такой папки можно ответить', async () => {
  const h = await buildHarness();
  try {
    // `send: false` — человек отказался уведомлять. Письмо никуда не уходит,
    // но метка $MDNSent ставится, и вопрос больше не возвращается.
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/messages/${encodeURIComponent(LONG_ID)}/read-receipt`,
      payload: { send: false },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ sent: boolean }>().sent, false);
  } finally {
    await h.close();
  }
});
