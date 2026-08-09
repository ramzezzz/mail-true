/**
 * Три кнопки окна написания, которые раньше только писали в консоль браузера:
 * «Уведомить о прочтении», «Переслать как вложение» и «Отложенная отправка».
 *
 * Проверяется то, что доедет до получателя и до ящика: заголовок
 * `Disposition-Notification-To` в исходнике письма, часть `message/rfc822`
 * с целым чужим письмом внутри и очередь на диске, из которой письмо
 * уходит без всякого браузера.
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { SecretBox } from '../crypto.js';
import { registerErrorHandling } from '../http-errors.js';
import { DeferredSpool } from '../mail/deferred-send.js';
import type { AppDeps } from '../types.js';
import type { UploadStore } from '../uploads.js';
import { composeRoutes } from './compose.js';
import { forwardedFilename } from '../mail/forwarded.js';

/* ------------------------------------------------------------------ */
/* Подставной SMTP: запоминает всё, что через него прошло               */
/* ------------------------------------------------------------------ */

interface FakeSmtp {
  port: number;
  /** Исходники всех принятых писем. */
  readonly messages: string[];
  close(): Promise<void>;
}

async function startFakeSmtp(): Promise<FakeSmtp> {
  const messages: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\r\n')) {
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(buffer);
            buffer = '';
            socket.write('250 2.0.0 Ok: queued as FAKE\r\n');
          } else {
            buffer += `${line}\r\n`;
          }
          continue;
        }
        if (line === '') continue;
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (command === 'AUTH') {
          socket.write('235 2.7.0 Accepted\r\n');
        } else if (command === 'MAIL' || command === 'RCPT') {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/* ------------------------------------------------------------------ */
/* Подставной ящик                                                     */
/* ------------------------------------------------------------------ */

/** Исходник письма, которое лежит в подставном ящике под UID 5. */
const STORED_SOURCE = Buffer.from(
  [
    'From: Иван <ivan@mail.local>',
    'To: test@mail.local',
    'Subject: =?UTF-8?B?0JTQvtCz0L7QstC+0YA=?=',
    'Message-ID: <orig-5@mail.local>',
    'Disposition-Notification-To: Иван <ivan@mail.local>',
    '',
    'Тело исходного письма',
    '',
  ].join('\r\n'),
  'utf8',
);

class FakeClient {
  readonly sent = new Set<number>();
  readonly drafts = new Set<number>();
  readonly flagsAdded: Array<{ uids: number[]; flags: string[] }> = [];
  /** Флаги письма под UID 5 — на них смотрит маршрут уведомления. */
  readonly messageFlags = new Set<string>();
  private nextUid = 100;

  async list(): Promise<unknown[]> {
    const folder = (path: string, specialUse: string): unknown => ({
      path,
      name: path,
      delimiter: '/',
      parentPath: '',
      specialUse,
      flags: new Set<string>(),
      status: { messages: 0, unseen: 0, uidValidity: 1n },
    });
    return [folder('INBOX', '\\Inbox'), folder('Sent', '\\Sent'), folder('Drafts', '\\Drafts')];
  }

  async append(path: string): Promise<{ uid: number }> {
    const uid = this.nextUid++;
    if (path === 'Sent') this.sent.add(uid);
    else this.drafts.add(uid);
    return { uid };
  }

  readonly capabilities = new Set<string>();

  async getMailboxLock(): Promise<{ release(): void }> {
    return { release: () => undefined };
  }

  async noop(): Promise<void> {}

  async messageDelete(uids: number[]): Promise<boolean> {
    for (const uid of uids) this.drafts.delete(uid);
    return true;
  }

  async search(): Promise<number[]> {
    return [];
  }

  async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
    this.flagsAdded.push({ uids, flags });
    for (const flag of flags) this.messageFlags.add(flag);
    return true;
  }

  async fetchOne(range: string): Promise<unknown> {
    if (range !== '5') return false;
    const headerEnd = STORED_SOURCE.indexOf('\r\n\r\n');
    return {
      uid: 5,
      source: STORED_SOURCE,
      headers: STORED_SOURCE.subarray(0, headerEnd + 4),
      envelope: { subject: 'Договор', messageId: '<orig-5@mail.local>' },
      flags: this.messageFlags,
    };
  }
}

