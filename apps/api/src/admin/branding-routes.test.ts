/**
 * Маршруты оформления входа (OEM) и резервной копии настроек на настоящем
 * Fastify.
 *
 * Каждая проверка закрывает требование заказчика и падает без правки:
 *
 *   1. «Страница входа отдаётся неаутентифицированным — значит и выдача
 *      логотипа тоже, но это не должно давать возможности перебирать
 *      чужие файлы»: открытые маршруты ровно два, и оба не берут из
 *      запроса ни куска пути.
 *   2. «Ограничения на файл — с ВНЯТНЫМ отказом, а не "некорректный
 *      запрос"»: текст отказа проверяется дословно.
 *   3. «Загрузка исполняемого содержимого под видом картинки должна
 *      отбиваться» — в том числе когда имя файла и Content-Type врут.
 *   4. «Кнопка "вернуть стандартный" обязательна» — маршрут есть и он
 *      возвращает страницу входа к стандартному виду.
 *   5. Восстановление копии не срабатывает без явного подтверждения и
 *      показывает план ДО изменений.
 *
 * База настоящая не нужна: подделка помнит вызовы, а проверяется поведение
 * маршрута — что он ответил, что записал в журнал и чего НЕ сделал.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import cookiePlugin from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { BrandingStore } from './branding.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { createImportBox } from './import-jobs.js';
import { QueueAgent } from './queue-agent.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminBackupRoutes } from './routes/backup.js';
import { adminBrandingRoutes } from './routes/branding.js';
import { SETTINGS_BACKUP_KIND } from './backup-format.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3), 0x80))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Тело multipart вручную: inject не умеет собирать форму сам. */
const BOUNDARY = '----MailTrueTestBoundary';
function multipartBody(
  parts: ReadonlyArray<
    | { field: string; value: string }
    | { field: string; filename: string; contentType: string; content: Buffer }
  >,
): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`, 'latin1'));
    if ('value' in part) {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.field}"\r\n\r\n`, 'utf8'),
        Buffer.from(part.value, 'utf8'),
        Buffer.from('\r\n', 'latin1'),
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
          'utf8',
        ),
        part.content,
        Buffer.from('\r\n', 'latin1'),
      );
    }
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'latin1'));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

/** Подделка базы: для этих маршрутов достаточно пустых выборок. */
class FakeDb {
  role = 'owner';
  audits: Array<Record<string, unknown>> = [];
  queries: string[] = [];

  async findAdminById(id: number): Promise<Record<string, unknown>> {
    return { id, login: 'osmotr', role: this.role, active: true, display_name: null };
  }
  async writeAudit(record: Record<string, unknown>): Promise<void> {
    this.audits.push(record);
  }
  async query(text: string): Promise<unknown[]> {
    this.queries.push(text.replace(/\s+/gu, ' ').trim());
    return [];
  }
  async transaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
    return fn({ query: async () => ({ rows: [], rowCount: 0 }) });
  }
}

interface Harness {
  app: FastifyInstance;
  db: FakeDb;
  store: BrandingStore;
  cookie(): Promise<string>;
}

async function harness(): Promise<Harness> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 5 } });
  registerErrorHandling(app);

  const db = new FakeDb();
  const sessions = new MemoryAdminSessionStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-branding-routes-'));
  const store = new BrandingStore(dir);
  await store.init();

  const config = loadAdminConfig({
    DATABASE_URL: 'postgres://x/y',
    MAIL_HOSTNAME: 'mail.nasha.ru',
    MAIL_DOMAIN: 'nasha.ru',
    BRANDING_DIR: dir,
  } as NodeJS.ProcessEnv);

  const ctx: AdminContext = {
    config,
    db: db as unknown as AdminDb,
    sessions,
    mailbox: { configured: false } as unknown as AdminContext['mailbox'],
    queueAgent: new QueueAgent({ baseUrl: '', token: '', logger }),
    branding: store,
    cookieSecure: false,
    importBox: createImportBox(SECRET),
  };

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  // Настройки ящика этим маршрутам нужны только для пересборки Sieve
  // после восстановления правил; здесь правил нет, но декорация обязана быть.
  app.decorate('settingsService', {
    syncSieve: async () => ({ transport: 'off', path: '', activeRules: 0, ok: true, error: '' }),
  } as never);

  await app.register(
    async (scope) => {
      await adminBrandingRoutes(scope);
      await adminBackupRoutes(scope);
    },
    { prefix: '/api/admin' },
  );
  await app.ready();

  const cookie = async (): Promise<string> => {
    const id = `sess-${String(Math.random()).slice(2)}`;
    await sessions.set(
      id,
      { adminId: 1, login: 'osmotr', role: db.role, createdAt: Date.now(), ip: null },
      3600,
    );
    return `mt_admin=${app.signCookie(id)}`;
  };

  return { app, db, store, cookie };
}

