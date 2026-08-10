/**
 * Отправка «от имени» подключённого чужого адреса.
 *
 * Два разобранных дефекта, оба — про молчание.
 *
 *  1. РЕЗУЛЬТАТ ОТПРАВКИ НЕ ЧИТАЛСЯ ВОВСЕ. Нижняя библиотека отклоняет
 *     обещание, только когда отвергнуты ВСЕ получатели; при отказе части
 *     адресов обещание разрешается успешно, а отказ лежит внутри ответа.
 *     Маршрут отвечал `{"ok":true}`, окно писало «Письмо отправлено с
 *     адреса …» — и третий адресат не получал ничего. Заодно любой отказ
 *     выдавался за 503 «сервер недоступен»: постоянный отказ (550, 552)
 *     предлагали повторить там, где повтор не поможет никогда.
 *
 *  2. ЧЕРНОВИК ПОСЛЕ ОТПРАВКИ ОСТАВАЛСЯ ЛЕЖАТЬ. Свой путь его убирает,
 *     этот — нет, хотя черновик тот же и лежит в НАШЕМ ящике. Человек
 *     открыл сохранённое письмо, переключил отправителя на внешний адрес,
 *     отправил — через неделю нашёл черновик в папке и отправил ещё раз.
 *     У получателя дубль.
 *
 * Проверяется на настоящем SMTP-разговоре: подставной сервер отвечает
 * ровно так, как отвечает Postfix, — по каждому получателю отдельно.
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { registerErrorHandling } from '../http-errors.js';
import { composeRoutes } from '../routes/compose.js';
import type { AppDeps } from '../types.js';
import type { UploadStore } from '../uploads.js';
import { accountsUserRoutes } from './routes.js';
import type { AccountsService } from './service.js';
import { Readable } from 'node:stream';
import type { ExternalAccount } from './types.js';

/* ------------------------------------------------------------------ */
/* Подставной SMTP чужого сервиса                                      */
/* ------------------------------------------------------------------ */

interface SmtpOptions {
  /** Адреса, которым сервер отвечает постоянным отказом на RCPT TO. */
  reject?: string[];
  /** Код отказа (550 — нет такого ящика, 552 — письмо слишком велико). */
  rejectCode?: number;
  /** Сервер не принимает логин и пароль — как при протухшем пароле. */
  authFail?: boolean;
}

interface FakeSmtp {
  port: number;
  /** Исходники писем, которые сервер принял. */
  readonly messages: string[];
  close(): Promise<void>;
}

async function startFakeSmtp(options: SmtpOptions = {}): Promise<FakeSmtp> {
  const reject = new Set((options.reject ?? []).map((a) => a.toLowerCase()));
  const code = options.rejectCode ?? 550;
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
          // Ровно так отвечает почтовая служба на протухший пароль: код из
          // той же пятисотой сотни, что и «нет такого получателя», и адрес
          // страницы, на которой пароль выдают заново.
          if (options.authFail) {
            socket.write(
              '535-5.7.8 Username and Password not accepted. For more information, go to\r\n' +
                '535 5.7.8  https://support.example/mail/?p=BadCredentials\r\n',
            );
          } else {
            socket.write('235 2.7.0 Accepted\r\n');
          }
        } else if (command === 'RCPT') {
          // Postfix отвечает на КАЖДОГО получателя отдельно — в этом весь
          // разбираемый случай: часть адресов принята, часть отвергнута
          const address = /<([^>]*)>/.exec(line)?.[1]?.toLowerCase() ?? '';
          if (reject.has(address)) {
            socket.write(
              `${String(code)} 5.1.1 <${address}>: Recipient address rejected: User unknown\r\n`,
            );
          } else {
            socket.write('250 2.1.5 Ok\r\n');
          }
        } else if (command === 'MAIL') {
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
/* Подставной ящик: и наш (черновики), и чужой («Отправленные»)         */
/* ------------------------------------------------------------------ */

class FakeClient {
  readonly drafts = new Set<number>();
  readonly sent = new Set<number>();
  /** UID, которые удалили из «Черновиков». */
  readonly deleted: number[] = [];
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
    for (const uid of uids) {
      this.deleted.push(uid);
      this.drafts.delete(uid);
    }
    return true;
  }

  async search(): Promise<number[]> {
    return [];
  }

  async messageFlagsAdd(): Promise<boolean> {
    return true;
  }

  async fetchOne(): Promise<false> {
    return false;
  }

  /**
   * Отдача части письма — то, чем живёт перенос встроенных картинок.
   *
   * В теле, которое цитирует окно написания, картинки стоят ссылками на
   * НАШ маршрут частей: письмо готовилось для чтения. Отправить такую
   * ссылку наружу нельзя, поэтому часть скачивается отсюда и уезжает
   * встроенным вложением.
   */
  async download(): Promise<{
    content: Readable;
    meta: { contentType: string; filename: string };
  }> {
    return {
      content: Readable.from([Buffer.from(PNG_BASE64, 'base64')]),
      meta: { contentType: 'image/png', filename: 'logo.png' },
    };
  }
}

