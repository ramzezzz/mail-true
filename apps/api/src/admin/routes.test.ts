/**
 * Проверки админских маршрутов на настоящем Fastify.
 *
 * Каждый тест здесь закрывает подтверждённый дефект и падает без правки —
 * это проверялось откатом:
 *
 *   1. Удаление домена молча уничтожало алиасы (каскад в схеме, проверка
 *      только по числу ящиков).
 *   2. Удаление ящика оставляло почту на диске и мусор в базе, а повторно
 *      созданный ящик с тем же адресом показывал чужую старую переписку.
 *   3. Предпросмотр импорта обещал то, чего импорт не делал: право
 *      создавать домены проверялось только при импорте.
 *   4. Результат импорта (в том числе сгенерированные пароли) жил только
 *      в теле ответа и пропадал при обрыве связи.
 *   5. Сеанс входа администратора в чужой ящик не закрывался ничем, кроме
 *      явного выхода.
 *   6. Владелец ящика не видел входов администратора: пользовательского
 *      маршрута не было ни одного.
 *
 * База настоящая не нужна: подделка запоминает вызовы, а проверяется
 * поведение маршрута — что он вызвал, что ответил и в каком порядке.
 * Всё, что держится на самом SQL, проверяется в admin/db.integration.test.ts
 * на живой базе.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { BrandingStore } from './branding.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { createImportBox, ImportSecretBox, packResult, unpackResult } from './import-jobs.js';
import { QueueAgent } from './queue-agent.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminAuthRoutes } from './routes/auth.js';
import { adminDomainRoutes } from './routes/domains.js';
import { adminMailboxRoutes } from './routes/mailbox.js';
import { mailboxAccessSelfRoutes } from './routes/self-access.js';
import { adminUserRoutes } from './routes/users.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

interface Call {
  name: string;
  args: unknown[];
}

/** Подделка базы: помнит вызовы и отдаёт заранее заданные строки. */
class FakeDb {
  readonly calls: Call[] = [];
  users = new Map<number, Record<string, unknown>>();
  domains = new Map<number, Record<string, unknown>>();
  aliases: Array<Record<string, unknown>> = [];
  access: Array<Record<string, unknown>> = [];
  jobs = new Map<number, Record<string, unknown>>();
  audits: Array<Record<string, unknown>> = [];
  knownEmails: string[] = [];
  #nextId = 1;

  #note(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  called(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  /* --- администраторы --- */
  async findAdminById(id: number): Promise<Record<string, unknown>> {
    return { id, login: 'osmotr', role: this.role, active: true, display_name: null };
  }
  role = 'owner';

  async writeAudit(record: Record<string, unknown>): Promise<void> {
    this.audits.push(record);
  }

  /* --- ящики --- */
  async findMailUserById(id: number): Promise<Record<string, unknown> | null> {
    return this.users.get(id) ?? null;
  }
  async findMailUserByEmail(email: string): Promise<Record<string, unknown> | null> {
    for (const user of this.users.values()) {
      if (String(user.email).toLowerCase() === email.toLowerCase()) return user;
    }
    return null;
  }
  /**
   * Куда ведёт перенаправление с этого адреса.
   *
   * Спрашивается перед созданием ящика: адрес, занятый перенаправлением,
   * дал бы ящик, в который никогда ничего не придёт (Postfix разбирает
   * карту алиасов раньше карты ящиков).
   */
  async aliasTargetOf(source: string): Promise<string | null> {
    for (const alias of this.aliases.values()) {
      if (String(alias.source).toLowerCase() === source.toLowerCase()) {
        return String(alias.destination);
      }
    }
    return null;
  }
  async deleteMailUser(id: number): Promise<void> {
    this.#note('deleteMailUser', id);
    this.users.delete(id);
  }
  async purgeMailboxData(email: string): Promise<number> {
    this.#note('purgeMailboxData', email);
    return 7;
  }
  async listAliases(filters: Record<string, unknown>): Promise<{ rows: unknown[]; total: number }> {
    const rows = this.aliases.filter((a) => a.domain_id === filters.domainId);
    return { rows, total: rows.length };
  }
  async listEmailsIn(emails: readonly string[]): Promise<string[]> {
    return this.knownEmails.filter((e) => emails.includes(e));
  }
  async createMailUser(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#note('createMailUser', input);
    const id = this.#nextId++;
    const row = {
      id,
      domain_id: input.domainId,
      email: input.email,
      display_name: input.displayName ?? null,
      quota_bytes: input.quotaBytes ?? 0,
      active: true,
      created_at: new Date(),
      updated_at: new Date(),
      domain: String(input.email).split('@')[1],
      alias_count: 0,
    };
    this.users.set(id, row);
    return row;
  }
  async resolveDomain(
    name: string,
    allowCreate: boolean,
  ): Promise<{ id: number; name: string } | null> {
    this.#note('resolveDomain', name, allowCreate);
    for (const [id, domain] of this.domains) {
      if (String(domain.name) === name) return { id, name };
    }
    if (!allowCreate) return null;
    const id = this.#nextId++;
    this.domains.set(id, { id, name, user_count: 0, alias_count: 0, created_at: new Date() });
    return { id, name };
  }