function testConfig(smtpPort: number, uploadDir: string): AppConfig {
  return {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: smtpPort,
    SMTP_SECURE: false,
    TLS_REJECT_UNAUTHORIZED: false,
    MESSAGE_MAX_BYTES: 25 * 1024 * 1024,
    COMPOSE_BODY_MAX_BYTES: 12 * 1024 * 1024,
    UPLOAD_DIR: uploadDir,
  } as unknown as AppConfig;
}

async function buildTestApp(
  client: FakeClient,
  config: AppConfig,
): Promise<{ app: FastifyInstance; scope: FastifyInstance }> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  const uploads = {
    get: async () => null,
    delete: async () => undefined,
  } as unknown as UploadStore;
  app.decorate('deps', {
    pool,
    uploads,
    config,
    secretBox: new SecretBox('тестовый-секрет-длиной-больше-32-символов'),
  } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  // Набор маршрутов написания живёт в своей области видимости, и работник
  // очереди объявлен именно там. Ссылку на неё сохраняем: из корневого
  // экземпляра Fastify декорации плагина не видны.
  let scope: FastifyInstance | null = null;
  await app.register(
    async (instance: FastifyInstance) => {
      await composeRoutes(instance);
      scope = instance;
    },
    { prefix: '/api' },
  );
  await app.ready();
  if (!scope) throw new Error('маршруты написания не зарегистрировались');
  return { app, scope };
}

function sendPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    to: [{ name: 'Получатель', address: 'to@mail.local' }],
    cc: [],
    bcc: [],
    subject: 'Проверка',
    bodyHtml: '<p>Текст</p>',
    attachmentIds: [],
    ...extra,
  };
}

