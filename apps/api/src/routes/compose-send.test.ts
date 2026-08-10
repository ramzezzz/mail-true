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
 *     не появлялось стрелки, которая есть в привычных почтовых интерфейсах.
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { SecretBox } from '../crypto.js';
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
  /** APPEND в «Черновики» не проходит: квота, права, пропавшая папка. */
  draftAppendFails?: boolean;
  /** Какие UID «находит» поиск по Message-ID. */
  answerable?: number[];
}

class FakeClient {
  readonly drafts = new Set<number>();
  readonly sent = new Set<number>();
  readonly flagsAdded: Array<{ uids: number[] | string; flags: string[] }> = [];
  /** Что именно легло в ящик — по нему видно, какой текст спасён. */
  readonly sources = new Map<number, Buffer>();
  private nextUid = 100;

  constructor(private readonly options: FakeClientOptions = {}) {}

  /**
   * Текст единственного оставшегося черновика — уже раскодированный.
   *
   * Части письма едут base64 (иначе кириллица не пережила бы SMTP), и
   * искать в сыром исходнике слова письма бесполезно.
   */
  draftText(): string {
    const uid = [...this.drafts][0];
    if (uid === undefined) return '';
    const raw = this.sources.get(uid)?.toString('utf8') ?? '';
    let text = raw;
    // Части base64 переносятся по 76 символов — собираем подряд идущие
    // строки обратно в одну и раскодируем
    let chunk = '';
    const flush = (): void => {
      if (chunk.length >= 8) text += `\n${Buffer.from(chunk, 'base64').toString('utf8')}`;
      chunk = '';
    };
    for (const line of raw.split(/\r?\n/)) {
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(line) && line.length >= 8) chunk += line;
      else flush();
    }
    flush();
    return text;
  }

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

  async append(path: string, raw: Buffer): Promise<{ uid: number }> {
    if (path === 'Sent') {
      if (this.options.sentAppendFails) {
        // Так отвечает Dovecot при исчерпанной квоте
        throw Object.assign(new Error('[OVERQUOTA] Quota exceeded (mailbox for user is full)'), {
          serverResponseCode: 'OVERQUOTA',
        });
      }
      const uid = this.nextUid++;
      this.sent.add(uid);
      this.sources.set(uid, raw);
      return { uid };
    }
    if (this.options.draftAppendFails) throw new Error('ящик не принял письмо: кончилось место');
    const uid = this.nextUid++;
    this.drafts.add(uid);
    this.sources.set(uid, raw);
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

  /** UID, которые удалили из «Черновиков». */
  readonly deleted: number[] = [];

  async messageDelete(uids: number[]): Promise<boolean> {
    for (const uid of uids) {
      this.deleted.push(uid);
      this.drafts.delete(uid);
    }
    return true;
  }

  async search(): Promise<number[]> {
    return this.options.answerable ?? [];
  }

  async messageFlagsAdd(uids: number[] | string, flags: string[]): Promise<boolean> {
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
    // Рядом с этим каталогом маршруты написания заводят очередь отложенной
    // отправки. Здесь она не используется, но путь должен быть настоящим.
    UPLOAD_DIR: join(tmpdir(), 'mail-true-test-uploads'),
    ...overrides,
  } as unknown as AppConfig;
}

async function buildTestApp(
  client: FakeClient,
  config: AppConfig,
  /**
   * Настройки ящика. Их читает отправка ради имени отправителя и срока
   * отмены; в большинстве проверок раздела настроек нет вовсе — ровно как
   * на установке без базы, где письмо обязано уходить как раньше.
   */
  settings?: { senderName?: string | null; undoSendSeconds?: number },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.MT_TEST_LOG === '1' }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  const uploads = {
    get: async () => null,
    delete: async () => undefined,
  } as unknown as UploadStore;
  /*
   * Пароль ящика в очереди хранится зашифрованным, поэтому подставляем
   * настоящий SecretBox: подделка «туда-обратно без шифрования» скрыла бы
   * ровно ту ошибку, из-за которой отложенное письмо не отправлялось бы
   * вовсе — расшифровку в работнике очереди.
   */
  const secretBox = new SecretBox('proverochnyy-sekret-dlya-testov-32b');
  app.decorate('deps', { pool, uploads, config, secretBox } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  if (settings) {
    app.decorate('settingsService', {
      available: true,
      requireDb: () => ({
        getSettings: async () => ({
          senderName: settings.senderName ?? null,
          undoSendSeconds: settings.undoSendSeconds ?? 0,
        }),
      }),
    } as never);
  }
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload(),
    });
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload(),
    });
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload(),
    });
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
    assert.equal(client.drafts.size, 1, 'в «Черновиках» должно остаться одно письмо, а не два');
    // Черновик заменён новой версией, а не оставлен прежним: названный
    // в ответе UID обязан существовать, иначе окно пошлёт человека
    // за письмом, которого нет
    const kept = (res.json() as { details: { draftUid: number } }).details.draftUid;
    assert.equal(client.drafts.has(kept), true);
    assert.equal(client.deleted.includes(uid), true, 'прежняя версия обязана уйти');
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------------------ */
/* Открытый черновик обещали сохранить — и не сохраняли                */
/* ------------------------------------------------------------------ */

