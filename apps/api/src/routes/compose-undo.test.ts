/**
 * Отмена отправки: несколько секунд после «Отправить», в которые письмо
 * ещё можно вернуть.
 *
 * Проверяется не плашка в браузере, а то, ЧТО ПРОИСХОДИТ С ПИСЬМОМ:
 *
 *  1. письмо эти секунды лежит в очереди НА ДИСКЕ, а не в памяти браузера
 *     и не в памяти процесса — закрытая вкладка отменяет отмену, а не
 *     отправку;
 *  2. отмена не оставляет следов: ни у получателя, ни в «Отправленных»,
 *     ни в очереди;
 *  3. опоздавшая отмена получает честный отказ, а не молчание и не ложное
 *     «отменено»;
 *  4. выключенная настройка возвращает прежнее поведение до последней
 *     мелочи — письмо уходит тем же кодом, в том же запросе.
 *
 * Каждая проверка идёт обратным ходом: рядом с «сработало» стоит «а без
 * этого не сработало бы».
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { SecretBox } from '../crypto.js';
import { registerErrorHandling } from '../http-errors.js';
import { DeferredSpool, readFailureFromRaw, retryDelayMs } from '../mail/deferred-send.js';
import type { AppDeps } from '../types.js';
import type { UploadStore } from '../uploads.js';
import { composeRoutes } from './compose.js';

/* ------------------------------------------------------------------ */
/* Подставной SMTP: запоминает всё, что через него прошло               */
/* ------------------------------------------------------------------ */

interface FakeSmtp {
  port: number;
  readonly messages: string[];
  close(): Promise<void>;
}

/**
 * `rejectAll` — сервер отвечает постоянным отказом на каждого получателя.
 * Это и есть настоящая неудача отправки: несуществующий адрес, закрытый
 * ящик, недостижимый домен. Проверять извещение об отказе можно только
 * на настоящем отказе.
 */
