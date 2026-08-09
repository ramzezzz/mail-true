/**
 * Черновики не должны размножаться — ни в папке, ни во временном хранилище.
 *
 * Два дефекта, у которых общий признак: человек ничего плохого не делает,
 * а мусор копится сам и мешает ему потом в СОВСЕМ ДРУГОМ месте.
 *
 * ПЕРВЫЙ. Открытие черновика (GET /drafts/:uid) выкладывало его вложения во
 * временное хранилище заново на КАЖДОЕ открытие: открыл, посмотрел, закрыл,
 * вернулся — и в хранилище лежат четыре копии одних и тех же файлов. Место
 * они занимают настоящее (uploads.usedBy их считает), а проверки предела на
 * ящик этот путь не проходил вовсе. Кончалось это отказом «предел на ящик —
 * 250,0 МБ» при попытке приложить обычный файл к другому письму.
 *
 * ВТОРОЙ. Ключ окна написания (draftKey). Пока клиент его не присылал,
 * неудачная отправка клала в «Черновики» ещё одну копию письма при каждой
 * попытке, а удачная не убирала ни одной: dropDraftAfterSend выходит по
 * первой строке, когда нет ни UID, ни ключа. Итог у человека: письмо ушло,
 * а в «Черновиках» лежат его копии, и одну из них он отправляет второй раз.
 *
 * Проверки идут на подставном ящике, который ХРАНИТ БАЙТЫ писем: заглушка,
 * отвечающая «ок» на APPEND и забывающая письмо, показала бы зелёные
 * проверки при полностью потерянном вложении.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { DraftContent } from '@mail-true/shared';
import type { AppConfig } from '../config.js';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import { UploadStore } from '../uploads.js';
import { composeRoutes } from './compose.js';

/* ------------------------------------------------------------------ */
/* Подставной ящик, помнящий письма                                    */
/* ------------------------------------------------------------------ */

class FakeClient {
  readonly drafts = new Map<number, Buffer>();
  readonly sent = new Map<number, Buffer>();
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

  async append(path: string, content: Buffer): Promise<{ uid: number }> {
    const uid = this.nextUid++;
    if (path === 'Sent') this.sent.set(uid, content);
    else this.drafts.set(uid, content);
    return { uid };
  }

  readonly capabilities = new Set<string>();

  async getMailboxLock(): Promise<{ release(): void }> {
    return { release: () => undefined };
  }

  async noop(): Promise<void> {}

  async fetchOne(range: string): Promise<{ uid: number; source: Buffer } | false> {
    const uid = Number(range);
    const source = this.drafts.get(uid);
    return source ? { uid, source } : false;
  }

  async messageDelete(uids: number[]): Promise<boolean> {
    for (const uid of uids) this.drafts.delete(uid);
    return true;
  }

  async search(): Promise<number[]> {
    return [];
  }

  async messageFlagsAdd(): Promise<boolean> {
    return true;
  }
}

/** Подставной SMTP submission — принимает всё. */
async function startFakeSmtp(): Promise<{ port: number; close(): Promise<void> }> {
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
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ------------------------------------------------------------------ */

interface Harness {
  app: FastifyInstance;
  client: FakeClient;
  uploads: UploadStore;
  close(): Promise<void>;
}

const OWNER = 'test@mail.local';

async function buildHarness(
  options: { smtpPort?: number; mailboxLimit?: number } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'mail-true-hygiene-'));
  const uploads = new UploadStore(join(dir, 'uploads'));
  await uploads.init();

  const config = {
    SMTP_HOST: '127.0.0.1',
    // Порт по умолчанию заведомо никем не занят: соединение не установится,
    // и это ровно тот временный отказ, при котором письмо уходит в черновики.
    SMTP_PORT: options.smtpPort ?? 1,
    SMTP_SECURE: false,
    TLS_REJECT_UNAUTHORIZED: false,
    MESSAGE_MAX_BYTES: 25 * 1024 * 1024,
    COMPOSE_BODY_MAX_BYTES: 12 * 1024 * 1024,
    UPLOAD_MAILBOX_MAX_BYTES: options.mailboxLimit ?? 250 * 1024 * 1024,
    UPLOAD_DIR: join(dir, 'uploads'),
  } as unknown as AppConfig;

  const client = new FakeClient();
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  app.decorate('deps', {
    pool,
    uploads,
    config,
    secretBox: { encrypt: (v: string) => v, decrypt: (v: string) => v },
  } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: OWNER, password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(composeRoutes, { prefix: '/api' });
  await app.ready();

  return {
    app,
    client,
    uploads,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function saveDraft(app: FastifyInstance, body: Record<string, unknown>): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/drafts',
    payload: { to: [], cc: [], bcc: [], subject: '', bodyHtml: '', attachmentIds: [], ...body },
  });
  assert.equal(response.statusCode, 200, response.body);
  const uid = (JSON.parse(response.body) as { draftUid: number | null }).draftUid;
  assert.ok(uid, 'сервер не вернул UID черновика');
  return uid;
}

async function readDraft(app: FastifyInstance, uid: number): Promise<DraftContent> {
  const response = await app.inject({ method: 'GET', url: `/api/drafts/${String(uid)}` });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as DraftContent;
}

/** Файл во временном хранилище, каким его кладёт окно написания. */
async function upload(uploads: UploadStore, name: string, bytes: number): Promise<string> {
  const meta = await uploads.save(
    OWNER,
    name,
    'application/pdf',
    Readable.from(Buffer.alloc(bytes, 7)),
  );
  return meta.id;
}

