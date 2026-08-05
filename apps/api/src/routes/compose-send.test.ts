/**
 * Проверки отправки письма на подставных IMAP и SMTP.
 *
 * Три случая, воспроизведённые на живом стенде:
 *
 *  1. Ящик переполнен. Письмо ушло получателю, а копия в «Отправленные» не
 *     легла по квоте — и API отвечал 500 «Внутренняя ошибка». Человек не
 *     находил письма в «Отправленных» и отправлял второй раз: у получателя
 *     оказывались два одинаковых письма (проверено — именно так и вышло).
 *  2. Временный отказ отправки (сервер недоступен, перезапуск служб,
 *     обновление продукта). Отдавалась 503, а в «Черновиках» было ПУСТО:
 *     черновик сохранялся только при постоянном отказе и при превышении
 *     размера. Набранный текст пропадал целиком.
 *  3. После ответа исходное письмо не получало флага «отвечено» — в списке
 *     не появлялось стрелки, которая есть в mail.ru.
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import type { UploadStore } from '../uploads.js';
import { composeRoutes } from './compose.js';

/* ------------------------------------------------------------------ */
/* Подставной SMTP submission                                          */
/* ------------------------------------------------------------------ */

interface FakeSmtp {
  port: number;
  close(): Promise<void>;
}

/**
 * Минимальный SMTP-сервер: ровно столько, сколько нужно nodemailer.
 * STARTTLS намеренно не объявляется — иначе клиент полезет обновлять
 * соединение и упрётся в отсутствие сертификата.
 */
async function startFakeSmtp(): Promise<FakeSmtp> {
  const server: Server = createServer((socket: Socket) => {
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\r\n')) {
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued as FAKE\r\n');
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Порт, на котором заведомо никто не слушает: сервер поднят и сразу закрыт. */
async function deadPort(): Promise<number> {
  const smtp = await startFakeSmtp();
  await smtp.close();
  return smtp.port;
}

/* ------------------------------------------------------------------ */
/* Подставной ящик                                                     */
/* ------------------------------------------------------------------ */

interface FakeClientOptions {
  /** APPEND в «Отправленные» отбивается по квоте. */
  sentAppendFails?: boolean;
  /** Какие UID «находит» поиск по Message-ID. */
  answerable?: number[];
}

class FakeClient {
  readonly drafts = new Set<number>();
  readonly sent = new Set<number>();
  readonly flagsAdded: Array<{ uids: number[]; flags: string[] }> = [];
  private nextUid = 100;

  constructor(private readonly options: FakeClientOptions = {}) {}

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
    return [
      folder('INBOX', '\\Inbox'),
      folder('Sent', '\\Sent'),
      folder('Drafts', '\\Drafts'),
    ];
  }

  async append(path: string): Promise<{ uid: number }> {
    if (path === 'Sent') {
      if (this.options.sentAppendFails) {
        // Так отвечает Dovecot при исчерпанной квоте
        throw Object.assign(new Error('[OVERQUOTA] Quota exceeded (mailbox for user is full)'), {
          serverResponseCode: 'OVERQUOTA',
        });
      }
      const uid = this.nextUid++;
      this.sent.add(uid);
      return { uid };
    }
    const uid = this.nextUid++;
    this.drafts.add(uid);
    return { uid };
  }

  /**
   * Возможности сервера. Настоящий клиент их всегда знает, поддельный —
   * не знал, и обращение к ним валило проверки, как только продукт научился
   * спрашивать про SORT.
   *
   * Пустой набор означает «сервер ничего сверх обязательного не умеет» —
   * значит, продукт пойдёт запасным путём. Это и правильное поведение по
   * умолчанию для заглушки: она проверяет наш код, а не чужой сервер.
   */
  readonly capabilities = new Set<string>();

  async getMailboxLock(): Promise<{ release(): void }> {
    return { release: () => undefined };
  }

  /**
   * NOOP. Настоящий продукт зовёт его перед поиском, чтобы почтовый сервер
   * пересмотрел папку: соединение живёт между запросами, и без этого список
   * отставал ровно на одно письмо.
   *
   * Заглушка обязана уметь всё, что умеет настоящий клиент. Когда NOOP
   * появился в продукте, заглушки его не знали — и падали. Это десятый по
   * счёту случай, когда заглушка разошлась с настоящим; хорошо, что на этот
   * раз расхождение поймали проверки, а не человек.
   */
  async noop(): Promise<void> {}

  async messageDelete(uids: number[]): Promise<boolean> {
    for (const uid of uids) this.drafts.delete(uid);
    return true;
  }

  async search(): Promise<number[]> {
    return this.options.answerable ?? [];
  }

  async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
    this.flagsAdded.push({ uids, flags });
    return true;
  }
}

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    TLS_REJECT_UNAUTHORIZED: false,
    MESSAGE_MAX_BYTES: 25 * 1024 * 1024,
    COMPOSE_BODY_MAX_BYTES: 12 * 1024 * 1024,
    ...overrides,
  } as unknown as AppConfig;
}