  /* --- домены --- */
  async listDomains(): Promise<Array<Record<string, unknown>>> {
    return [...this.domains.values()];
  }
  async findDomainById(id: number): Promise<Record<string, unknown> | null> {
    return this.domains.get(id) ?? null;
  }
  async deleteDomain(id: number): Promise<void> {
    this.#note('deleteDomain', id);
    this.domains.delete(id);
    // В схеме у virtual_aliases каскад: алиасы уходят вместе с доменом.
    this.aliases = this.aliases.filter((a) => a.domain_id !== id);
  }

  /* --- удаление ящика --- */
  async recordMailboxDeletion(input: Record<string, unknown>): Promise<number> {
    this.#note('recordMailboxDeletion', input);
    return 42;
  }
  async updateMailboxDeletion(id: number, patch: Record<string, unknown>): Promise<void> {
    this.#note('updateMailboxDeletion', id, patch);
  }

  /* --- вход в чужой ящик --- */
  async recordMailboxAccess(input: Record<string, unknown>): Promise<number> {
    this.#note('recordMailboxAccess', input);
    const id = this.#nextId++;
    this.access.push({
      id: String(id),
      admin_login: input.adminLogin,
      mailbox_email: input.mailboxEmail,
      reason: input.reason,
      ip: input.ip ?? null,
      started_at: new Date(),
      ended_at: null,
      end_reason: null,
    });
    return id;
  }
  async endMailboxAccess(id: number, reason: string): Promise<void> {
    this.#note('endMailboxAccess', id, reason);
    const row = this.access.find((a) => Number(a.id) === id);
    if (row && row.ended_at === null) {
      row.ended_at = new Date();
      row.end_reason = reason;
    }
  }
  async closeOpenMailboxAccess(adminId: number, reason: string): Promise<number> {
    this.#note('closeOpenMailboxAccess', adminId, reason);
    let closed = 0;
    for (const row of this.access) {
      if (row.ended_at === null) {
        row.ended_at = new Date();
        row.end_reason = reason;
        closed += 1;
      }
    }
    return closed;
  }
  async listMailboxAccessForOwner(
    email: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: unknown[]; total: number }> {
    const rows = this.access.filter(
      (a) => String(a.mailbox_email).toLowerCase() === email.toLowerCase(),
    );
    return { rows: rows.slice(offset, offset + limit), total: rows.length };
  }