async function startFakeSmtp(options: { rejectAll?: boolean } = {}): Promise<FakeSmtp> {
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
        } else if (command === 'RCPT' && options.rejectAll) {
          // Так отвечает Postfix на несуществующий ящик. Постоянный отказ:
          // повторять бессмысленно, и работник очереди сдаётся сразу.
          socket.write('550 5.1.1 <to@mail.local>: Recipient address rejected: User unknown\r\n');
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

class FakeClient {
  readonly sent = new Set<number>();
  readonly drafts = new Set<number>();
  /** Всё, что легло в ящик, — по нему проверяется заголовок причины. */
  readonly appended: Array<{ path: string; raw: Buffer }> = [];
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

  /** Что лежит под каким UID — по этому FETCH читает черновик обратно. */
  private readonly sources = new Map<number, Buffer>();

  /** Ящик не принимает письма: сменился пароль, кончилось место, отвалился IMAP. */
  appendFails = false;

  async append(path: string, raw: Buffer): Promise<{ uid: number }> {
    if (this.appendFails) throw new Error('ящик не принял письмо');
    const uid = this.nextUid++;
    this.appended.push({ path, raw });
    this.sources.set(uid, raw);
    if (path === 'Sent') this.sent.add(uid);
    else this.drafts.add(uid);
    return { uid };
  }

  /** Чтение черновика обратно в окно написания (GET /api/drafts/:uid). */
  async fetchOne(range: string): Promise<{ uid: number; source: Buffer } | false> {
    const uid = Number(range);
    const source = this.sources.get(uid);
    return source ? { uid, source } : false;
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

  async messageFlagsAdd(): Promise<boolean> {
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Подставные загрузки: настоящие файлы во временном каталоге           */
/* ------------------------------------------------------------------ */

/**
 * Хранилище вложений, которое умеет ровно то, что нужно отправке: отдать
 * файл по идентификатору и удалить его. Удаления запоминаются — по ним и
 * проверяется, что отменённое письмо не осталось без вложений.
 */
class FakeUploads {
  readonly deleted: string[] = [];
  readonly files = new Map<string, { path: string; filename: string }>();

  constructor(private readonly dir: string) {}

  async put(id: string, filename: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, id);
    await writeFile(path, content, 'utf8');
    this.files.set(id, { path, filename });
  }

  async get(id: string): Promise<unknown> {
    const found = this.files.get(id);
    if (!found) return null;
    return { path: found.path, meta: { filename: found.filename, mimeType: 'text/plain' } };
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
    this.files.delete(id);
  }
}

/* ------------------------------------------------------------------ */
/* Приложение                                                          */
/* ------------------------------------------------------------------ */

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

interface AppOptions {
  /** Что отвечает раздел настроек про срок отмены. */
  undoSendSeconds?: number;
  /** Почтовый сервер отвергает всех получателей навсегда. */
  smtpRejects?: boolean;
  /** Открытых вкладок нет — сказать в сокет некому. */
  noOpenTab?: boolean;
  /** Настроек нет вовсе — база не задана или отвалилась. */
  settingsAvailable?: boolean;
  /** Чтение настроек кончается ошибкой. */
  settingsBroken?: boolean;
}

async function buildTestApp(
  client: FakeClient,
  uploads: FakeUploads,
  config: AppConfig,
  options: AppOptions,
  wsEvents: Array<{ email: string; payload: unknown }>,
): Promise<{ app: FastifyInstance; scope: FastifyInstance }> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  app.decorate('deps', {
    pool,
    uploads: uploads as unknown as UploadStore,
    config,
    secretBox: new SecretBox('тестовый-секрет-длиной-больше-32-символов'),
  } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);

  /**
   * Раздел настроек подставной. В настоящем приложении он подключается
   * ПОЗЖЕ написания писем (см. app.ts), поэтому маршрут отправки и
   * спрашивает его при запросе, а не при регистрации, — здесь та же
   * последовательность: декорация ставится после composeRoutes.
   */
  let scope: FastifyInstance | null = null;
  await app.register(
    async (instance: FastifyInstance) => {
      await composeRoutes(instance);
      scope = instance;
    },
    { prefix: '/api' },
  );
  /**
   * Наблюдатель за ящиками. В настоящем приложении через него уходит
   * событие в открытую вкладку; здесь он просто запоминает отправленное,
   * чтобы проверка видела, сказали человеку или нет.
   */
  app.decorate('mailNotifier', {
    notify: (email: string, payload: unknown) => {
      if (options.noOpenTab) return false;
      wsEvents.push({ email, payload });
      return true;
    },
    // Наблюдение здесь не заводится — закрывать нечего.
    dropWatcher: () => false,
  });
  app.decorate('settingsService', {
    available: options.settingsAvailable ?? true,
    requireDb: () => ({
      getSettings: async () => {
        if (options.settingsBroken) throw new Error('база настроек недоступна');
        return { undoSendSeconds: options.undoSendSeconds ?? 0 };
      },
    }),
  } as unknown as FastifyInstance['settingsService']);

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

interface Ctx {
  app: FastifyInstance;
  /** Область видимости маршрутов написания — там объявлен работник очереди. */
  scope: FastifyInstance;
  smtp: FakeSmtp;
  client: FakeClient;
  uploads: FakeUploads;
  spoolDir: string;
  /** События, ушедшие в открытые вкладки этого ящика. */
  wsEvents: Array<{ email: string; payload: unknown }>;
}

async function withApp(options: AppOptions, run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mt-undo-'));
  const uploadDir = join(root, 'uploads');
  const spoolDir = join(dirname(uploadDir), 'deferred');
  const smtp = await startFakeSmtp({ rejectAll: options.smtpRejects ?? false });
  const client = new FakeClient();
  const uploads = new FakeUploads(uploadDir);
  const wsEvents: Array<{ email: string; payload: unknown }> = [];
  const { app, scope } = await buildTestApp(
    client,
    uploads,
    testConfig(smtp.port, uploadDir),
    options,
    wsEvents,
  );
  try {
    await run({ app, scope, smtp, client, uploads, spoolDir, wsEvents });
  } finally {
    await app.close();
    await smtp.close();
    await rm(root, { recursive: true, force: true });
  }
}

interface SendBody {
  ok: boolean;
  pendingId?: string;
  undoUntil?: string;
  sentMessageId: string | null;
}

async function send(app: FastifyInstance, extra: Record<string, unknown> = {}): Promise<SendBody> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages/send',
    payload: sendPayload(extra),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as SendBody;
}

async function undo(app: FastifyInstance, pendingId: string): Promise<{ cancelled: boolean }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages/send/undo',
    payload: { pendingId },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { cancelled: boolean };
}

/* ------------------------------------------------------------------ */
/* Письмо ждёт на сервере, а не в браузере                             */
/* ------------------------------------------------------------------ */

test('с включённой отменой письмо не уходит сразу, а ложится в очередь на диск', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, smtp, spoolDir }) => {
    const before = Date.now();
    const body = await send(app);

    assert.equal(body.ok, true);
    assert.equal(typeof body.pendingId, 'string');
    assert.equal(smtp.messages.length, 0, 'эти секунды письма у получателя быть не должно');
    assert.equal(body.sentMessageId, null, 'копии в «Отправленных» ещё нет');

    // Срок назван, и он тот, который выбрал человек
    const until = Date.parse(body.undoUntil ?? '');
    assert.ok(
      until >= before + 5000 && until <= before + 6000,
      `срок отмены: ${String(body.undoUntil)}`,
    );

    // Именно НА ДИСКЕ. Это и отличает нашу отмену от таймера в браузере:
    // вкладку закроют, процесс перезапустят — письмо всё равно уйдёт.
    // Читает его новый экземпляр очереди, ничего не помнящий.
    const queued = await new DeferredSpool(spoolDir).all();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.id, body.pendingId);
    assert.deepEqual(queued[0]?.envelopeTo, ['to@mail.local']);
    assert.notEqual(queued[0]?.passwordEnc, 'test12345', 'пароль не должен лежать открытым');
  });
});

