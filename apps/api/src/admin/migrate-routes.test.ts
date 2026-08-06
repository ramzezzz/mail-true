/**
 * Маршруты раздела «Перенос почты» на настоящем Fastify.
 *
 * Главное, что здесь проверяется, — что пароли не выходят наружу. Выгрузка
 * пользователей Kerio Connect содержит пароли ВСЕХ сотрудников открытым
 * текстом; один недосмотр в маршруте — и они уезжают в браузер, в журнал
 * обратного прокси и в историю разработчика, открывшего инструменты
 * страницы. Поэтому проверка сделана обратным ходом: пароль в файле есть,
 * а в ответе его нет ни в одном поле.
 *
 * База настоящая не нужна: подделка запоминает вызовы. Всё, что держится
 * на SQL, живёт в admin/db.integration.test.ts.
 *
 * На старом коде падают все проверки: раздела переноса не существовало.
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { SecretBox } from '../crypto.js';
import { BrandingStore } from './branding.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { createImportBox } from './import-jobs.js';
import { QueueAgent } from './queue-agent.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminMigrateRoutes } from './routes/migrate.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

/** Выгрузка Kerio с паролями открытым текстом — как её отдаёт сам Kerio. */
const KERIO_CSV = [
  'Name;Password;FullName;Description;MailAddress;Groups',
  'abird;OchenSekretnyjParol1;Alexandra Bird;;abird@staraya.ru;',
  'ivanov;DrugojSekret2;Иван Иванов;;ivanov@staraya.ru;',
].join('\n');

/** Подделка базы: помнит, что ей велели записать. */
class FakeDb {
  audits: Array<Record<string, unknown>> = [];
  createdJobs: Array<Record<string, unknown>> = [];
  stopped: number[] = [];
  schemaReady = true;
  job: Record<string, unknown> | null = null;
  items: Array<Record<string, unknown>> = [];

  async migrationSchemaReady(): Promise<boolean> {
    return this.schemaReady;
  }
  async writeAudit(record: Record<string, unknown>): Promise<void> {
    this.audits.push(record);
  }
  async findAdminById(id: number): Promise<Record<string, unknown>> {
    return { id, login: 'rukovodstvo', role: this.role, active: true };
  }
  async createMigrationJob(input: Record<string, unknown>): Promise<number> {
    this.createdJobs.push(input);
    return 42;
  }
  async listMigrationJobs(): Promise<unknown[]> {
    return this.job === null ? [] : [this.job];
  }
  async findMigrationJob(): Promise<Record<string, unknown> | null> {
    return this.job;
  }
  async listMigrationItems(): Promise<unknown[]> {
    return this.items;
  }
  async requestMigrationStop(id: number): Promise<void> {
    this.stopped.push(id);
  }
  role = 'owner';
}

interface Harness {
  app: FastifyInstance;
  db: FakeDb;
  cookie: string;
}