/* --- Открытие черновика не копит вложения --------------------------- */

test('черновик, открытый трижды, не оставляет во временном хранилище три копии вложения', async () => {
  const h = await buildHarness();
  try {
    const id = await upload(h.uploads, 'договор.pdf', 200 * 1024);
    const uid = await saveDraft(h.app, {
      to: [{ name: null, address: 'irina@mail.local' }],
      subject: 'С вложением',
      bodyHtml: '<div>во вложении</div>',
      attachmentIds: [id],
    });

    const first = await readDraft(h.app, uid);
    const afterFirst = await h.uploads.usedBy(OWNER);
    assert.equal(first.attachments.length, 1, 'вложение потеряно');

    const second = await readDraft(h.app, uid);
    const third = await readDraft(h.app, uid);
    const afterThird = await h.uploads.usedBy(OWNER);

    /*
     * Место, занятое ящиком, от повторных открытий расти не должно.
     * Именно это и упирало человека в предел на ящик: черновик с двумя
     * тяжёлыми вложениями «съедал» его за несколько заходов.
     */
    assert.equal(afterThird, afterFirst, 'повторное открытие черновика выложило вложения ещё раз');
    // И окно написания получает ТЕ ЖЕ идентификаторы — иначе прежние копии
    // остались бы лежать до уборщика, а это те же занятые мегабайты.
    assert.deepEqual(
      second.attachments.map((a) => a.id),
      first.attachments.map((a) => a.id),
    );
    assert.deepEqual(
      third.attachments.map((a) => a.id),
      first.attachments.map((a) => a.id),
    );
    assert.equal(third.attachments[0]?.filename, 'договор.pdf');
  } finally {
    await h.close();
  }
});

test('вложения черновика проверяются тем же пределом на ящик, что и обычная загрузка', async () => {
  // Предел выбран так, чтобы исходной загрузки он ещё не задел, а вот
  // второй копии того же файла места уже не оставил.
  const h = await buildHarness({ mailboxLimit: 300 * 1024 });
  try {
    const id = await upload(h.uploads, 'скан.pdf', 200 * 1024);
    const uid = await saveDraft(h.app, {
      to: [{ name: null, address: 'irina@mail.local' }],
      subject: 'Скан',
      bodyHtml: '<div>во вложении</div>',
      attachmentIds: [id],
    });

    const response = await h.app.inject({ method: 'GET', url: `/api/drafts/${String(uid)}` });
    assert.equal(response.statusCode, 413, response.body);
    // Отказ должен называть предел и говорить, что делать: «файл слишком
    // большой» тут не ответ ни на один вопрос человека.
    assert.match(response.json<{ message: string }>().message, /предел на ящик/u);
  } finally {
    await h.close();
  }
});

/* --- Ключ окна написания -------------------------------------------- */

test('две неудачные отправки одного окна оставляют ОДИН черновик, а не два', async () => {
  const h = await buildHarness();
  try {
    const letter = {
      draftKey: 'окно-1',
      to: [{ name: null, address: 'irina@mail.local' }],
      cc: [],
      bcc: [],
      subject: 'Не уходит',
      bodyHtml: '<div>текст письма</div>',
      attachmentIds: [],
    };

    for (const attempt of [1, 2, 3]) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/messages/send',
        payload: letter,
      });
      assert.equal(response.statusCode, 503, `попытка ${String(attempt)}: ${response.body}`);
      assert.match(response.json<{ message: string }>().message, /сохранён в черновиках/u);
    }

    assert.equal(
      h.client.drafts.size,
      1,
      'каждая неудачная отправка положила в «Черновики» ещё одну копию письма',
    );
  } finally {
    await h.close();
  }
});

test('удачная отправка убирает черновик, спасённый прошлой неудачей', async () => {
  const smtp = await startFakeSmtp();
  const broken = await buildHarness();
  try {
    const letter = {
      draftKey: 'окно-2',
      to: [{ name: null, address: 'irina@mail.local' }],
      cc: [],
      bcc: [],
      subject: 'Со второго раза',
      bodyHtml: '<div>текст письма</div>',
      attachmentIds: [],
    };

    const failed = await broken.app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: letter,
    });
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(broken.client.drafts.size, 1, 'письмо не спасено в черновики');
  } finally {
    await broken.close();
  }

  /*
   * Повтор — уже с работающим SMTP. Ящик здесь другой (свой подставной
   * клиент на каждый набор маршрутов), поэтому письмо сначала снова
   * укладывается в черновики отказом, а потом уходит: проверяем, что
   * ОСТАВШИЙСЯ после отправки черновик — ноль, а не один.
   */
  const h = await buildHarness({ smtpPort: smtp.port });
  try {
    const letter = {
      draftKey: 'окно-2',
      to: [{ name: null, address: 'irina@mail.local' }],
      cc: [],
      bcc: [],
      subject: 'Со второго раза',
      bodyHtml: '<div>текст письма</div>',
      attachmentIds: [],
    };
    const uid = await saveDraft(h.app, letter);
    assert.equal(h.client.drafts.size, 1);

    // Клиент присылает ключ окна и НЕ присылает UID — так и бывает, когда
    // черновик положило само сохранение, а окно про его UID ещё не знает.
    const sent = await h.app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: letter,
    });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.ok(uid > 0);
    assert.equal(
      h.client.drafts.size,
      0,
      'письмо ушло, а его черновик остался в папке — человек отправит копию второй раз',
    );
    assert.equal(h.client.sent.size, 1, 'копия не легла в «Отправленные»');
  } finally {
    await h.close();
    await smtp.close();
  }
});