/* ------------------------------------------------------------------ */
/* Открытая часть                                                       */
/* ------------------------------------------------------------------ */

test('оформление читается БЕЗ входа: страницу входа видит тот, кто ещё не вошёл', async () => {
  const { app } = await harness();
  const res = await app.inject({ method: 'GET', url: '/api/admin/branding' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { logo: unknown; limits: { maxBytes: number; formats: string[] } };
  assert.equal(body.logo, null, 'своего логотипа нет — страница берёт стандартный');
  assert.ok(body.limits.maxBytes > 0, 'пределы обязаны быть известны интерфейсу ДО загрузки');
  assert.ok(body.limits.formats.includes('PNG'));
  await app.close();
});

test('пока логотип не загружен, его адрес отвечает 404 с объяснением', async () => {
  const { app } = await harness();
  const res = await app.inject({ method: 'GET', url: '/api/admin/branding/logo' });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<{ message: string }>().message, /стандартный/u);
  await app.close();
});

/* ------------------------------------------------------------------ */
/* Загрузка                                                             */
/* ------------------------------------------------------------------ */

test('без входа логотип не сменить', async () => {
  const { app } = await harness();
  const form = multipartBody([
    { field: 'file', filename: 'logo.png', contentType: 'image/png', content: makePng(200, 40) },
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: form.headers,
    payload: form.payload,
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('роль «только чтение» логотип не меняет', async () => {
  const h = await harness();
  h.db.role = 'readonly';
  const form = multipartBody([
    { field: 'file', filename: 'logo.png', contentType: 'image/png', content: makePng(200, 40) },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: { ...form.headers, cookie: await h.cookie() },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 403);
  await h.app.close();
});

test('загруженный логотип сразу отдаётся всем и с правильным типом', async () => {
  const h = await harness();
  const png = makePng(240, 48);
  const form = multipartBody([
    { field: 'file', filename: 'наш-логотип.png', contentType: 'image/png', content: png },
  ]);
  const upload = await h.app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: { ...form.headers, cookie: await h.cookie() },
    payload: form.payload,
  });
  assert.equal(upload.statusCode, 200);
  const state = upload.json<{ logo: { url: string; width: number; version: string } }>();
  assert.equal(state.logo.width, 240);
  assert.match(state.logo.url, /^\/api\/admin\/branding\/logo\?v=/u, 'адрес обязан нести отпечаток');

  // Без cookie — как со страницы входа
  const shown = await h.app.inject({ method: 'GET', url: state.logo.url });
  assert.equal(shown.statusCode, 200);
  assert.equal(shown.headers['content-type'], 'image/png');
  assert.equal(shown.headers['x-content-type-options'], 'nosniff');
  assert.match(String(shown.headers['content-security-policy']), /default-src 'none'/u);
  assert.match(String(shown.headers['cache-control']), /immutable/u);
  assert.ok(shown.rawPayload.equals(png));

  assert.ok(
    h.db.audits.some((a) => a.action === 'branding.logo.upload'),
    'смена лица продукта обязана оставлять след в журнале',
  );
  await h.app.close();
});

test('исполняемый файл под видом PNG отбивается, и отказ объясняет причину', async () => {
  const h = await harness();
  // Имя и Content-Type врут — оба подконтрольны клиенту.
  const form = multipartBody([
    {
      field: 'file',
      filename: 'logo.png',
      contentType: 'image/png',
      content: Buffer.from('<?php system($_GET["cmd"]); ?>', 'utf8'),
    },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: { ...form.headers, cookie: await h.cookie() },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 400);
  const message = res.json<{ message: string }>().message;
  assert.match(message, /сценарий PHP/u);
  assert.notEqual(message, 'Некорректный запрос');
  // На диск ничего не легло
  assert.equal(await h.store.readLogo(), null);
  await h.app.close();
});

/**
 * Отдельная проверка на предел размера ИМЕННО через маршрут.
 *
 * Дефект был найден на живом стенде: @fastify/multipart по умолчанию сам
 * бросает исключение по достижении предела, и наружу уходило безликое
 * «Файл слишком большой» — без предела, без размера файла и с кодом
 * FILE_TOO_LARGE вместо объяснения. Проверка в branding-image.test.ts это
 * не ловила: туда байты приходят уже прочитанными.
 */
test('слишком большой файл отклоняется с названным пределом, а не «файл слишком большой»', async () => {
  const h = await harness();
  const form = multipartBody([
    {
      field: 'file',
      filename: 'logo.png',
      contentType: 'image/png',
      // 600 КБ при пределе 512 КБ
      content: Buffer.concat([makePng(200, 40), Buffer.alloc(600 * 1024)]),
    },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: { ...form.headers, cookie: await h.cookie() },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 400);
  const message = res.json<{ message: string }>().message;
  assert.match(message, /512 КБ/u, 'предел обязан быть назван словами');
  assert.notEqual(message, 'Файл слишком большой');
  await h.app.close();
});

test('SVG со скриптом не доезжает до страницы входа', async () => {
  const h = await harness();
  const form = multipartBody([
    {
      field: 'file',
      filename: 'logo.svg',
      contentType: 'image/svg+xml',
      content: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40">' +
          '<script>fetch("/api/admin/users")</script></svg>',
        'utf8',
      ),
    },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: { ...form.headers, cookie: await h.cookie() },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ message: string }>().message, /script/iu);
  await h.app.close();
});

test('запрос без файла получает объяснение, а не «некорректный запрос»', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: { cookie: await h.cookie(), 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ message: string }>().message, /multipart/u);
  await h.app.close();
});

test('«вернуть стандартный» возвращает страницу входа к стандартному виду', async () => {
  const h = await harness();
  const cookie = await h.cookie();
  const form = multipartBody([
    { field: 'file', filename: 'logo.png', contentType: 'image/png', content: makePng(200, 40) },
  ]);
  await h.app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: { ...form.headers, cookie },
    payload: form.payload,
  });

  const reset = await h.app.inject({
    method: 'DELETE',
    url: '/api/admin/branding/logo',
    headers: { cookie },
  });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json<{ logo: unknown }>().logo, null);

  const shown = await h.app.inject({ method: 'GET', url: '/api/admin/branding/logo' });
  assert.equal(shown.statusCode, 404);
  assert.ok(h.db.audits.some((a) => a.action === 'branding.logo.reset'));
  await h.app.close();
});