  /* --- задания импорта --- */
  async createImportJob(input: Record<string, unknown>): Promise<number> {
    const id = this.#nextId++;
    this.jobs.set(id, {
      id: String(id),
      admin_login: input.adminLogin,
      state: 'running',
      total: input.total,
      processed: 0,
      created_count: 0,
      failed_count: 0,
      result_enc: null,
      error: null,
      created_at: new Date(),
      updated_at: new Date(),
      finished_at: null,
      expires_at: new Date(Date.now() + 86_400_000),
    });
    return id;
  }
  async updateImportJob(id: number, patch: Record<string, unknown>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    if (patch.state !== undefined) job.state = patch.state;
    if (patch.processed !== undefined) job.processed = patch.processed;
    if (patch.createdCount !== undefined) job.created_count = patch.createdCount;
    if (patch.failedCount !== undefined) job.failed_count = patch.failedCount;
    if (patch.resultEnc !== undefined) job.result_enc = patch.resultEnc;
    if (patch.error !== undefined) job.error = patch.error;
    if (patch.finished === true) job.finished_at = new Date();
  }
  async findImportJob(id: number): Promise<Record<string, unknown> | null> {
    return this.jobs.get(id) ?? null;
  }
  async listImportJobs(): Promise<Array<Record<string, unknown>>> {
    return [...this.jobs.values()];
  }
}

interface Harness {
  app: FastifyInstance;
  db: FakeDb;
  ctx: AdminContext;
  /** Кука админской сессии — её нужно слать в каждом запросе. */
  cookie: string;
  mailRoot: string;
}