test('письмо, которое никто не отменил, уходит само — без браузера и без вкладки', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, scope, smtp, client, spoolDir }) => {
    const body = await send(app);
    assert.equal(smtp.messages.length, 0);

    // Обратный ход: до обещанного срока работник письмо не трогает. Без
    // этой проверки «пять секунд на отмену» могли бы оказаться словом —
    // очередь отправила бы письмо первым же проходом, и отменять было бы
    // уже нечего.
    const until = Date.parse(body.undoUntil ?? '');
    assert.ok(until > 0, 'срок отмены обязан быть назван');
    assert.equal(await scope.deferredSender.tick(new Date(until - 1000)), 0);
    assert.equal(smtp.messages.length, 0, 'раньше срока письмо уходить не должно');

    // Здесь и происходит «человек закрыл вкладку»: со стороны сервера это
    // ровно ничего не значит — никто ему об этом не сообщает и сообщить
    // не может. Проход очереди зовётся руками, чтобы не ждать пять секунд.
    const sent = await scope.deferredSender.tick(new Date(Date.now() + 6000));

    assert.equal(sent, 1);
    assert.equal(smtp.messages.length, 1, 'письмо обязано уйти');
    assert.equal(client.sent.size, 1, 'и лечь копией в «Отправленные»');
    assert.deepEqual(await readdir(spoolDir), [], 'очередь за собой убирается');
  });
});

/* ------------------------------------------------------------------ */
/* Отмена не оставляет следов                                          */
/* ------------------------------------------------------------------ */

test('отмена снимает письмо с очереди: его нет ни у получателя, ни в «Отправленных»', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, scope, smtp, client, spoolDir }) => {
    const body = await send(app);
    const result = await undo(app, body.pendingId ?? '');

    assert.equal(result.cancelled, true);
    assert.deepEqual(await readdir(spoolDir), [], 'в очереди не должно остаться ни файла');

    // Обратный ход: время идёт дальше, работник просыпается — и отправлять
    // ему нечего. Без снятия с очереди письмо ушло бы именно здесь.
    const sent = await scope.deferredSender.tick(new Date(Date.now() + 60_000));
    assert.equal(sent, 0);
    assert.equal(smtp.messages.length, 0, 'отменённое письмо не уходит никому');
    assert.equal(client.sent.size, 0, 'и в «Отправленных» его нет');
    assert.equal(client.drafts.size, 0, 'и в черновиках «куда-то» тоже: письмо вернулось в окно');
  });
});