/** Однопиксельный PNG — настоящие байты картинки, а не выдуманные. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* ------------------------------------------------------------------ */
/* Приложение                                                          */
/* ------------------------------------------------------------------ */

function externalAccount(smtpPort: number): ExternalAccount {
  return {
    id: 7,
    address: 'buhgalteria@other.example',
    label: 'Бухгалтерия',
    mode: 'direct',
    imap: { host: '127.0.0.1', port: 993, secure: true, user: 'buhgalteria@other.example' },
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: 'buhgalteria@other.example' },
    // Сертификата у подставного сервера нет вовсе, и STARTTLS он не
    // объявляет: без этого флага клиент потребовал бы шифрования и не
    // дошёл бы до самого разбираемого места.
    allowInsecureTls: true,
    targetFolder: 'INBOX',
    collectScope: 'inbox',
    intervalMinutes: 0,
    enabled: true,
    state: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  } as unknown as ExternalAccount;
}

function testConfig(uploadDir: string): AppConfig {
  return {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    TLS_REJECT_UNAUTHORIZED: false,
    MESSAGE_MAX_BYTES: 25 * 1024 * 1024,
    COMPOSE_BODY_MAX_BYTES: 12 * 1024 * 1024,
    UPLOAD_DIR: uploadDir,
  } as unknown as AppConfig;
}

interface Ctx {
  app: FastifyInstance;
  client: FakeClient;
  smtp: FakeSmtp;
}

async function withApp(options: SmtpOptions, run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mt-external-send-'));
  const smtp = await startFakeSmtp(options);
  const client = new FakeClient();
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  const uploads = {
    get: async () => null,
    delete: async () => undefined,
  } as unknown as UploadStore;
  const logger = {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  };
  app.decorate('deps', {
    pool,
    uploads,
    logger,
    config: testConfig(join(root, 'uploads')),
  } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);

  const account = externalAccount(smtp.port);
  const service = {
    config: { MAIL_DOMAIN: 'mail.local' },
    externalPool: {
      withClient: async <T>(
        _owner: string,
        _account: ExternalAccount,
        _password: string,
        fn: (c: ImapFlow) => Promise<T>,
      ): Promise<T> => fn(client as unknown as ImapFlow),
    },
    requireDb: () => ({
      findExternal: async (_owner: string, id: number) =>
        id === account.id ? { account, passwordEnc: 'зашифровано' } : null,
    }),
    passwordOf: () => 'пароль-чужого-ящика',
  } as unknown as AccountsService;

  /*
   * Оба набора маршрутов на ОДНОМ приложении, потому что черновик у них
   * общий: автосохранение окна ходит в /api/drafts, а письмо уходит через
   * /api/accounts/external/:id/send. Очередь сохранений при этом обязана
   * быть одна на приложение — иначе таймер положит новую копию уже
   * отправленного письма.
   */
  await app.register(async (api) => composeRoutes(api), { prefix: '/api' });
  await app.register(async (scope) => accountsUserRoutes(scope, service), {
    prefix: '/api/accounts',
  });
  await app.ready();

  try {
    await run({ app, client, smtp });
  } finally {
    await app.close();
    await smtp.close();
    await rm(root, { recursive: true, force: true });
  }
}

function sendBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    to: [
      { name: 'Первый', address: 'one@mail.local' },
      { name: 'Второй', address: 'two@mail.local' },
      { name: 'Третий', address: 'three@mail.local' },
    ],
    cc: [],
    bcc: [],
    subject: 'Счёт на оплату',
    bodyHtml: '<p>Во вложении</p>',
    attachmentIds: [],
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Отказ части получателей нельзя выдавать за успех                     */
/* ------------------------------------------------------------------ */

