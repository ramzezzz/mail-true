/**
 * Отказ по размеру вложения обязан называть предел.
 *
 * Поймано на живом стенде: файл на 20 МБ уезжал по сети целиком, а в ответ
 * приходило «Файл слишком большой» — без единой цифры. Человек не знает, до
 * чего ужимать: до десяти мегабайт? до восемнадцати? — и пробует заново,
 * снова гоняя те же мегабайты. При нескольких вложениях сразу непонятно ещё
 * и то, какое именно не пролезло.
 *
 * Предел здесь не круглое число: вложение при кодировании растёт (см.
 * ENCODING_OVERHEAD), поэтому «25 МБ письмо» означает «17,8 МБ файл»,
 * и угадать его человеку неоткуда.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { registerErrorHandling } from '../http-errors.js';
import { uploadRoutes } from './uploads.js';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../types.js';
import type { UploadStore } from '../uploads.js';

const ATTACHMENT_LIMIT = 18_724_571; // ровно то, что даёт 25 МБ / 1.4

const MAILBOX_LIMIT = 250 * 1024 * 1024;

async function buildApp(store?: Partial<UploadStore>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const config = {
    ATTACHMENT_MAX_BYTES: ATTACHMENT_LIMIT,
    MESSAGE_MAX_BYTES: 25 * 1024 * 1024,
    UPLOAD_MAILBOX_MAX_BYTES: MAILBOX_LIMIT,
  } as unknown as AppConfig;
  const uploads = {
    usedBy: async () => 0,
    save: async () => {
      throw Object.assign(new Error('request file too large'), {
        code: 'FST_REQ_FILE_TOO_LARGE',
      });
    },
    delete: async () => undefined,
    ...store,
  } as unknown as UploadStore;
  app.decorate('deps', { uploads, config } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'x' };
  });
  registerErrorHandling(app);
  await app.register(multipart, { limits: { fileSize: ATTACHMENT_LIMIT, files: 20 } });
  await app.register(uploadRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

/** Тело multipart с одним файлом — руками, чтобы не тянуть лишнюю зависимость. */
function multipartBody(filename: string, size: number): { body: Buffer; contentType: string } {
  const boundary = '----MailTrueProba';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, Buffer.alloc(size), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test('отказ по размеру называет предел и файл, на котором сорвалось', async () => {
  const app = await buildApp();
  try {
    const { body, contentType } = multipartBody('otchet.pdf', 4096);
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { 'content-type': contentType },
      payload: body,
    });
    assert.equal(res.statusCode, 413);
    const answer = res.json() as { error: string; message: string };
    assert.equal(answer.error, 'FILE_TOO_LARGE');
    assert.match(answer.message, /otchet\.pdf/, 'не названо, какое вложение не пролезло');
    assert.match(answer.message, /предел одного вложения — 17,8 МБ/, 'не назван предел вложения');
    assert.match(answer.message, /25,0 МБ/, 'не назван предел письма целиком');
  } finally {
    await app.close();
  }
});

test('предел сообщается клиенту заранее, вместе с сессией', async () => {
  // Иначе интерфейс узнаёт о слишком большом вложении только после того,
  // как файл уже уехал по сети целиком.
  const { authRoutes } = await import('./auth.js');
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const config = {
    ATTACHMENT_MAX_BYTES: ATTACHMENT_LIMIT,
    MESSAGE_MAX_BYTES: 25 * 1024 * 1024,
    SESSION_COOKIE_NAME: 'mt_session',
    SESSION_TTL_SECONDS: 3600,
    COOKIE_SECURE: false,
  } as unknown as AppConfig;
  app.decorate('deps', {
    config,
    sessions: {},
    secretBox: {},
    pool: {},
  } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'x' };
  });
  registerErrorHandling(app);
  await app.register(authRoutes, { prefix: '/api' });
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/auth/session' });
    assert.equal(res.statusCode, 200);
    const answer = res.json() as { limits?: { attachmentBytes: number; messageBytes: number } };
    assert.equal(answer.limits?.attachmentBytes, ATTACHMENT_LIMIT);
    assert.equal(answer.limits?.messageBytes, 25 * 1024 * 1024);
  } finally {
    await app.close();
  }
});

test('названный предел округляется ВНИЗ — обещание должно сдерживаться', async () => {
  // 18 724 571 байт — это 17,856 МБ. Округлённое по правилам «17,9 МБ» —
  // обещание, которого мы не сдержим: ужатый ровно до него файл получит
  // тот же отказ второй раз.
  const app = await buildApp();
  try {
    const { body, contentType } = multipartBody('doklad.pdf', 4096);
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { 'content-type': contentType },
      payload: body,
    });
    const message = (res.json() as { message: string }).message;
    const named = /предел одного вложения — (\d+),(\d) МБ/.exec(message);
    assert.ok(named, `предел не найден в тексте: ${message}`);
    const namedBytes = (Number(named[1]) + Number(named[2]) / 10) * 1024 * 1024;
    assert.ok(
      namedBytes <= ATTACHMENT_LIMIT,
      `названо ${named[0]}, а предел ${String(ATTACHMENT_LIMIT)} байт — файл такого размера не пройдёт`,
    );
  } finally {
    await app.close();
  }
});

/*
 * Предел на файл был, а на ящик — нет: один вошедший заливал вложения
 * подряд, ничего не отправляя. Том общий — на нём же очередь отложенной
 * отправки и выгрузки ящиков, — поэтому заполнивший его ломает отправку
 * СОСЕДЯМ. Уборщик не спасает: он ходит по возрасту, сутки спустя.
 */
test('переполнение места под незавершённые вложения отклоняется с внятным текстом', async () => {
  const deleted: string[] = [];
  const app = await buildApp({
    // Ящик уже занял почти всё отведённое.
    usedBy: async () => MAILBOX_LIMIT - 1024,
    save: async (_owner: string, filename: string) => ({
      id: 'up-1',
      owner: 'test@mail.local',
      filename,
      mimeType: 'application/octet-stream',
      size: 4096,
      createdAt: Date.now(),
    }),
    delete: async (id: string) => {
      deleted.push(id);
    },
  } as unknown as Partial<UploadStore>);
  try {
    const { body, contentType } = multipartBody('smeta.pdf', 4096);
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      payload: body,
      headers: { 'content-type': contentType },
    });
    assert.equal(res.statusCode, 413, res.body);
    assert.match(res.json().message, /предел на ящик/i);
    // И сказано, что делать: отправить или удалить начатое.
    assert.match(res.json().message, /Отправьте или удалите/);
    // Файл, из-за которого переполнилось, на диске не остаётся.
    assert.deepEqual(deleted, ['up-1']);
  } finally {
    await app.close();
  }
});