test('вложения отменённого письма остаются на месте — иначе оно вернулось бы пустым', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, uploads }) => {
    await uploads.put('вложение-1', 'договор.txt', 'содержимое файла');
    const body = await send(app, { attachmentIds: ['вложение-1'] });

    await undo(app, body.pendingId ?? '');
    assert.deepEqual(uploads.deleted, [], 'до отправки вложения трогать нельзя');
    assert.notEqual(await uploads.get('вложение-1'), null, 'файл обязан пережить отмену');
  });
});

test('вложения ушедшего письма убираются — держать их дальше незачем', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, scope, uploads, smtp }) => {
    await uploads.put('вложение-1', 'договор.txt', 'содержимое файла');
    await send(app, { attachmentIds: ['вложение-1'] });

    // Обратный ход к проверке выше: тот же путь, но письмо не отменяют
    await scope.deferredSender.tick(new Date(Date.now() + 60_000));
    assert.equal(smtp.messages.length, 1);
    assert.deepEqual(uploads.deleted, ['вложение-1']);
  });
});

/* ------------------------------------------------------------------ */
/* Опоздавшая отмена                                                    */
/* ------------------------------------------------------------------ */

test('отмена после срока отвечает честно: письмо уже ушло', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, scope, smtp, client }) => {
    const body = await send(app);
    await scope.deferredSender.tick(new Date(Date.now() + 60_000));
    assert.equal(smtp.messages.length, 1, 'письмо к этому моменту уже у получателя');

    const result = await undo(app, body.pendingId ?? '');

    // Ни молчания, ни ложного «отменено»: человек должен узнать правду,
    // иначе он будет уверен, что письма нет, а оно есть
    assert.equal(result.cancelled, false);
    assert.equal(smtp.messages.length, 1, 'и уж точно отмена не отзывает ушедшее');
    assert.equal(client.sent.size, 1, 'копия в «Отправленных» тоже на месте');
  });
});

test('пока письмо отдают SMTP, отмена получает отказ, а не стирает запись задним числом', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, scope, spoolDir }) => {
    const body = await send(app);
    const pendingId = body.pendingId ?? '';

    // Ровно та гонка, ради которой в очереди есть замок: работник взял
    // письмо в работу, а человек в эту же секунду жмёт «Отменить».
    assert.equal(scope.deferredSender.claim(pendingId), true);
    const result = await undo(app, pendingId);
    assert.equal(result.cancelled, false, 'занятое письмо отменить нельзя');

    // Запись при этом цела: без замка отмена стёрла бы её, и работник
    // отправил бы письмо, о котором человеку сказали «отменено»
    assert.notEqual(await new DeferredSpool(spoolDir).get(pendingId), null);

    // Обратный ход: работник отпустил письмо — отмена снова работает
    scope.deferredSender.release(pendingId);
    assert.equal((await undo(app, pendingId)).cancelled, true);
  });
});

test('несуществующее и чужое письмо отменяются одинаково — «уже ушло»', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, spoolDir }) => {
    assert.equal(
      (await undo(app, '11111111-1111-1111-1111-111111111111')).cancelled,
      false,
      'выдуманный идентификатор ничего не отменяет',
    );

    // Письмо соседа. Ответ тот же самый: сказать «это письмо не ваше»
    // значило бы подтвердить, что такое письмо есть.
    const spool = new DeferredSpool(spoolDir);
    const foreign = await spool.add(
      {
        owner: 'сосед@mail.local',
        passwordEnc: 'зашифровано',
        sendAt: new Date(Date.now() + 5000).toISOString(),
        envelopeTo: ['to@mail.local'],
        subject: 'Чужое письмо',
      },
      Buffer.from('тело'),
    );
    assert.equal((await undo(app, foreign.id)).cancelled, false);
    assert.notEqual(await spool.get(foreign.id), null, 'чужое письмо остаётся в очереди');
  });
});