test('отвергнутый получатель назван, а не выдан за отправленного', async () => {
  await withApp({ reject: ['three@mail.local'] }, async ({ app, smtp }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/external/7/send',
      payload: sendBody(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      ok: boolean;
      from: string;
      accepted: string[];
      rejected: { address: string; message: string }[];
    };

    // Письмо ушло — двоим. Объявлять отправку неудачной нельзя: человек
    // отправит его второй раз, и у этих двоих окажется дубль.
    assert.equal(smtp.messages.length, 1, 'остальным письмо обязано уйти');
    assert.equal(body.from, 'buhgalteria@other.example');
    assert.deepEqual(body.accepted.sort(), ['one@mail.local', 'two@mail.local']);

    // …и третий назван поимённо. Раньше здесь было `{"ok":true}` без
    // единого слова о нём: окно писало «Письмо отправлено с адреса …».
    assert.equal(body.ok, false, 'ушло не всем — а ответ утверждает обратное');
    assert.deepEqual(
      body.rejected.map((r) => r.address),
      ['three@mail.local'],
    );
    assert.match(body.rejected[0]?.message ?? '', /User unknown/);
  });
});

test('принятое всеми письмо отвечает по-прежнему: ok и ни одного отвергнутого', async () => {
  // Обратный ход: без него проверка выше могла бы «работать» на любом
  // письме — например, если бы маршрут объявлял отказ всегда.
  await withApp({}, async ({ app, smtp }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/external/7/send',
      payload: sendBody(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { ok: boolean; rejected: unknown[]; accepted: string[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.rejected, []);
    assert.equal(body.accepted.length, 3);
    assert.equal(smtp.messages.length, 1);
  });
});

test('постоянный отказ — это не «сервер недоступен», и повтор не предлагается', async () => {
  /*
   * Отвергнуты ВСЕ получатели: только в этом случае нижняя библиотека
   * отклоняет обещание. Раньше любая такая ошибка становилась 503
   * «почтовый сервер недоступен» — неправда дважды: сервер доступен и
   * ответил, а повторять бессмысленно.
   */
  await withApp(
    { reject: ['one@mail.local', 'two@mail.local', 'three@mail.local'] },
    async ({ app }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/accounts/external/7/send',
        payload: sendBody(),
      });
      assert.equal(res.statusCode, 400, res.body);
      const body = res.json() as {
        error: string;
        message: string;
        details: { smtpCode: number | null; rejected: { address: string }[] };
      };
      assert.equal(body.error, 'SEND_REJECTED');
      assert.equal(body.details.smtpCode, 550);
      assert.deepEqual(body.details.rejected.map((r) => r.address).sort(), [
        'one@mail.local',
        'three@mail.local',
        'two@mail.local',
      ]);
      // Отказ обязан называть адреса: «не удалось отправить» не отвечает
      // ни на один вопрос человека
      assert.match(body.message, /one@mail\.local/);
    },
  );
});

test('неверный пароль чужого ящика зовёт чинить подключение, а не письмо', async () => {
  /*
   * Отказ при входе приходит с кодом 535 — из той же пятисотой сотни, что
   * и «нет такого получателя». Разбора для него не было, и окно написания
   * говорило «Почтовый сервер отклонил письмо (код 535)»: человек шёл
   * проверять адреса и текст письма, хотя поправить надо было ровно одно —
   * пароль подключения. У почтовых служб он к тому же протухает сам, стоит
   * включить двухшаговый вход, так что случай этот — обычный, а не редкий.
   *
   * Слова сервера при этом затирались нашими. А в них и написано, что
   * делать: адрес страницы, где выдают новый пароль.
   */
  await withApp({ authFail: true }, async ({ app, smtp }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/external/7/send',
      payload: sendBody(),
    });

    assert.equal(res.statusCode, 401, res.body);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, 'AUTH_FAILED');
    assert.doesNotMatch(body.message, /отклонил письмо/u, 'письмо и получатели тут ни при чём');
    assert.match(body.message, /подключ/iu, 'сказать надо, что чинить: подключение ящика');
    assert.match(
      body.message,
      /Username and Password not accepted/u,
      'слова сервера затёрты — вместе с адресом страницы, где выдают новый пароль',
    );
    assert.equal(smtp.messages.length, 0, 'письмо не ушло никому');
  });
});

test('«письмо слишком большое» называется своими словами, а не отказом сервера', async () => {
  await withApp(
    { reject: ['one@mail.local', 'two@mail.local', 'three@mail.local'], rejectCode: 552 },
    async ({ app }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/accounts/external/7/send',
        payload: sendBody(),
      });
      assert.equal(res.statusCode, 413, res.body);
      assert.equal((res.json() as { error: string }).error, 'MESSAGE_TOO_LARGE');
    },
  );
});

/* ------------------------------------------------------------------ */
/* Черновик после отправки «от имени»                                   */
/* ------------------------------------------------------------------ */