test('повторное «вернуть стандартный» не ошибка: кнопку могли нажать дважды', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'DELETE',
    url: '/api/admin/branding/logo',
    headers: { cookie: await h.cookie() },
  });
  assert.equal(res.statusCode, 200);
  await h.app.close();
});

test('название компании сохраняется и видно без входа', async () => {
  const h = await harness();
  const saved = await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/branding',
    headers: { cookie: await h.cookie() },
    payload: { companyName: 'ООО «Ромашка»' },
  });
  assert.equal(saved.statusCode, 200);

  const open = await h.app.inject({ method: 'GET', url: '/api/admin/branding' });
  assert.equal(open.json<{ companyName: string }>().companyName, 'ООО «Ромашка»');
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* Резервная копия настроек                                             */
/* ------------------------------------------------------------------ */

test('копию настроек не скачать без права: внутри хэши паролей', async () => {
  const h = await harness();
  h.db.role = 'readonly';
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/export',
    headers: { cookie: await h.cookie() },
  });
  assert.equal(res.statusCode, 403);
  await h.app.close();
});

test('выгрузка отдаётся файлом, не кэшируется и попадает в журнал', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/export',
    headers: { cookie: await h.cookie() },
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="mailtrue-settings-/u);
  assert.equal(res.headers['cache-control'], 'no-store');

  const file = JSON.parse(res.body) as { kind: string; version: number; source: { hostname: string } };
  assert.equal(file.kind, SETTINGS_BACKUP_KIND);
  assert.equal(file.version, 1);
  assert.equal(file.source.hostname, 'mail.nasha.ru');
  assert.ok(h.db.audits.some((a) => a.action === 'backup.export'));
  await h.app.close();
});

test('в выгрузке нет ни одной переменной окружения', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/export',
    headers: { cookie: await h.cookie() },
  });
  for (const key of ['POSTGRES_PASSWORD', 'DATABASE_URL', 'SESSION_SECRET', 'AI_ENCRYPTION_KEY']) {
    assert.ok(!res.body.includes(key), `${key} в копии настроек быть не должно`);
  }
  await h.app.close();
});