/* ------------------------------------------------------------------ */
/* Выключенная отмена возвращает прежнее поведение                      */
/* ------------------------------------------------------------------ */

test('«выключено» в настройках — письмо уходит сразу, как и до появления отмены', async () => {
  await withApp({ undoSendSeconds: 0 }, async ({ app, smtp, client, spoolDir }) => {
    const body = await send(app);

    assert.equal(smtp.messages.length, 1, 'письмо уходит в том же запросе');
    assert.equal(client.sent.size, 1);
    assert.match(body.sentMessageId ?? '', /^sent:\d+$/);
    assert.equal(body.pendingId, undefined, 'отменять нечего — и обещать отмену нельзя');
    assert.deepEqual(await readdir(spoolDir).catch(() => []), [], 'очередь не заводится');
  });
});

test('без раздела настроек письмо тоже уходит сразу: чужую почту наугад не задерживают', async () => {
  await withApp({ settingsAvailable: false }, async ({ app, smtp }) => {
    const body = await send(app);
    assert.equal(smtp.messages.length, 1);
    assert.equal(body.pendingId, undefined);
  });
});

test('сломанная база настроек не задерживает письмо и не роняет отправку', async () => {
  await withApp({ settingsBroken: true }, async ({ app, smtp }) => {
    const body = await send(app);
    assert.equal(smtp.messages.length, 1);
    assert.equal(body.pendingId, undefined);
  });
});

test('назначенное «завтра в девять» отменой не подменяется', async () => {
  await withApp({ undoSendSeconds: 30 }, async ({ app, smtp, spoolDir }) => {
    const sendAt = new Date(Date.now() + 3600_000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: sendPayload({ sendAt }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { scheduled?: boolean; sendAt?: string; pendingId?: string };

    assert.equal(body.scheduled, true);
    assert.equal(body.sendAt, sendAt, 'срок отмены не должен обрезать отложенную отправку');
    assert.equal(body.pendingId, undefined);
    assert.equal(smtp.messages.length, 0);
    assert.equal((await new DeferredSpool(spoolDir).all())[0]?.sendAt, sendAt);
  });
});

/* ------------------------------------------------------------------ */
/* Письмо не ушло: молчать об этом нельзя                              */
/* ------------------------------------------------------------------ */

/*
 * Отправка с включённой отменой обменяла синхронный отказ на пять секунд
 * удобства: человек видит «Письмо отправлено», закрывает вкладку и уходит.
 * Если письмо после этого не уйдёт, узнать об этом ему больше неоткуда —
 * значит, узнать он обязан от нас.
 */
test('письмо, которое не приняли, ложится в черновики С ПРИЧИНОЙ', async () => {
  await withApp({ undoSendSeconds: 5, smtpRejects: true }, async ({ app, scope, client }) => {
    await send(app);
    // Постоянный отказ (550) работник распознаёт с первой же попытки
    // и повторять не пытается
    await scope.deferredSender.tick(new Date(Date.now() + 60_000));

    assert.equal(client.drafts.size, 1, 'написанное обязано остаться в черновиках');
    const raw = client.appended.find((a) => a.path === 'Drafts')?.raw;
    assert.ok(raw, 'черновик должен был лечь в «Черновики»');

    // Черновик несёт причину: человек его не создавал и должен понять,
    // откуда взялось письмо и что с ним не так
    const reason = readFailureFromRaw(raw);
    assert.ok(reason, 'черновик обязан нести причину, иначе он необъясним');
    assert.match(reason.reason, /\S/);
    assert.deepEqual(reason.envelopeTo, ['to@mail.local']);
    assert.equal(reason.rejected[0]?.address, 'to@mail.local');
    assert.match(reason.rejected[0]?.message ?? '', /User unknown/);
    assert.ok(Date.parse(reason.lastAttemptAt) > 0, 'время последней попытки обязано быть');
  });
});

test('черновик с причиной отдаёт её окну написания, обычный — не выдумывает', async () => {
  await withApp({ undoSendSeconds: 5, smtpRejects: true }, async ({ app, scope, client }) => {
    await send(app);
    await scope.deferredSender.tick(new Date(Date.now() + 60_000));
    const failedUid = [...client.drafts][0];
    assert.ok(failedUid);

    const res = await app.inject({ method: 'GET', url: `/api/drafts/${String(failedUid)}` });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { sendFailure: { reason: string } | null };
    assert.ok(body.sendFailure, 'причина обязана дойти до окна написания');
    assert.match(body.sendFailure.reason, /\S/);

    // Обратный ход: обычный сохранённый черновик никакой причины не несёт,
    // иначе полоса «письмо не отправлено» висела бы на всех письмах подряд
    const saved = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: sendPayload({ subject: 'Обычный черновик' }),
    });
    const uid = (saved.json() as { draftUid: number }).draftUid;
    const plain = await app.inject({ method: 'GET', url: `/api/drafts/${String(uid)}` });
    assert.equal((plain.json() as { sendFailure: unknown }).sendFailure, null);
  });
});

