/**
 * Дописывание сохранённого черновика.
 *
 * Дефект, ради которого это написано: сохранённый черновик нельзя было
 * дописать вообще ничем. Он сохранялся, показывался в папке «Черновики» —
 * и всё. Прочитать его обратно в окно написания было нечем: маршрута не
 * существовало, а щелчок по черновику открывал обычный просмотр письма.
 * То есть папка «Черновики» работала как хранилище недоступного текста.
 *
 * Проверки идут на подставном ящике, который ХРАНИТ БАЙТЫ писем: без этого
 * ни чтение черновика назад, ни сохранность вложений проверить нельзя —
 * заглушка, отвечающая «ок» на APPEND и забывающая письмо, показала бы
 * зелёные проверки при полностью потерянном вложении.
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
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
/* Подставной ящик, помнящий письма                                     */
/* ------------------------------------------------------------------ */

class FakeClient {
  /** Черновики: UID → байты письма. Именно байты — см. заголовок файла. */
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

/* ------------------------------------------------------------------ */
/* Подставной SMTP submission — принимает всё                          */
/* ------------------------------------------------------------------ */

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
  dir: string;
  close(): Promise<void>;
}

async function buildHarness(smtpPort = 25): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'mail-true-draft-'));
  // Настоящее хранилище загрузок, а не заглушка: маршрут чтения черновика
  // именно им и пользуется, когда возвращает вложения обратно в форму.
  const uploads = new UploadStore(join(dir, 'uploads'));
  await uploads.init();

  const config = {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: smtpPort,
    SMTP_SECURE: false,
    TLS_REJECT_UNAUTHORIZED: false,
    MESSAGE_MAX_BYTES: 25 * 1024 * 1024,
    COMPOSE_BODY_MAX_BYTES: 12 * 1024 * 1024,
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
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(composeRoutes, { prefix: '/api' });
  await app.ready();

  return {
    app,
    client,
    uploads,
    dir,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Черновик как его кладёт окно написания. Возвращает UID. */
async function saveDraft(
  app: FastifyInstance,
  body: Record<string, unknown>
): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/drafts',
    payload: {
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      bodyHtml: '',
      attachmentIds: [],
      ...body,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const uid = (JSON.parse(response.body) as { draftUid: number | null }).draftUid;
  assert.ok(uid, 'сервер не вернул UID черновика');
  return uid;
}

async function readDraft(app: FastifyInstance, uid: number): Promise<DraftContent> {
  const response = await app.inject({ method: 'GET', url: `/api/drafts/${uid}` });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as DraftContent;
}

test('сохранённый черновик читается обратно в форму — со всеми полями', async () => {
  const h = await buildHarness();
  try {
    const uid = await saveDraft(h.app, {
      to: [{ name: 'Ирина', address: 'irina@mail.local' }],
      cc: [{ name: null, address: 'copy@mail.local' }],
      bcc: [{ name: null, address: 'hidden@mail.local' }],
      subject: 'Договор на подпись',
      bodyHtml: '<div>Добрый день! Отправляю договор</div>',
      attachmentIds: [],
      requestReadReceipt: true,
    });

    const draft = await readDraft(h.app, uid);

    assert.equal(draft.draftUid, uid);
    assert.deepEqual(
      draft.to.map((a) => a.address),
      ['irina@mail.local']
    );
    assert.equal(draft.to[0]?.name, 'Ирина');
    assert.deepEqual(
      draft.cc.map((a) => a.address),
      ['copy@mail.local']
    );
    // «Скрытая копия» — самое опасное поле: потеряй её при дописывании,
    // и письмо уйдёт не всем, кому человек его адресовал, причём молча.
    assert.deepEqual(
      draft.bcc.map((a) => a.address),
      ['hidden@mail.local']
    );
    assert.equal(draft.subject, 'Договор на подпись');
    assert.match(draft.bodyHtml, /Отправляю договор/u);
    // Просьба уведомить о прочтении поставлена осознанно — она обязана
    // пережить дописывание
    assert.equal(draft.requestReadReceipt, true);
  } finally {
    await h.close();
  }
});

test('вложение черновика возвращается ровно одно и переживает пересохранение', async () => {
  const h = await buildHarness();
  try {
    const upload = await h.uploads.save(
      'договор.pdf',
      'application/pdf',
      Readable.from(Buffer.from('%PDF-1.4 текст договора'))
    );
    const uid = await saveDraft(h.app, {
      to: [{ name: null, address: 'irina@mail.local' }],
      subject: 'С вложением',
      bodyHtml: '<div>во вложении</div>',
      attachmentIds: [upload.id],
    });

    const draft = await readDraft(h.app, uid);
    assert.equal(draft.attachments.length, 1, 'вложение потеряно или продублировано');
    assert.equal(draft.attachments[0]?.filename, 'договор.pdf');
    assert.ok((draft.attachments[0]?.size ?? 0) > 0, 'вложение вернулось пустым');

    // Дописали и сохранили заново — вложение должно быть в письме по-прежнему
    // ровно одно: ни потеряно, ни удвоено.
    const second = await saveDraft(h.app, {
      draftUid: uid,
      to: [{ name: null, address: 'irina@mail.local' }],
      subject: 'С вложением',
      bodyHtml: '<div>во вложении, дописано</div>',
      attachmentIds: draft.attachments.map((a) => a.id),
    });
    const again = await readDraft(h.app, second);
    assert.equal(again.attachments.length, 1, 'после пересохранения вложений стало не одно');
    assert.equal(again.attachments[0]?.filename, 'договор.pdf');
    assert.match(again.bodyHtml, /дописано/u);
  } finally {
    await h.close();
  }
});

test('двойное сохранение дописанного черновика оставляет в папке ОДИН черновик', async () => {
  const h = await buildHarness();
  try {
    const first = await saveDraft(h.app, {
      to: [{ name: null, address: 'irina@mail.local' }],
      subject: 'Черновик',
      bodyHtml: '<div>первый заход</div>',
    });
    assert.equal(h.client.drafts.size, 1);

    const second = await saveDraft(h.app, {
      draftUid: first,
      to: [{ name: null, address: 'irina@mail.local' }],
      subject: 'Черновик',
      bodyHtml: '<div>второй заход</div>',
    });
    assert.equal(h.client.drafts.size, 1, 'после второго сохранения черновиков стало больше одного');

    const third = await saveDraft(h.app, {
      draftUid: second,
      to: [{ name: null, address: 'irina@mail.local' }],
      subject: 'Черновик',
      bodyHtml: '<div>третий заход</div>',
    });
    assert.equal(h.client.drafts.size, 1, 'после третьего сохранения черновиков стало больше одного');

    // И в папке лежит именно последняя версия, а не первая: «один черновик»
    // ничего не стоит, если это застрявшая первая редакция.
    const kept = await readDraft(h.app, third);
    assert.match(kept.bodyHtml, /третий заход/u);
  } finally {
    await h.close();
  }
});

test('отправка дописанного черновика убирает его из папки', async () => {
  const smtp = await startFakeSmtp();
  const h = await buildHarness(smtp.port);
  try {
    const uid = await saveDraft(h.app, {
      to: [{ name: null, address: 'irina@mail.local' }],
      subject: 'Уходит',
      bodyHtml: '<div>дописано и отправлено</div>',
    });
    assert.equal(h.client.drafts.size, 1);

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        draftUid: uid,
        to: [{ name: null, address: 'irina@mail.local' }],
        cc: [],
        bcc: [],
        subject: 'Уходит',
        bodyHtml: '<div>дописано и отправлено</div>',
        attachmentIds: [],
      },
    });
    assert.equal(response.statusCode, 200, response.body);

    // Оставшийся после отправки черновик — классическая беда почтовых
    // клиентов: человек потом гадает, ушло письмо или нет, и отправляет
    // второй раз.
    assert.equal(h.client.drafts.size, 0, 'черновик остался в папке после отправки');
    assert.equal(h.client.sent.size, 1, 'копия не легла в «Отправленные»');
  } finally {
    await h.close();
    await smtp.close();
  }
});