/** Поднимает Fastify с админскими маршрутами и уже открытой сессией. */
async function harness(options?: {
  role?: string;
  mailRoot?: string;
  masterConfigured?: boolean;
  purge?: (email: string) => Promise<{ ok: boolean; foldersDeleted: number; error: string | null }>;
}): Promise<Harness> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const db = new FakeDb();
  db.role = options?.role ?? 'owner';
  const sessions = new MemoryAdminSessionStore();
  const mailRoot = options?.mailRoot ?? (await mkdtemp(path.join(tmpdir(), 'mt-mail-')));

  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    ADMIN_MAIL_ROOT: mailRoot,
    SESSION_SECRET: SECRET,
  } as NodeJS.ProcessEnv);

  const mailbox = {
    configured: options?.masterConfigured ?? true,
    verify: async (): Promise<void> => undefined,
    purgeMail:
      options?.purge ??
      (async (): Promise<{ ok: boolean; foldersDeleted: number; error: string | null }> => ({
        ok: true,
        foldersDeleted: 3,
        error: null,
      })),
  };

  const ctx: AdminContext = {
    config,
    db: db as unknown as AdminDb,
    sessions,
    mailbox: mailbox as unknown as AdminContext['mailbox'],
    // Посредник к очереди намеренно НЕ настроен: эти проверки про права и
    // маршруты, а не про очередь. Ненастроенный посредник честно отвечает
    // 503 и никуда не ходит — сеть в проверках не нужна.
    queueAgent: new QueueAgent({ baseUrl: '', token: '', logger: pino({ level: 'silent' }) }),
    // Оформление входа этим проверкам не нужно, но контекст обязан быть
    // полным: каталог указываем во временном, ни один тест в него не пишет.
    branding: new BrandingStore(path.join(tmpdir(), 'mailtrue-admin-routes-branding')),
    cookieSecure: false,
    importBox: createImportBox(SECRET),
  };

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  app.decorateRequest('mailSession', null);
  // Почтовая сессия для пользовательского маршрута: адрес берётся отсюда,
  // а не из запроса, — заглянуть в чужую историю нельзя.
  app.decorate('requireSession', async function requireSession(request) {
    const email = request.headers['x-test-mailbox'];
    if (typeof email !== 'string') throw new Error('нет почтовой сессии');
    request.mailSession = { id: 'test', email, password: 'x' };
  });

  await adminAuthRoutes(app);
  await adminUserRoutes(app);
  await adminDomainRoutes(app);
  await adminMailboxRoutes(app);
  await mailboxAccessSelfRoutes(app, ctx);

  const sessionId = 'test-session';
  await sessions.set(
    sessionId,
    { adminId: 1, login: 'osmotr', role: db.role, createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  const signed = app.signCookie(sessionId);
  return { app, db, ctx, cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${signed}`, mailRoot };
}

/* ------------------------------------------------------------------ */
/* 1. Удаление домена не должно молча уничтожать алиасы                 */
/* ------------------------------------------------------------------ */

void test('удаление домена с алиасами отклоняется, а не сносит их молча', async () => {
  const h = await harness();
  h.db.domains.set(5, {
    id: 5,
    name: 'x.local',
    user_count: '0',
    alias_count: '2',
    created_at: new Date(),
  });
  h.db.aliases = [
    { id: 1, domain_id: 5, source: 'a@x.local', destination: 'b@x.local', active: true },
    { id: 2, domain_id: 5, source: 'c@x.local', destination: 'd@x.local', active: true },
  ];

  const response = await h.app.inject({
    method: 'DELETE',
    url: '/domains/5',
    headers: { cookie: h.cookie },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json<{ message: string }>().message, /алиас/i);
  // Ни домен, ни алиасы не тронуты.
  assert.equal(h.db.called('deleteDomain').length, 0);
  assert.equal(h.db.aliases.length, 2);
  await h.app.close();
});

void test('удаление домена с force сносит алиасы, но записывает их в журнал аудита', async () => {
  const h = await harness();
  h.db.domains.set(5, {
    id: 5,
    name: 'x.local',
    user_count: '0',
    alias_count: '1',
    created_at: new Date(),
  });
  h.db.aliases = [
    { id: 1, domain_id: 5, source: 'a@x.local', destination: 'b@x.local', active: true },
  ];

  const response = await h.app.inject({
    method: 'DELETE',
    url: '/domains/5?force=true',
    headers: { cookie: h.cookie },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ aliasesRemoved: number }>().aliasesRemoved, 1);
  const record = h.db.audits.find((a) => a.action === 'domain.delete');
  assert.ok(record, 'запись об удалении домена должна быть в журнале');
  const removed = JSON.stringify(record.oldValue);
  assert.match(removed, /a@x\.local/, 'уничтоженные алиасы обязаны быть в журнале');
  await h.app.close();
});

void test('домен без алиасов удаляется как раньше', async () => {
  const h = await harness();
  h.db.domains.set(6, {
    id: 6,
    name: 'y.local',
    user_count: '0',
    alias_count: '0',
    created_at: new Date(),
  });
  const response = await h.app.inject({
    method: 'DELETE',
    url: '/domains/6',
    headers: { cookie: h.cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(h.db.called('deleteDomain').length, 1);
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 2. Удаление ящика убирает почту, а не только строку в таблице        */
/* ------------------------------------------------------------------ */

async function seedMaildir(root: string, email: string): Promise<string> {
  const [local, domain] = email.split('@');
  const dir = path.join(root, String(domain), String(local));
  await mkdir(path.join(dir, 'cur'), { recursive: true });
  await writeFile(path.join(dir, 'cur', '1234.mail'), 'From: someone\r\n\r\nстарое письмо');
  return dir;
}

void test('ящик поверх перенаправления не заводится: он был бы пустым навсегда', async () => {
  /*
   * Postfix разбирает карту алиасов РАНЬШЕ карты ящиков. Поэтому ящик,
   * заведённый на адрес, с которого уже стоит перенаправление, не получит
   * ни одного письма — они все уйдут по перенаправлению. Выглядит он при
   * этом полностью рабочим: создан, виден в списке, пускает по IMAP.
   *
   * Обратное направление (алиас поверх живого ящика) заблокировано давно
   * и подробно объяснено в alias-check.ts. Это не проверялось вовсе.
   */
  const h = await harness();
  h.db.aliases.push({
    id: 1,
    domain_id: 5,
    source: 'sales@x.local',
    destination: 'ivan@x.local',
    active: true,
  });

  const response = await h.app.inject({
    method: 'POST',
    url: '/users',
    headers: { cookie: h.cookie },
    payload: { email: 'sales@x.local', password: 'Parol12345', active: true },
  });

  assert.equal(response.statusCode, 409, 'ящик поверх перенаправления создавать нельзя');
  const body = response.json<{ message: string }>();
  // Отказ обязан назвать, КУДА уходит почта: без этого человек не поймёт,
  // что именно удалять в разделе «Алиасы».
  assert.match(body.message, /ivan@x\.local/u);
  assert.match(body.message, /перенаправлени/u);
});

void test('удаление ящика уводит Maildir из-под нового ящика с тем же адресом', async () => {
  const h = await harness();
  const dir = await seedMaildir(h.mailRoot, 'gone@x.local');
  h.db.users.set(9, {
    id: 9,
    domain_id: 5,
    email: 'gone@x.local',
    display_name: null,
    quota_bytes: 0,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    domain: 'x.local',
    alias_count: 0,
  });

  const response = await h.app.inject({
    method: 'DELETE',
    url: '/users/9?reason=увольнение',
    headers: { cookie: h.cookie },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    mailDirQuarantined: boolean;
    dbRowsRemoved: number;
    imapPurged: boolean;
  }>();
  assert.equal(body.mailDirQuarantined, true);
  assert.equal(body.imapPurged, true, 'ящик должен быть очищен средствами Dovecot');
  assert.equal(body.dbRowsRemoved, 7, 'служебные строки должны быть убраны');

  // Самое важное: по старому пути больше ничего нет, и новый ящик с тем же
  // адресом не увидит чужую переписку.
  await assert.rejects(stat(dir), 'каталог ящика обязан исчезнуть со старого места');
  assert.equal(h.db.called('purgeMailboxData').length, 1);
  assert.equal(h.db.called('recordMailboxDeletion').length, 1);
  await h.app.close();
});

void test('удаление ящика чистит Dovecot ДО удаления строки из базы', async () => {
  const order: string[] = [];
  const h = await harness({
    purge: async () => {
      order.push('purgeMail');
      return { ok: true, foldersDeleted: 1, error: null };
    },
  });
  h.db.users.set(3, {
    id: 3,
    domain_id: 5,
    email: 'order@x.local',
    display_name: null,
    quota_bytes: 0,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    domain: 'x.local',
    alias_count: 0,
  });
  const original = h.db.deleteMailUser.bind(h.db);
  h.db.deleteMailUser = async (id: number): Promise<void> => {
    order.push('deleteMailUser');
    await original(id);
  };

  await h.app.inject({ method: 'DELETE', url: '/users/3', headers: { cookie: h.cookie } });

  // После удаления строки Dovecot не пустит даже служебного пользователя,
  // и убрать индексы поиска будет уже нечем.
  assert.deepEqual(order, ['purgeMail', 'deleteMailUser']);
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 3. Предпросмотр импорта показывает ровно то, что произойдёт          */
/* ------------------------------------------------------------------ */

const IMPORT_CSV = 'email,name\nnew@fresh.local,Новый\n';

void test('предпросмотр импорта не обещает создать домен роли, которой это запрещено', async () => {
  const h = await harness({ role: 'user_manager' });
  h.db.domains.set(1, {
    id: 1,
    name: 'x.local',
    user_count: '0',
    alias_count: '0',
    created_at: new Date(),
  });

  const response = await h.app.inject({
    method: 'POST',
    url: '/users/import/preview',
    headers: { cookie: h.cookie },
    payload: { csv: IMPORT_CSV, allowNewDomains: true },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    validCount: number;
    invalidCount: number;
    allowNewDomains: boolean;
    newDomainsDenied: boolean;
    rows: Array<{ errors: string[] }>;
  }>();
  assert.equal(body.allowNewDomains, false, 'право не то — домены создаваться не будут');
  assert.equal(body.newDomainsDenied, true, 'об этом надо сказать прямо');
  assert.equal(body.validCount, 0, 'строка с незаведённым доменом не будет создана');
  assert.equal(body.invalidCount, 1);
  assert.match(body.rows[0]?.errors.join('; ') ?? '', /домен/i);
  await h.app.close();
});

void test('владельцу предпросмотр по-прежнему обещает создание домена', async () => {
  const h = await harness({ role: 'owner' });
  h.db.domains.set(1, {
    id: 1,
    name: 'x.local',
    user_count: '0',
    alias_count: '0',
    created_at: new Date(),
  });

  const response = await h.app.inject({
    method: 'POST',
    url: '/users/import/preview',
    headers: { cookie: h.cookie },
    payload: { csv: IMPORT_CSV, allowNewDomains: true },
  });
  const body = response.json<{
    validCount: number;
    allowNewDomains: boolean;
    newDomainsDenied: boolean;
  }>();
  assert.equal(body.allowNewDomains, true);
  assert.equal(body.newDomainsDenied, false);
  assert.equal(body.validCount, 1);
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 4. Результат импорта переживает обрыв связи                          */
/* ------------------------------------------------------------------ */

void test('импорт отдаёт номер задания, а результат с паролями лежит на сервере', async () => {
  const h = await harness();
  h.db.domains.set(1, {
    id: 1,
    name: 'x.local',
    user_count: '0',
    alias_count: '0',
    created_at: new Date(),
  });

  const started = await h.app.inject({
    method: 'POST',
    url: '/users/import',
    headers: { cookie: h.cookie },
    payload: { csv: 'email\none@x.local\ntwo@x.local\n' },
  });
  assert.equal(started.statusCode, 202);
  const { jobId, passwordsStored } = started.json<{ jobId: number; passwordsStored: boolean }>();
  assert.ok(jobId > 0);
  assert.equal(passwordsStored, true);

  // Ждём завершения — как это делает интерфейс после обрыва связи.
  let job: {
    state: string;
    created: Array<{ email: string; generatedPassword: string | null }>;
  } | null = null;
  for (let i = 0; i < 50; i += 1) {
    const response = await h.app.inject({
      method: 'GET',
      url: `/users/import/jobs/${String(jobId)}`,
      headers: { cookie: h.cookie },
    });
    job = response.json();
    if (job?.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job?.state, 'done');
  assert.equal(job?.created.length, 2);
  assert.ok(
    job?.created.every((row) => (row.generatedPassword ?? '').length >= 8),
    'сгенерированные пароли обязаны быть доступны после обрыва связи',
  );

  // И столько раз, сколько понадобится: вкладку могли закрыть и вернуться.
  const again = await h.app.inject({
    method: 'GET',
    url: `/users/import/jobs/${String(jobId)}`,
    headers: { cookie: h.cookie },
  });
  assert.equal(again.json<{ created: unknown[] }>().created.length, 2);
  await h.app.close();
});

void test('пароли задания импорта лежат в базе только шифротекстом', () => {
  const box = new ImportSecretBox(SECRET);
  const boxed = packResult(box, {
    created: [{ email: 'one@x.local', generatedPassword: 'Пароль-Секрет-1' }],
    failed: [],
  });
  assert.ok(boxed);
  assert.ok(!boxed.includes('Пароль-Секрет-1'));
  assert.equal(unpackResult(box, boxed)?.created[0]?.generatedPassword, 'Пароль-Секрет-1');
  // Чужим ключом не прочитать, и это не авария, а «результата нет».
  assert.equal(unpackResult(new ImportSecretBox('другой-секрет-совсем'), boxed), null);
});

/* ------------------------------------------------------------------ */
/* 5. Сеанс входа в чужой ящик закрывается не только кнопкой «выйти»    */
/* ------------------------------------------------------------------ */

function mailboxCookie(
  app: FastifyInstance,
  response: { cookies: Array<{ name: string; value: string }> },
): string {
  const raw = response.cookies.find((c) => c.name === 'mt_admin_mailbox');
  assert.ok(raw, 'вход должен выдать cookie сеанса');
  return `mt_admin_mailbox=${raw.value}`;
}

async function seedUser(h: Harness, id: number, email: string): Promise<void> {
  h.db.users.set(id, {
    id,
    domain_id: 1,
    email,
    display_name: null,
    quota_bytes: 0,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    domain: email.split('@')[1],
    alias_count: 0,
  });
}

void test('вход в другой ящик закрывает запись о предыдущем', async () => {
  const h = await harness();
  await seedUser(h, 1, 'first@x.local');
  await seedUser(h, 2, 'second@x.local');

  const first = await h.app.inject({
    method: 'POST',
    url: '/mailbox/enter',
    headers: { cookie: h.cookie },
    payload: { email: 'first@x.local', reason: 'разбор жалобы' },
  });
  assert.equal(first.statusCode, 200);

  await h.app.inject({
    method: 'POST',
    url: '/mailbox/enter',
    headers: { cookie: `${h.cookie}; ${mailboxCookie(h.app, first)}` },
    payload: { email: 'second@x.local', reason: 'разбор второй жалобы' },
  });

  const open = h.db.access.filter((a) => a.ended_at === null);
  assert.equal(open.length, 1, 'открытой должна остаться ровно одна запись');
  assert.equal(open[0]?.mailbox_email, 'second@x.local');
  const closed = h.db.access.find((a) => a.mailbox_email === 'first@x.local');
  assert.equal(closed?.end_reason, 'replaced');
  await h.app.close();
});

void test('выход из админки закрывает и сеанс входа в чужой ящик', async () => {
  const h = await harness();
  await seedUser(h, 1, 'first@x.local');
  const entered = await h.app.inject({
    method: 'POST',
    url: '/mailbox/enter',
    headers: { cookie: h.cookie },
    payload: { email: 'first@x.local', reason: 'разбор жалобы' },
  });

  await h.app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { cookie: `${h.cookie}; ${mailboxCookie(h.app, entered)}` },
  });

  assert.equal(h.db.access.filter((a) => a.ended_at === null).length, 0);
  assert.equal(h.db.access[0]?.end_reason, 'logout');
  await h.app.close();
});

void test('вход в ящик записывает срок сеанса — по нему уборщик закроет брошенную запись', async () => {
  const h = await harness();
  await seedUser(h, 1, 'first@x.local');
  await h.app.inject({
    method: 'POST',
    url: '/mailbox/enter',
    headers: { cookie: h.cookie },
    payload: { email: 'first@x.local', reason: 'разбор жалобы' },
  });
  const call = h.db.called('recordMailboxAccess')[0];
  const input = call?.args[0] as { ttlSeconds?: number };
  assert.ok(
    typeof input.ttlSeconds === 'number' && input.ttlSeconds > 0,
    'без срока запись не закрыть ничем, кроме явного выхода',
  );
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 6. Владелец ящика видит входы администратора                         */
/* ------------------------------------------------------------------ */

void test('владелец ящика видит входы администратора в своей истории', async () => {
  const h = await harness();
  await seedUser(h, 1, 'owner@x.local');
  await h.app.inject({
    method: 'POST',
    url: '/mailbox/enter',
    headers: { cookie: h.cookie },
    payload: { email: 'owner@x.local', reason: 'жалоба на потерянное письмо' },
  });

  const response = await h.app.inject({
    method: 'GET',
    url: '/account/admin-access',
    headers: { 'x-test-mailbox': 'owner@x.local' },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    total: number;
    items: Array<{ adminLogin: string; reason: string; active: boolean }>;
  }>();
  assert.equal(body.total, 1);
  assert.equal(body.items[0]?.adminLogin, 'osmotr');
  assert.equal(
    body.items[0]?.reason,
    'жалоба на потерянное письмо',
    'причину входа обязан видеть тот, ради кого её требуют указывать',
  );
  assert.equal(body.items[0]?.active, true);
  await h.app.close();
});

void test('в чужую историю входов заглянуть нельзя: адрес берётся из сессии', async () => {
  const h = await harness();
  await seedUser(h, 1, 'owner@x.local');
  await h.app.inject({
    method: 'POST',
    url: '/mailbox/enter',
    headers: { cookie: h.cookie },
    payload: { email: 'owner@x.local', reason: 'жалоба на потерянное письмо' },
  });

  const response = await h.app.inject({
    method: 'GET',
    // Подставляем чужой адрес в запрос — он не должен ни на что влиять.
    url: '/account/admin-access?mailbox=owner@x.local&email=owner@x.local',
    headers: { 'x-test-mailbox': 'someone-else@x.local' },
  });
  assert.equal(response.json<{ total: number }>().total, 0);
  await h.app.close();
});