test('извещение об отказе записано на диск и дожидается человека', async () => {
  await withApp({ undoSendSeconds: 5, smtpRejects: true }, async ({ app, scope, spoolDir }) => {
    await send(app);
    await scope.deferredSender.tick(new Date(Date.now() + 60_000));

    // На постоянном томе, а не в памяти: человек мог закрыть вкладку
    // в первую же секунду, а сервер — успеть перезапуститься
    const afterRestart = await new DeferredSpool(spoolDir).failures('test@mail.local');
    assert.equal(afterRestart.length, 1);
    assert.equal(afterRestart[0]?.subject, 'Проверка');
    assert.equal(typeof afterRestart[0]?.draftUid, 'number');

    // И его видно маршрутом, которым почта спрашивает при каждом открытии
    const res = await app.inject({ method: 'GET', url: '/api/messages/send/failures' });
    assert.equal(res.statusCode, 200, res.body);
    const items = (res.json() as { items: Array<{ id: string; reason: string }> }).items;
    assert.equal(items.length, 1);
    assert.match(items[0]?.reason ?? '', /\S/);

    // «Понятно» убирает извещение — и только по нажатию человека
    const ack = await app.inject({
      method: 'POST',
      url: '/api/messages/send/failures/ack',
      payload: { id: items[0]?.id },
    });
    assert.equal((ack.json() as { removed: boolean }).removed, true);
    const after = await app.inject({ method: 'GET', url: '/api/messages/send/failures' });
    assert.deepEqual((after.json() as { items: unknown[] }).items, []);
  });
});

test('открытой вкладке говорят сразу, а не при следующем заходе в почту', async () => {
  await withApp({ undoSendSeconds: 5, smtpRejects: true }, async ({ app, scope, wsEvents }) => {
    await send(app);
    await scope.deferredSender.tick(new Date(Date.now() + 60_000));

    assert.equal(wsEvents.length, 1, 'событие обязано уйти в открытую вкладку');
    assert.equal(wsEvents[0]?.email, 'test@mail.local');
    const payload = wsEvents[0]?.payload as { type: string; subject: string; draftUid: number };
    assert.equal(payload.type, 'send-failed');
    assert.equal(payload.subject, 'Проверка');
    assert.equal(typeof payload.draftUid, 'number');
  });
});

test('закрытая вкладка ничего не ломает: извещение всё равно записано', async () => {
  // Ровно тот случай, ради которого извещение — запись, а не событие.
  // Сказать было некому, но узнать человек всё равно обязан.
  await withApp(
    { undoSendSeconds: 5, smtpRejects: true, noOpenTab: true },
    async ({ app, scope, wsEvents }) => {
      await send(app);
      await scope.deferredSender.tick(new Date(Date.now() + 60_000));

      assert.equal(wsEvents.length, 0, 'вкладок нет — событию некуда идти');
      const res = await app.inject({ method: 'GET', url: '/api/messages/send/failures' });
      assert.equal((res.json() as { items: unknown[] }).items.length, 1);
    },
  );
});