test('отказ отправки сохраняет ДОПИСАННЫЙ текст, а не версию недельной давности', async () => {
  /*
   * Как это выглядело. Человек открыл сохранённый черновик, дописал две
   * страницы, нажал «Отправить» — почтовый сервер отказал. В ответе:
   * «Письмо сохранено в черновиках». В черновиках при этом лежала СТАРАЯ
   * версия: сохранение черновика после отказа выходило первой же строкой,
   * увидев присланный draftUid («черновик прислан, значит он на месте»).
   * На месте он и был — только без того, что человек написал сегодня.
   */
  const port = await deadPort();
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: port }));
  try {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: sendPayload({ draftKey: 'окно-9', bodyHtml: '<p>первая версия</p>' }),
    });
    const uid = saved.json().draftUid as number;
    assert.match(client.draftText(), /первая версия/);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({
        draftKey: 'окно-9',
        draftUid: uid,
        bodyHtml: '<p>дописанное за сегодня, чего терять нельзя</p>',
      }),
    });
    assert.equal(res.statusCode, 503, res.body);
    assert.match(res.json<{ message: string }>().message, /черновик/i);

    assert.equal(client.drafts.size, 1, 'копий черновика больше становиться не должно');
    assert.match(
      client.draftText(),
      /дописанное за сегодня/,
      'в «Черновиках» осталась прежняя версия, а ответ обещал сохранить письмо',
    );
  } finally {
    await app.close();
  }
});

test('не сохранился — так и сказано: обещать черновик нельзя', async () => {
  // Обратный ход: ящик не принимает письма вовсе. Тогда и совет должен
  // быть другим — «не закрывайте окно», потому что текст сейчас только там.
  const port = await deadPort();
  const client = new FakeClient({ draftAppendFails: true });
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: port }));
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ draftKey: 'окно-10', draftUid: 100 }),
    });
    assert.equal(res.statusCode, 503, res.body);
    const body = res.json() as { message: string; details: { draftUid: number | null } };
    assert.equal(body.details.draftUid, null);
    assert.doesNotMatch(body.message, /сохранён в черновиках/i);
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
    // Номера сворачиваются в набор-строку: флаг ставится общим путём
    // storeFlags, который заодно проверяет ответ сервера, — прямой вызов
    // messageFlagsAdd отказ STORE не замечал.
    assert.deepEqual(client.flagsAdded, [{ uids: '17', flags: ['\\Answered'] }]);
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(client.flagsAdded, []);
  } finally {
    await app.close();
    await smtp.close();
  }
});

/* ------------------------------------------------------------------ */
/* Имя отправителя и очередь «Отправить позже»                          */
/* ------------------------------------------------------------------ */

test('имя отправителя из настроек попадает в письмо', async () => {
  const smtp = await startFakeSmtp();
  const client = new FakeClient();
  // Настройки ящика: имя задано человеком в разделе «Общие».
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: smtp.port }), {
    senderName: 'Иван Петров',
  });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload(),
    });
    assert.equal(res.statusCode, 200, `тело ответа: ${res.body.slice(0, 300)}`);
    // Смотрим копию в «Отправленных»: это те же байты, что ушли по SMTP.
    const uid = [...client.sent][0];
    assert.ok(uid !== undefined, 'копия письма обязана лечь в «Отправленные»');
    const raw = client.sources.get(uid)?.toString('utf8') ?? '';
    // Кириллица в заголовке едет кодированной, поэтому проверяем сам факт
    // имени рядом с адресом, а не голый адрес, как было раньше.
    assert.match(raw, /From: =\?[^?]+\?[BQ]\?[^?]+\?=\s*<test@mail\.local>/i);
  } finally {
    await app.close();
    await smtp.close();
  }
});

test('отмена отложенного письма возвращает его в «Черновики»', async () => {
  const smtp = await startFakeSmtp();
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig({ SMTP_PORT: smtp.port }));
  try {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ sendAt: at, bcc: [{ name: '', address: 'skrytyy@mail.local' }] }),
    });
    assert.equal(sent.statusCode, 200, `тело ответа: ${sent.body.slice(0, 300)}`);
    const scheduled = sent.json() as { scheduled: boolean; pendingId: string };
    assert.equal(scheduled.scheduled, true);
    // Номер письма в очереди — им же его и отменяют. Без него отменить
    // отложенное письмо было нечем.
    assert.ok(scheduled.pendingId, 'сервер обязан вернуть номер письма в очереди');

    // Оно и правда видно в очереди — до этого списка не было ни у кого.
    const list = await app.inject({ method: 'GET', url: '/api/messages/scheduled' });
    const items = (list.json() as { items: Array<{ id: string }> }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, scheduled.pendingId);

    const undo = await app.inject({
      method: 'POST',
      url: '/api/messages/send/undo',
      payload: { pendingId: scheduled.pendingId },
    });
    const result = undo.json() as { cancelled: boolean; draftUid: number | null };
    assert.equal(result.cancelled, true);
    // Письмо не стёрто, а возвращено: другого места, где остался текст,
    // у отложенного письма нет — окно закрыто, черновик удалён при
    // постановке в очередь.
    assert.ok(result.draftUid, 'отменённое отложенное письмо обязано лечь в черновики');
    assert.equal(client.drafts.size, 1);
    // Скрытая копия возвращается заголовком, иначе дописанное письмо
    // молча ушло бы без части получателей.
    assert.match(client.draftText(), /skrytyy@mail\.local/);

    const after = await app.inject({ method: 'GET', url: '/api/messages/scheduled' });
    assert.equal((after.json() as { items: unknown[] }).items.length, 0);
  } finally {
    await app.close();
    await smtp.close();
  }
});