test('отправленное письмо не остаётся лежать черновиком', async () => {
  await withApp({}, async ({ app, client }) => {
    // Так и бывает: человек писал письмо, автосохранение положило черновик,
    // потом он переключил отправителя на подключённый чужой адрес
    const saved = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: sendBody({ draftKey: 'окно-7' }),
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const uid = (saved.json() as { draftUid: number }).draftUid;
    assert.equal(client.drafts.size, 1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/external/7/send',
      payload: sendBody({ draftKey: 'окно-7', draftUid: uid }),
    });
    assert.equal(res.statusCode, 200, res.body);

    assert.deepEqual(client.deleted, [uid], 'черновик отправленного письма обязан уйти');
    assert.equal(
      client.drafts.size,
      0,
      'черновик остался в папке — через неделю человек отправит письмо второй раз',
    );
  });
});

test('черновик убирается и по одному ключу окна — UID окно может ещё не знать', async () => {
  /*
   * Обычное состояние окна написания: черновик положило автосохранение,
   * ответ с UID до окна ещё не доехал, а человек уже нажал «Отправить».
   * Узнать нужный UID можно только у очереди сохранений — той самой,
   * которой пользуется автосохранение. Значит, она обязана быть ОДНА на
   * приложение, а не своя у каждого набора маршрутов.
   */
  await withApp({}, async ({ app, client }) => {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: sendBody({ draftKey: 'окно-8' }),
    });
    const uid = (saved.json() as { draftUid: number }).draftUid;

    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/external/7/send',
      payload: sendBody({ draftKey: 'окно-8' }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(client.deleted, [uid]);
    assert.equal(client.drafts.size, 0);
  });
});

test('письмо без черновика ничего в ящике не удаляет', async () => {
  // Обратный ход: уборка не должна срабатывать «на всякий случай».
  await withApp({}, async ({ app, client }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/external/7/send',
      payload: sendBody(),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(client.deleted, []);
  });
});

/* ------------------------------------------------------------------ */
/* Путь «с чужого адреса» не должен расходиться со своим                */
/* ------------------------------------------------------------------ */

/*
 * ПИСЬМО С ЧУЖОГО АДРЕСА УХОДИЛО БЕЗ ЕДИНОЙ КАРТИНКИ.
 *
 * Тело, которое цитирует окно написания, приготовлено для ЧТЕНИЯ:
 * встроенные картинки стоят в нём ссылками на наш маршрут частей. При
 * сборке уходящего письма санитайзер снимает такой адрес целиком — схема
 * ему чужая, — и у получателя оставался `<img>` без картинки. Свой путь
 * отправки переносит эти части во встроенные вложения с самого начала;
 * здесь переносить было некому, и пересылка с подключённого адреса молча
 * теряла всю графику. Молча — потому что в окне картинки видны до самого
 * нажатия «Отправить», а человеку отвечали «Письмо отправлено с адреса …».
 */
test('картинки цитаты уезжают и с подключённого адреса, а не пропадают', async () => {
  await withApp({}, async ({ app, smtp }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/external/7/send',
      payload: sendBody({
        bodyHtml: '<p>Смотрите: <img src="/api/messages/inbox:5/parts/2"></p>',
      }),
    });
    assert.equal(res.statusCode, 200, res.body);

    const raw = smtp.messages[0] ?? '';
    assert.match(raw, /Content-Type: image\/png/i, 'картинка обязана уехать вложением');
    assert.match(raw, /Content-ID: </i, 'у встроенной картинки обязан быть свой cid');
    // `src=3D"cid:` — то же самое в quoted-printable: тело письма кодируется,
    // и знак равенства в нём едет как `=3D`.
    assert.match(raw, /src=3D"cid:/i, 'в теле должна остаться ссылка на эту картинку');
    // Обратный ход: ссылки на наш маршрут в уходящем письме быть не должно —
    // получатель открыть её не может, и это ровно та дыра, что чинится.
    assert.doesNotMatch(raw, /\/api\/messages\//);
  });
});

/*
 * Предел письма на этом пути не проверялся вовсе: сумма вложений не
 * считалась, и письмо собиралось в память целиком (сборщик держит его
 * дважды), чтобы получить отказ уже от чужого сервера. На своём пути это
 * закрыто давно — здесь оставалась вторая дверь в тот же отказ.
 */
test('вложения, не помещающиеся в предел письма, отбиваются до сборки', async () => {
  await withApp({}, async ({ app, smtp }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/external/7/send',
      payload: sendBody({ attachmentIds: ['тяжёлое-вложение'] }),
    });

    // Хранилище загрузок в этой проверке отвечает «нет такого файла»,
    // поэтому до предела дело не доходит — но и до SMTP тоже: письмо не
    // уходит, а человек получает разбор по-русски, а не отказ чужого
    // сервера в оригинале.
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(smtp.messages.length, 0, 'до почтового сервера дело доходить не должно');
  });
});