/** Общая обвязка: временный каталог под очередь, SMTP и приложение. */
async function withApp(
  run: (ctx: {
    app: FastifyInstance;
    /** Область видимости маршрутов написания — там объявлен работник очереди. */
    scope: FastifyInstance;
    smtp: FakeSmtp;
    client: FakeClient;
    spoolDir: string;
  }) => Promise<void>,
): Promise<void> {
  const uploadDir = join(await mkdtemp(join(tmpdir(), 'mt-compose-')), 'uploads');
  const spoolDir = join(dirname(uploadDir), 'deferred');
  const smtp = await startFakeSmtp();
  const client = new FakeClient();
  const { app, scope } = await buildTestApp(client, testConfig(smtp.port, uploadDir));
  try {
    await run({ app, scope, smtp, client, spoolDir });
  } finally {
    await app.close();
    await smtp.close();
    await rm(dirname(uploadDir), { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Уведомить о прочтении                                               */
/* ------------------------------------------------------------------ */

test('просьба уведомить о прочтении доезжает заголовком в самом письме', async () => {
  await withApp(async ({ app, smtp }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ requestReadReceipt: true }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0] ?? '', /Disposition-Notification-To: <test@mail\.local>/);
  });
});

test('без просьбы заголовка нет — иначе о прочтении сообщали бы всегда', async () => {
  await withApp(async ({ app, smtp }) => {
    await app.inject({ method: 'POST', url: '/api/messages/send', payload: sendPayload() });
    assert.equal(/Disposition-Notification-To/.test(smtp.messages[0] ?? ''), false);
  });
});

test('уведомление о прочтении отправляется только по согласию человека', async () => {
  await withApp(async ({ app, smtp, client }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/inbox%3A5/read-receipt',
      payload: { send: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().sent, true);

    const mdn = smtp.messages.at(-1) ?? '';
    assert.match(mdn, /Content-Type: multipart\/report; report-type=disposition-notification;/);
    assert.match(mdn, /message\/disposition-notification/);
    assert.match(mdn, /^To: <ivan@mail\.local>$/m);
    // RFC 3503: письмо помечается и после отправки, и после отказа
    assert.deepEqual(client.flagsAdded, [{ uids: [5], flags: ['$MDNSent'] }]);
  });
});

test('отказ не шлёт ничего, но и спрашивать второй раз не даёт', async () => {
  await withApp(async ({ app, smtp, client }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/inbox%3A5/read-receipt',
      payload: { send: false },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().sent, false);
    assert.equal(smtp.messages.length, 0, 'при отказе не должно уйти ни одного письма');
    assert.deepEqual(client.flagsAdded, [{ uids: [5], flags: ['$MDNSent'] }]);

    // Повторный вопрос по тому же письму ничего не отправляет
    const again = await app.inject({
      method: 'POST',
      url: '/api/messages/inbox%3A5/read-receipt',
      payload: { send: true },
    });
    assert.equal(again.json().alreadyAnswered, true);
    assert.equal(smtp.messages.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Переслать как вложение                                              */
/* ------------------------------------------------------------------ */

test('пересланное письмо уходит частью message/rfc822 целиком', async () => {
  await withApp(async ({ app, smtp }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ subject: 'Fwd: Договор', attachMessageIds: ['inbox:5'] }),
    });
    assert.equal(res.statusCode, 200, res.body);

    const raw = smtp.messages[0] ?? '';
    assert.match(raw, /Content-Type: message\/rfc822/);
    // Внутри — исходное письмо целиком, а не его пересказ
    assert.match(raw, /Message-ID: <orig-5@mail\.local>/);
    assert.match(raw, /Content-Disposition: attachment/);
    // base64 для message/rfc822 запрещён (RFC 2046 §5.2.1)
    assert.equal(
      /Content-Transfer-Encoding: base64\r\n\r\n[A-Za-z0-9+/=\r\n]+Message-ID/.test(raw),
      false,
    );
  });
});

test('имя файла вложенного письма — из темы и без символов пути', () => {
  assert.equal(forwardedFilename('Договор'), 'Договор.eml');
  assert.equal(forwardedFilename(''), 'Письмо.eml');
  assert.equal(forwardedFilename('a/b\\c:d'), 'a_b_c_d.eml');
  assert.equal(forwardedFilename('тема\r\nBcc: x@y.z'), 'тема Bcc_ x@y.z.eml');
});

/* ------------------------------------------------------------------ */
/* Отложенная отправка                                                 */
/* ------------------------------------------------------------------ */

test('отложенное письмо не уходит сразу, а ложится в очередь на диск', async () => {
  await withApp(async ({ app, smtp, spoolDir }) => {
    const sendAt = new Date(Date.now() + 3600_000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ sendAt }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().scheduled, true);
    assert.equal(res.json().sendAt, sendAt);
    assert.equal(smtp.messages.length, 0, 'письму ещё рано уходить');

    // Именно на диске: браузер закроют, сервер перезапустят — письмо останется
    const queued = await new DeferredSpool(spoolDir).all();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.subject, 'Проверка');
    assert.deepEqual(queued[0]?.envelopeTo, ['to@mail.local']);
    assert.notEqual(queued[0]?.passwordEnc, 'test12345', 'пароль не должен лежать открытым');
  });
});

test('письмо, которому пора, уходит без всякого браузера', async () => {
  await withApp(async ({ app, scope, smtp, spoolDir }) => {
    // Секунда назад: очередь возьмёт его на первом же проходе
    await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ sendAt: new Date(Date.now() + 120_000).toISOString() }),
    });

    const spool = new DeferredSpool(spoolDir);
    const entry = (await spool.all())[0];
    assert.ok(entry);

    // Работник живёт внутри приложения и просыпается по таймеру; здесь тот же
    // проход зовётся руками, чтобы не ждать полминуты
    const sentCount = await scope.deferredSender.tick(new Date(Date.parse(entry.sendAt) + 1000));

    assert.equal(sentCount, 1);
    assert.equal(smtp.messages.length, 1);
    // Ушло именно то письмо: тема в заголовке закодирована по RFC 2047
    const encoded = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(smtp.messages[0] ?? '')?.[1] ?? '';
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'Проверка');
    assert.deepEqual(await readdir(spoolDir), [], 'из очереди письмо убирается');
  });
});

test('минута до отправки — это «сейчас», очередь ради такого не заводится', async () => {
  await withApp(async ({ app, smtp, spoolDir }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ sendAt: new Date(Date.now() + 5_000).toISOString() }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().scheduled, undefined);
    assert.equal(smtp.messages.length, 1);
    await assert.rejects(() => readdir(spoolDir));
  });
});