test('извещения соседа не видны и не убираются', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, spoolDir }) => {
    const spool = new DeferredSpool(spoolDir);
    const foreign = await spool.addFailure({
      owner: 'сосед@mail.local',
      subject: 'Чужая переписка',
      envelopeTo: ['кто-то@mail.local'],
      reason: 'Отказано',
      rejected: [],
      attempts: 5,
      lastAttemptAt: new Date().toISOString(),
      draftUid: 1,
    });

    const list = await app.inject({ method: 'GET', url: '/api/messages/send/failures' });
    assert.deepEqual((list.json() as { items: unknown[] }).items, []);

    const ack = await app.inject({
      method: 'POST',
      url: '/api/messages/send/failures/ack',
      payload: { id: foreign.id },
    });
    assert.equal((ack.json() as { removed: boolean }).removed, false);
    assert.equal((await spool.failures('сосед@mail.local')).length, 1);
  });
});

test('успешная отправка извещений не плодит', async () => {
  await withApp({ undoSendSeconds: 5 }, async ({ app, scope, wsEvents }) => {
    await send(app);
    await scope.deferredSender.tick(new Date(Date.now() + 60_000));

    const res = await app.inject({ method: 'GET', url: '/api/messages/send/failures' });
    assert.deepEqual((res.json() as { items: unknown[] }).items, []);
    assert.deepEqual(wsEvents, []);
  });
});

/* ------------------------------------------------------------------ */
/* Письмо не должно исчезать, если его некуда убрать                   */
/* ------------------------------------------------------------------ */

/*
 * Самый дорогой случай во всей очереди: письмо не ушло И не легло в
 * «Черновики». Раньше отказ укладки гасился внутри обработчика, работник
 * очереди считал дело сделанным и стирал с диска конверт, тело письма и
 * удерживаемые вложения. Человек получал извещение «письмо не отправлено»
 * без кнопки «открыть»: знал, что письма нет, а восстановить было нечего.
 *
 * Причины отказа APPEND житейские: сменился пароль ящика, кончилось место
 * по квоте, отвалился IMAP.
 */
test('письмо остаётся в очереди, если убрать его в черновики не удалось', async () => {
  await withApp(
    { undoSendSeconds: 5, smtpRejects: true },
    async ({ app, scope, client, spoolDir }) => {
      const body = await send(app);
      client.appendFails = true;

      await scope.deferredSender.tick(new Date(Date.now() + 60_000));

      const spool = new DeferredSpool(spoolDir);
      const left = await spool.all();
      assert.equal(left.length, 1, 'письмо стёрто, хотя убрать его в черновики не удалось');
      assert.ok(await spool.raw(left[0]!.id), 'тело письма обязано остаться на диске');

      // Сказать при этом обязаны: человек уже ушёл, и больше узнать неоткуда.
      const failures = await spool.failures('test@mail.local');
      assert.equal(failures.length, 1, 'извещение не выписано');
      assert.equal(failures[0]?.draftUid, null, 'черновика нет — обещать его нельзя');

      // Повторный обход не плодит извещений: конверт лежит и ждёт починки,
      // а «письмо не отправлено» раз в полминуты — это шум, а не забота.
      await scope.deferredSender.tick(new Date(Date.now() + 120_000));
      assert.equal((await spool.failures('test@mail.local')).length, 1);

      // Ящик починили — письмо уезжает в черновики, и очередь пустеет.
      client.appendFails = false;
      await scope.deferredSender.tick(new Date(Date.now() + 180_000));
      assert.equal((await spool.all()).length, 0, 'после починки конверт обязан уйти');
      assert.equal(client.drafts.size, 1, 'письмо должно было лечь в «Черновики»');
      assert.ok(body.pendingId, 'у отправки с отменой обязан быть идентификатор');
    },
  );
});