async function harness(options: { role?: string; secret?: boolean; master?: boolean } = {}): Promise<Harness> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const db = new FakeDb();
  db.role = options.role ?? 'owner';
  const sessions = new MemoryAdminSessionStore();
  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: SECRET,
    ...(options.master === false
      ? {}
      : { DOVECOT_MASTER_USER: 'sluzhebnyj', DOVECOT_MASTER_PASSWORD: 'parol' }),
  } as NodeJS.ProcessEnv);

  const ctx: AdminContext = {
    config,
    db: db as unknown as AdminDb,
    sessions,
    mailbox: { configured: true } as unknown as AdminContext['mailbox'],
    queueAgent: new QueueAgent({ baseUrl: '', token: '', logger }),
    branding: new BrandingStore(path.join(tmpdir(), 'mailtrue-migrate-branding')),
    cookieSecure: false,
    importBox: createImportBox(SECRET),
    migrationBox: options.secret === false ? null : new SecretBox(SECRET),
    migrationDest: {
      host: 'dovecot',
      port: 993,
      secure: true,
      allowInsecureTls: true,
      masterUser: 'sluzhebnyj',
      masterPassword: 'parol',
      masterSeparator: '*',
    },
  };

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  await adminMigrateRoutes(app);

  const sessionId = 'test-session';
  await sessions.set(
    sessionId,
    { adminId: 1, login: 'rukovodstvo', role: db.role, createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  return { app, db, cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${app.signCookie(sessionId)}` };
}

/* ------------------------------------------------------------------ */
/* Пароли наружу не выходят                                            */
/* ------------------------------------------------------------------ */

test('предпросмотр списка не отдаёт пароли из выгрузки Kerio', async () => {
  const { app, cookie } = await harness();
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/parse',
    headers: { cookie },
    payload: { text: KERIO_CSV, destDomain: 'novaya.ru' },
  });

  assert.equal(response.statusCode, 200);
  // Обратный ход: пароли в файле ЕСТЬ, и сервер их распознал — значит,
  // отсутствие их в ответе есть работа маршрута, а не пустой файл.
  const body = response.json() as { total: number; withPassword: number };
  assert.equal(body.total, 2);
  assert.equal(body.withPassword, 2, 'сервер обязан видеть пароли — иначе перенос нечем делать');
  assert.doesNotMatch(response.body, /OchenSekretnyjParol1/, 'пароль уехал в браузер');
  assert.doesNotMatch(response.body, /DrugojSekret2/);
});

test('запуск задания не возвращает ни паролей, ни шифротекста', async () => {
  const { app, db, cookie } = await harness();
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/jobs',
    headers: { cookie },
    payload: {
      source: { host: 'kerio.staraya.ru', port: 993, secure: true },
      list: { text: KERIO_CSV, destDomain: 'novaya.ru' },
    },
  });

  assert.equal(response.statusCode, 202, response.body);
  assert.doesNotMatch(response.body, /OchenSekretnyjParol1/);
  // Шифротекст — тоже утечка: его можно унести и ждать компрометации ключа.
  const secretEnc = String(db.createdJobs[0]?.['secretEnc'] ?? '');
  assert.ok(secretEnc.length > 0, 'пароли обязаны сохраниться — иначе переносить нечем');
  assert.doesNotMatch(response.body, new RegExp(secretEnc.slice(0, 24)), 'шифротекст в ответе');
});

test('в журнал аудита не попадает ни пароль, ни шифротекст', async () => {
  const { app, db, cookie } = await harness();
  await app.inject({
    method: 'POST',
    url: '/migrate/jobs',
    headers: { cookie },
    payload: {
      source: { host: 'kerio.staraya.ru', port: 993, secure: true, masterUser: 'admin' },
      list: { text: KERIO_CSV, destDomain: 'novaya.ru' },
      masterPassword: 'ParolSluzhebnogo9',
    },
  });

  const written = JSON.stringify(db.audits);
  assert.doesNotMatch(written, /ParolSluzhebnogo9/, 'служебный пароль в журнале');
  assert.doesNotMatch(written, /OchenSekretnyjParol1/);
  // А кто, откуда и сколько ящиков — записаться обязано.
  assert.match(written, /migration\.start/);
  assert.match(written, /kerio\.staraya\.ru/);
});

/* ------------------------------------------------------------------ */
/* Права                                                               */
/* ------------------------------------------------------------------ */

test('роль «только чтение» видит задания, но не запускает', async () => {
  const { app, cookie } = await harness({ role: 'readonly' });

  const list = await app.inject({ method: 'GET', url: '/migrate/jobs', headers: { cookie } });
  assert.equal(list.statusCode, 200, 'смотреть, доехала ли почта, должен и дежурный');

  const start = await app.inject({
    method: 'POST',
    url: '/migrate/jobs',
    headers: { cookie },
    payload: {
      source: { host: 'kerio.staraya.ru' },
      list: { text: 'ivan@staraya.ru' },
      masterPassword: 'x',
    },
  });
  assert.equal(start.statusCode, 403, 'перенос пишет в чужие ящики — это не чтение');
});

test('управление пользователями запускает перенос без прав владельца', async () => {
  // Перенос по существу то же, что заведение ящика и смена его пароля.
  // Требовать ради переезда учётную запись владельца значило бы раздать
  // полный доступ тем, кому он не нужен.
  const { app, cookie } = await harness({ role: 'user_manager' });
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/jobs',
    headers: { cookie },
    payload: {
      source: { host: 'kerio.staraya.ru', masterUser: 'admin' },
      list: { text: 'ivan@staraya.ru', destDomain: 'novaya.ru' },
      masterPassword: 'ParolSluzhebnogo9',
    },
  });
  assert.equal(response.statusCode, 202, response.body);
});

/* ------------------------------------------------------------------ */
/* Отказы объясняются словами                                          */
/* ------------------------------------------------------------------ */

test('без секрета шифрования раздел отказывает, называя причину', async () => {
  const { app, cookie } = await harness({ secret: false });
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/jobs',
    headers: { cookie },
    payload: {
      source: { host: 'kerio.staraya.ru', masterUser: 'admin' },
      list: { text: 'ivan@staraya.ru' },
      masterPassword: 'x',
    },
  });
  assert.equal(response.statusCode, 503);
  assert.match(response.body, /SESSION_SECRET/, 'должно быть видно, что именно настроить');
});

test('служебный пользователь без пароля — понятный отказ, а не отказ IMAP ночью', async () => {
  const { app, cookie } = await harness();
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/jobs',
    headers: { cookie },
    payload: {
      source: { host: 'kerio.staraya.ru', masterUser: 'admin' },
      list: { text: 'ivan@staraya.ru' },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /пароль/i);
});

test('список без единого пароля отказывается сразу, а не на первом ящике', async () => {
  const { app, cookie } = await harness();
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/jobs',
    headers: { cookie },
    payload: {
      source: { host: 'kerio.staraya.ru' },
      list: { text: 'ivan@staraya.ru\npetr@staraya.ru' },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /служебн/i, 'надо подсказать лучший путь, а не только отказать');
});

test('пустой список не заводит задание «перенести ничего»', async () => {
  const { app, db, cookie } = await harness();
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/jobs',
    headers: { cookie },
    payload: { source: { host: 'kerio.staraya.ru' }, list: { text: '   ' } },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(db.createdJobs.length, 0);
});

/* ------------------------------------------------------------------ */
/* Остановка                                                           */
/* ------------------------------------------------------------------ */

test('остановка завершённого задания отвергается с объяснением', async () => {
  const { app, db, cookie } = await harness();
  db.job = {
    id: '42',
    admin_login: 'rukovodstvo',
    state: 'done',
    stop_requested: false,
    source_host: 'kerio.staraya.ru',
    source_port: 993,
    source_secure: true,
    source_insecure_tls: true,
    source_master_user: null,
    source_master_separator: null,
    secret_enc: null,
    total: 1,
    done_count: 1,
    copied: 10,
    skipped: 0,
    failed: 0,
    error: null,
    runner: null,
    heartbeat_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    started_at: new Date(),
    finished_at: new Date(),
  };
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/jobs/42/stop',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(db.stopped.length, 0);
});

test('остановка идущего задания принимается сразу и записывается в журнал', async () => {
  const { app, db, cookie } = await harness();
  db.job = {
    id: '42',
    admin_login: 'rukovodstvo',
    state: 'running',
    stop_requested: false,
    source_host: 'kerio.staraya.ru',
    source_port: 993,
    source_secure: true,
    source_insecure_tls: true,
    source_master_user: 'admin',
    source_master_separator: '*',
    secret_enc: null,
    total: 5,
    done_count: 2,
    copied: 500,
    skipped: 3,
    failed: 1,
    error: null,
    runner: 'abc',
    heartbeat_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    started_at: new Date(),
    finished_at: null,
  };
  const response = await app.inject({
    method: 'POST',
    url: '/migrate/jobs/42/stop',
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(db.stopped, [42]);
  assert.match(JSON.stringify(db.audits), /migration\.stop/);
});

test('подробности задания не содержат столбца с секретом', async () => {
  const { app, db, cookie } = await harness();
  db.job = {
    id: '42',
    admin_login: 'rukovodstvo',
    state: 'running',
    stop_requested: false,
    source_host: 'kerio.staraya.ru',
    source_port: 993,
    source_secure: true,
    source_insecure_tls: true,
    source_master_user: 'admin',
    source_master_separator: '*',
    // Даже если сюда каким-то образом попал шифротекст, наружу он уйти
    // не должен: маршрут отдаёт поля поимённо, а не строку целиком.
    secret_enc: 'SHIFROTEKST-KOTORYJ-NE-DOLZHEN-VYJTI',
    total: 5,
    done_count: 2,
    copied: 500,
    skipped: 3,
    failed: 1,
    error: null,
    runner: 'abc',
    heartbeat_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    started_at: new Date(),
    finished_at: null,
  };
  const response = await app.inject({ method: 'GET', url: '/migrate/jobs/42', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /SHIFROTEKST/);
  assert.match(response.body, /"copied":500/, 'числа хода работы показывать надо');
});