async function buildTestApp(client: FakeClient, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  const uploads = { get: async () => null, delete: async () => undefined } as unknown as UploadStore;
  app.decorate('deps', { pool, uploads, config } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(composeRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

function sendPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    to: [{ name: 'Получатель', address: 'to@mail.local' }],
    cc: [],
    bcc: [],
    subject: 'Проверка отправки',
    bodyHtml: '<p>Текст письма, который нельзя терять</p>',
    attachmentIds: [],
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Находка 3: неудача копии в «Отправленные» выдавалась за неудачу     */
/*            отправки                                                 */
/* ------------------------------------------------------------------ */

test('переполненный ящик не превращает отправленное письмо в ошибку', async () => {
  const smtp = await startFakeSmtp();
  const client = new FakeClient({ sentAppendFails: true });
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: smtp.port }));
  try {
    const res = await app.inject({ method: 'POST', url: '/api/messages/send', payload: sendPayload() });
    assert.equal(res.statusCode, 200, `тело ответа: ${res.body.slice(0, 300)}`);
    const body = res.json() as {
      ok: boolean;
      savedToSent: boolean;
      warning: string | null;
      sentMessageId: string | null;
    };
    // Письмо получателю ушло — значит отправка удалась
    assert.equal(body.ok, true);
    // …но копии в «Отправленных» нет, и об этом сказано отдельно
    assert.equal(body.savedToSent, false);
    assert.equal(client.sent.size, 0);
    assert.equal(body.sentMessageId, null);
    assert.match(body.warning ?? '', /Отправленн/);
  } finally {
    await app.close();
    await smtp.close();
  }
});

test('обычная отправка кладёт копию в «Отправленные»', async () => {
  const smtp = await startFakeSmtp();
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: smtp.port }));
  try {
    const res = await app.inject({ method: 'POST', url: '/api/messages/send', payload: sendPayload() });
    assert.equal(res.statusCode, 200, `тело ответа: ${res.body.slice(0, 300)}`);
    const body = res.json() as { ok: boolean; savedToSent: boolean; sentMessageId: string | null };
    assert.equal(body.ok, true);
    assert.equal(body.savedToSent, true);
    assert.equal(client.sent.size, 1);
    assert.match(body.sentMessageId ?? '', /^sent:\d+$/);
  } finally {
    await app.close();
    await smtp.close();
  }
});

/* ------------------------------------------------------------------ */
/* Находка 4: временный отказ отправки терял письмо целиком            */
/* ------------------------------------------------------------------ */

test('временный отказ отправки сохраняет письмо в черновиках', async () => {
  const port = await deadPort();
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: port }));
  try {
    const res = await app.inject({ method: 'POST', url: '/api/messages/send', payload: sendPayload() });
    assert.equal(res.statusCode, 503);
    const body = res.json() as {
      error: string;
      message: string;
      details: { draftId: string | null; draftUid: number | null };
    };
    assert.equal(body.error, 'UPSTREAM_UNAVAILABLE');
    assert.match(body.message, /черновик/i);
    assert.equal(client.drafts.size, 1, 'текст письма обязан остаться в «Черновиках»');
    assert.equal(typeof body.details.draftUid, 'number');
    assert.equal(body.details.draftId, `drafts:${String(body.details.draftUid)}`);
    assert.equal(client.drafts.has(body.details.draftUid as number), true);
  } finally {
    await app.close();
  }
});

test('временный отказ не плодит копию уже существующего черновика', async () => {
  const port = await deadPort();
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: port }));
  try {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: sendPayload({ draftKey: 'окно-1' }),
    });
    const uid = saved.json().draftUid as number;
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ draftKey: 'окно-1', draftUid: uid }),
    });
    assert.equal(res.statusCode, 503);
    assert.equal(client.drafts.size, 1);
    assert.equal((res.json() as { details: { draftUid: number } }).details.draftUid, uid);
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------------------ */
/* Находка 8: ответ не помечал исходное письмо                         */
/* ------------------------------------------------------------------ */

test('после ответа исходное письмо получает флаг «отвечено»', async () => {
  const smtp = await startFakeSmtp();
  const client = new FakeClient({ answerable: [17] });
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: smtp.port }));
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ inReplyTo: '<исходное@mail.local>' }),
    });
    assert.equal(res.statusCode, 200, `тело ответа: ${res.body.slice(0, 300)}`);
    assert.deepEqual(client.flagsAdded, [{ uids: [17], flags: ['\\Answered'] }]);
  } finally {
    await app.close();
    await smtp.close();
  }
});

test('обычное письмо (не ответ) флагов никому не ставит', async () => {
  const smtp = await startFakeSmtp();
  const client = new FakeClient({ answerable: [17] });
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: smtp.port }));
  try {
    const res = await app.inject({ method: 'POST', url: '/api/messages/send', payload: sendPayload() });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(client.flagsAdded, []);
  } finally {
    await app.close();
    await smtp.close();
  }
});