test('в ОТПРАВЛЕННОМ письме заголовка Bcc нет — скрытые получатели остаются скрытыми', async () => {
  const smtp = await startFakeSmtp();
  const h = await buildHarness(smtp.port);
  try {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: {
        to: [{ name: null, address: 'irina@mail.local' }],
        cc: [],
        bcc: [{ name: null, address: 'hidden@mail.local' }],
        subject: 'Со скрытой копией',
        bodyHtml: '<div>текст</div>',
        attachmentIds: [],
      },
    });
    assert.equal(response.statusCode, 200, response.body);

    // Черновику заголовок Bcc нужен, письму — категорически нет: он уехал бы
    // ко ВСЕМ получателям и назвал бы им тех, кого от них скрыли.
    const raw = [...h.client.sent.values()][0]?.toString('utf8') ?? '';
    assert.ok(raw.length > 0, 'копия не легла в «Отправленные»');
    assert.doesNotMatch(raw, /^Bcc:/mu, 'скрытый получатель попал в заголовки письма');
    assert.doesNotMatch(raw, /hidden@mail\.local/u, 'скрытый адрес виден в письме');
  } finally {
    await h.close();
    await smtp.close();
  }
});

test('несуществующий черновик — это 404, а не пустая форма', async () => {
  const h = await buildHarness();
  try {
    const response = await h.app.inject({ method: 'GET', url: '/api/drafts/999' });
    assert.equal(response.statusCode, 404);
  } finally {
    await h.close();
  }
});