test('письмо, чей пароль больше не расшифровывается, не пропадает молча', async () => {
  /*
   * СМЕНА SESSION_SECRET — И ЧЕЛОВЕК НЕ УЗНАЁТ НИЧЕГО.
   *
   * Пароль ящика лежит в конверте зашифрованным. После смены секрета
   * сессий (плановая ротация, перенос установки, восстановление тома)
   * расшифровка бросает. Обработчик «письмо не ушло и не уйдёт»
   * начинался ИМЕННО С НЕЁ, и начинался вне try: исключение улетало
   * до того, как человеку выпишут извещение.
   *
   * Работник очереди понимал исключение правильно — письмо оставалось
   * в очереди, чтобы не пропасть. Но человек не получал ни черновика,
   * ни записи, ни строки в почте: письмо молча крутилось в очереди, а он
   * ждал ответа от адресата.
   */
  await withApp({ undoSendSeconds: 5 }, async ({ scope, spoolDir, wsEvents }) => {
    const spool = new DeferredSpool(spoolDir);
    const entry = await spool.add(
      {
        owner: 'test@mail.local',
        // Ровно то, что остаётся от конверта после смены секрета сессий
        passwordEnc: 'этим-ключом-больше-ничего-не-открыть',
        sendAt: new Date(Date.now() - 1000).toISOString(),
        envelopeTo: ['to@mail.local'],
        subject: 'Письмо после ротации секрета',
      },
      Buffer.from('текст, который нельзя терять'),
    );

    // Пароль не открывается и при отправке, поэтому попытки идут одна за
    // другой — с откатом между ними, как и положено (см. retryDelayMs)
    let when = Date.now();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await scope.deferredSender.tick(new Date(when));
      when += retryDelayMs(attempt) + 1000;
    }

    // Черновика нет — черновик без пароля не положить. Но извещение
    // пароля не требует, и оно обязано быть.
    const failures = await spool.failures('test@mail.local');
    assert.equal(failures.length, 1, 'человеку не сказали вообще ничего');
    assert.equal(failures[0]?.subject, 'Письмо после ротации секрета');
    assert.equal(failures[0]?.draftUid, null, 'черновика нет — обещать его нельзя');
    assert.equal(wsEvents.length, 1, 'открытой вкладке тоже говорят');

    // И само письмо цело: чинить нечего, если оно исчезло
    const left = await spool.all();
    assert.equal(left.length, 1);
    assert.equal(left[0]?.id, entry.id);
    assert.equal(
      (await spool.raw(entry.id))?.toString('utf8'),
      'текст, который нельзя терять',
      'тело письма обязано остаться нетронутым',
    );
  });
});

/*
 * Скрытая копия в собранных байтах отсутствует намеренно: адресаты Bcc
 * живут в конверте SMTP и не должны попасть на глаза остальным. Но те же
 * байты уезжают в «Черновики» при неудаче — и человек, дописав спасённое
 * письмо, отправлял его уже БЕЗ скрытых получателей. Ни он, ни они об
 * этом не узнавали.
 */
test('спасённый черновик сохраняет скрытых получателей', async () => {
  await withApp({ undoSendSeconds: 5, smtpRejects: true }, async ({ app, scope, client }) => {
    await send(app, { bcc: [{ name: null, address: 'tihiy@mail.local' }] });
    await scope.deferredSender.tick(new Date(Date.now() + 60_000));

    const raw = client.appended.find((a) => a.path === 'Drafts')?.raw;
    assert.ok(raw, 'черновик должен был лечь в «Черновики»');
    const text = raw.toString('utf8');
    assert.match(text, /^Bcc: tihiy@mail\.local$/m, 'скрытая копия потерялась в черновике');

    // А в том, что уходило почтовому серверу, заголовка Bcc быть не должно:
    // это была бы выдача скрытых адресатов остальным получателям.
    const sentToSmtp = client.appended.find((a) => a.path === 'Sent');
    assert.equal(sentToSmtp, undefined, 'отвергнутое письмо не кладут в «Отправленные»');
  });
});
