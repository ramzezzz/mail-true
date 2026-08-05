/**
 * Проверки маршрутов написания письма на подставном IMAP-клиенте.
 * SMTP здесь не задействован: проверяются пределы размеров и сохранность
 * текста письма — то, что раньше приводило к потере написанного.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import type { AppConfig } from '../config.js';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import type { UploadStore } from '../uploads.js';
import { composeRoutes } from './compose.js';

/** Подставной ящик с папкой черновиков. */
class FakeClient {
  readonly drafts = new Set<number>();
  private nextUid = 100;

  async list(): Promise<unknown[]> {
    return [
      {
        path: 'INBOX',
        name: 'INBOX',
        delimiter: '/',
        parentPath: '',
        specialUse: '\\Inbox',
        flags: new Set<string>(),
        status: { messages: 0, unseen: 0, uidValidity: 1n },
      },
      {
        path: 'Drafts',
        name: 'Drafts',
        delimiter: '/',
        parentPath: '',
        specialUse: '\\Drafts',
        flags: new Set<string>(),
        status: { messages: this.drafts.size, unseen: 0, uidValidity: 1n },
      },
    ];
  }

  async append(): Promise<{ uid: number }> {
    const uid = this.nextUid++;
    this.drafts.add(uid);
    return { uid };
  }

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
}

const GLOBAL_BODY_LIMIT = 2 * 1024 * 1024;

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
  // Общий предел тела запроса — как в бою (2 МБ). Маршруты написания
  // должны поднимать его для себя сами.
  const app = Fastify({ logger: false, bodyLimit: GLOBAL_BODY_LIMIT }) as unknown as FastifyInstance;
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

function draftPayload(bodyHtml: string): Record<string, unknown> {
  return {
    to: [{ name: 'Получатель', address: 'to@mail.local' }],
    cc: [],
    bcc: [],
    subject: 'Проверка',
    bodyHtml,
    attachmentIds: [],
  };
}

/**
 * Главный случай. `bodyHtml` по схеме разрешён до 10 МБ, а общий предел тела
 * запроса был 2 МБ: письмо со вставленными картинками упиралось в невидимый
 * потолок и получало английскую ошибку не из контракта.
 */
test('письмо с картинками больше общего предела тела запроса принимается', async () => {
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig());
  try {
    const big = 'и'.repeat(3 * 1024 * 1024); // заведомо больше 2 МБ
    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: draftPayload(`<p>${big}</p>`),
    });
    assert.equal(res.statusCode, 200, `тело ответа: ${res.body.slice(0, 200)}`);
    assert.equal(res.json().ok, true);
    assert.equal(client.drafts.size, 1);
  } finally {
    await app.close();
  }
});

test('тело сверх предела маршрута отклоняется кодом из контракта', async () => {
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig({ COMPOSE_BODY_MAX_BYTES: 64 * 1024 }));
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: draftPayload('я'.repeat(200 * 1024)),
    });
    assert.equal(res.statusCode, 413);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, 'PAYLOAD_TOO_LARGE');
    assert.match(body.message, /[а-яё]/i);
    assert.equal(body.message.includes('FST_'), false);
  } finally {
    await app.close();
  }
});

/**
 * Раньше слишком большое письмо узнавало о своём размере только от SMTP,
 * отказ выдавался как «почтовый сервер недоступен», а текст письма пропадал.
 */
test('слишком большое письмо отклоняется до отправки и сохраняется в черновиках', async () => {
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig({ MESSAGE_MAX_BYTES: 4096 }));
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      payload: draftPayload('ю'.repeat(20 * 1024)),
    });
    assert.equal(res.statusCode, 413);
    const body = res.json() as {
      error: string;
      message: string;
      details: { draftUid: number | null; draftId: string | null };
    };
    assert.equal(body.error, 'MESSAGE_TOO_LARGE');
    assert.match(body.message, /черновик/i);
    assert.equal(typeof body.details.draftUid, 'number');
    assert.equal(client.drafts.size, 1, 'текст письма должен быть сохранён');
    assert.equal(client.drafts.has(body.details.draftUid as number), true);
  } finally {
    await app.close();
  }
});

test('черновик заменяет предыдущую версию, а не добавляется к ней', async () => {
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig());
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: draftPayload('первая версия'),
    });
    const uid = first.json().draftUid as number;
    const second = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: { ...draftPayload('вторая версия'), draftUid: uid },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(client.drafts.size, 1);
    assert.equal(client.drafts.has(second.json().draftUid as number), true);
  } finally {
    await app.close();
  }
});

/**
 * Пять одновременных сохранений одного черновика создавали пять писем.
 */
test('пять одновременных сохранений черновика оставляют один черновик', async () => {
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig());
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: draftPayload('черновик'),
    });
    const uid = first.json().draftUid as number;

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/drafts',
          payload: { ...draftPayload(`версия ${i}`), draftUid: uid },
        })
      )
    );

    assert.equal(client.drafts.size, 1, `осталось черновиков: ${client.drafts.size}`);
  } finally {
    await app.close();
  }
});

test('автосохранение нового письма с ключом окна не плодит черновики', async () => {
  const client = new FakeClient();
  const app = await buildTestApp(client, testConfig());
  try {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/drafts',
          payload: { ...draftPayload(`версия ${i}`), draftKey: 'окно-1' },
        })
      )
    );
    assert.equal(client.drafts.size, 1);
  } finally {
    await app.close();
  }
});