test('логотип едет внутри копии настроек', async () => {
  const h = await harness();
  const cookie = await h.cookie();
  const png = makePng(200, 40);
  const form = multipartBody([
    { field: 'file', filename: 'logo.png', contentType: 'image/png', content: png },
  ]);
  await h.app.inject({
    method: 'POST',
    url: '/api/admin/branding/logo',
    headers: { ...form.headers, cookie },
    payload: form.payload,
  });

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/export',
    headers: { cookie },
  });
  const file = JSON.parse(res.body) as { data: { branding: { logoBase64: string } } };
  assert.equal(file.data.branding.logoBase64, png.toString('base64'));
  await h.app.close();
});

test('предпросмотр копии показывает план и НИЧЕГО не меняет', async () => {
  const h = await harness();
  const cookie = await h.cookie();
  const backup = JSON.parse(
    (
      await h.app.inject({ method: 'POST', url: '/api/admin/backup/export', headers: { cookie } })
    ).body,
  ) as Record<string, unknown>;

  const before = h.db.audits.length;
  const form = multipartBody([
    {
      field: 'file',
      filename: 'copy.json',
      contentType: 'application/json',
      content: Buffer.from(JSON.stringify(backup), 'utf8'),
    },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/preview',
    headers: { ...form.headers, cookie },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ plan: { sections: Array<{ id: string }>; warnings: string[] } }>();
  assert.ok(body.plan.sections.length > 0);
  assert.ok(body.plan.warnings.some((w) => /ничего не удаляет/u.test(w)));
  assert.equal(h.db.audits.length, before, 'предпросмотр не меняет ничего и в журнал не пишет');
  await h.app.close();
});

test('восстановление без подтверждения не выполняется', async () => {
  const h = await harness();
  const cookie = await h.cookie();
  const backup = (
    await h.app.inject({ method: 'POST', url: '/api/admin/backup/export', headers: { cookie } })
  ).body;

  const form = multipartBody([
    {
      field: 'file',
      filename: 'copy.json',
      contentType: 'application/json',
      content: Buffer.from(backup, 'utf8'),
    },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/restore',
    headers: { ...form.headers, cookie },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ message: string }>().message, /не подтверждено/u);
  await h.app.close();
});

test('чужой файл при восстановлении отвергается понятным текстом', async () => {
  const h = await harness();
  const form = multipartBody([
    { field: 'confirm', value: 'yes' },
    {
      field: 'file',
      filename: 'mailtrue-20260115.tar.gz',
      contentType: 'application/gzip',
      content: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
    },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/restore',
    headers: { ...form.headers, cookie: await h.cookie() },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ message: string }>().message, /не читается как JSON|копия настроек/u);
  await h.app.close();
});

test('восстановление с подтверждением применяется и пишется в журнал', async () => {
  const h = await harness();
  const cookie = await h.cookie();
  const backup = (
    await h.app.inject({ method: 'POST', url: '/api/admin/backup/export', headers: { cookie } })
  ).body;

  const form = multipartBody([
    { field: 'confirm', value: 'yes' },
    { field: 'sections', value: 'branding' },
    {
      field: 'file',
      filename: 'copy.json',
      contentType: 'application/json',
      content: Buffer.from(backup, 'utf8'),
    },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/restore',
    headers: { ...form.headers, cookie },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ ok: boolean; plan: { sections: Array<{ id: string }> } }>();
  assert.equal(body.ok, true);
  assert.deepEqual(
    body.plan.sections.map((s) => s.id),
    ['branding'],
    'выбранный раздел один — остальные трогать нельзя',
  );
  assert.ok(h.db.audits.some((a) => a.action === 'backup.restore'));
  await h.app.close();
});

test('неизвестный раздел при восстановлении называется поимённо', async () => {
  const h = await harness();
  const cookie = await h.cookie();
  const backup = (
    await h.app.inject({ method: 'POST', url: '/api/admin/backup/export', headers: { cookie } })
  ).body;
  const form = multipartBody([
    { field: 'confirm', value: 'yes' },
    { field: 'sections', value: 'pisma' },
    {
      field: 'file',
      filename: 'copy.json',
      contentType: 'application/json',
      content: Buffer.from(backup, 'utf8'),
    },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/restore',
    headers: { ...form.headers, cookie },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ message: string }>().message, /pisma/u);
  await h.app.close();
});
