/**
 * Маршруты раздела «Смена домена» на настоящем Fastify.
 *
 * Проверяется то, из-за чего этот раздел вообще опасен:
 *
 *   * право — самое сильное и ничьё больше;
 *   * два шага: выполнение невозможно без составленного плана;
 *   * подтверждение — имя домена руками, а не «да»;
 *   * второй план поверх первого не составляется (ключ DKIM выпускается
 *     один раз, и два плана означали бы два ключа при одной записи в DNS);
 *   * отмена работает ДО точки невозврата и отказывает после;
 *   * приватный ключ DKIM не выходит наружу ни одним маршрутом.
 *
 * База настоящая не нужна: подделка отвечает на запросы по их тексту.
 *
 * На старом коде падают все проверки: раздела смены домена не было.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
import { adminDomainChangeRoutes } from './routes/domain-change.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----SEKRETNYJ-KLYUCH-----';

/** Строка задания в том виде, в каком её отдаёт база. */
function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7',
    admin_id: 1,
    admin_login: 'rukovodstvo',
    old_domain: 'staraya.ru',
    new_domain: 'novaya.ru',
    old_hostname: 'mail.staraya.ru',
    new_hostname: 'mail.novaya.ru',
    dkim_selector: 'mail',
    dkim_public_key: 'PUBLIC',
    // Приватная часть в выборку столбцов вообще не входит — её здесь
    // подкладываем нарочно, чтобы доказать, что наружу она не уедет.
    dkim_private_enc: new SecretBox(SECRET).encrypt(PRIVATE_KEY),
    state: 'planned',
    point_of_no_return_at: null,
    plan: { newDomain: 'novaya.ru', blockers: [] },
    steps: [{ id: 'backup', title: 'Резервная копия настроек', state: 'pending' }],
    mailboxes: 0,
    aliases: 0,
    messages: '0',
    bytes: '0',
    backup_path: null,
    backup_bytes: '0',
    error: null,
    created_at: new Date('2026-01-01T10:00:00Z'),
    updated_at: new Date('2026-01-01T10:00:00Z'),
    started_at: null,
    finished_at: null,
    ...over,
  };
}

/**
 * Подделка базы: отвечает по тексту запроса.
 *
 * Именованных методов у этого раздела почти нет — весь SQL живёт в
 * domain-change-store.ts, поэтому подделка и разбирает запросы. Всё, что
 * держится на настоящем SQL (переписывание адресов, ограничения
 * уникальности), проверяется на живом стенде, а не здесь.
 */
class FakeDb {
  role = 'owner';
  schemaReady = true;
  live: Record<string, unknown> | null = null;
  history: Array<Record<string, unknown>> = [];
  audits: Array<Record<string, unknown>> = [];
  inserted: Array<unknown[]> = [];
  cancelled = 0;
  droppedDomains: string[] = [];
  /** Сколько заданий переноса «идёт» — препятствие для смены домена. */
  liveMigrations = 0;

  async findAdminById(id: number): Promise<Record<string, unknown>> {
    return { id, login: 'rukovodstvo', role: this.role, active: true };
  }

  async writeAudit(record: Record<string, unknown>): Promise<void> {
    this.audits.push(record);
  }

  async one<T>(sql: string, args: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, args);
    return rows[0] ?? null;
  }

  async query<T>(sql: string, args: unknown[] = []): Promise<T[]> {
    const s = sql.replace(/\s+/gu, ' ').trim();
    const rows = (value: unknown): T[] => (value === null ? [] : [value as T]);

    if (s.includes("to_regclass('public.domain_change_jobs')")) {
      return rows({ ok: this.schemaReady });
    }
    if (s.includes("FROM domain_change_jobs WHERE state IN ('planned','running')")) {
      return rows(this.live);
    }
    if (s.includes('FROM domain_change_jobs ORDER BY id DESC LIMIT')) {
      return this.history as T[];
    }
    if (s.includes('FROM domain_change_jobs WHERE id = $1')) {
      const wanted = String(args[0]);
      const found = [this.live, ...this.history].find(
        (r) => r !== null && String((r as { id: string }).id) === wanted,
      );
      return rows(found ?? null);
    }
    if (s.startsWith('INSERT INTO domain_change_jobs')) {
      this.inserted.push(args);
      const created = jobRow({
        new_domain: String(args[3]),
        dkim_public_key: String(args[7]),
        dkim_private_enc: args[8],
        plan: JSON.parse(String(args[9])) as unknown,
      });
      this.live = created;
      return rows(created);
    }
    if (s.includes("SET state = 'cancelled'")) {
      if (this.live === null) return [];
      this.cancelled += 1;
      const done = { ...this.live, state: 'cancelled' };
      this.history.unshift(done);
      this.live = null;
      return rows({ id: '7' });
    }
    if (s.startsWith('DELETE FROM virtual_domains')) {
      this.droppedDomains.push(String(args[0]));
      return rows({ id: 2 });
    }

    /* --- то, из чего собирается план ---------------------------- */

    if (s.includes('FROM information_schema.tables')) return [];
    if (s.includes('FROM virtual_domains d WHERE lower(d.name) = lower($1)')) {
      return rows({ id: 1, users: '12', aliases: '3' });
    }
    // «Свободен ли новый домен» — да, ничего не найдено.
    if (s.includes('SELECT id FROM virtual_domains WHERE lower(name) = $1')) return [];
    // «Существует ли старый домен» — существует.
    if (s.includes('SELECT id FROM virtual_domains WHERE lower(name) = lower($1)')) {
      return rows({ id: 1 });
    }
    if (s.includes('FROM mail_migration_jobs')) {
      return rows({ n: String(this.liveMigrations) });
    }
    if (s.includes('FROM mailbox_export_jobs') || s.includes('FROM user_import_jobs')) {
      return rows({ n: '0' });
    }
    if (s.includes('FROM domain_change_jobs WHERE state =')) return rows({ n: '0' });
    if (s.includes('FROM virtual_users WHERE') || s.includes('FROM virtual_aliases WHERE')) {
      return rows({ n: '0', sample: null });
    }
    // Всё остальное — необязательные разделы: их таблиц может не быть,
    // и код обязан относиться к этому как к «считать нечего».
    throw Object.assign(new Error(`нет такой таблицы: ${s.slice(0, 60)}`), { code: '42P01' });
  }
}

interface Harness {
  app: FastifyInstance;
  db: FakeDb;
  cookie: string;
}

async function harness(options: { role?: string } = {}): Promise<Harness> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const db = new FakeDb();
  db.role = options.role ?? 'owner';
  const sessions = new MemoryAdminSessionStore();
  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: SECRET,
    MAIL_DOMAIN: 'staraya.ru',
    MAIL_HOSTNAME: 'mail.staraya.ru',
    // Каталог писем — пустой временный: план должен уметь считать
    // сервер, на котором писем ещё нет.
    ADMIN_MAIL_ROOT: mkdtempSync(path.join(tmpdir(), 'mt-dc-mail-')),
    ADMIN_MAIL_INDEX_ROOT: mkdtempSync(path.join(tmpdir(), 'mt-dc-idx-')),
    // Резольвер, который заведомо не ответит: проверка DNS обязана
    // сказать «спросить не удалось», а не задержать план.
    DNS_CHECK_RESOLVERS: '127.0.0.1',
  } as unknown as NodeJS.ProcessEnv);

  const started: number[] = [];
  const ctx: AdminContext = {
    config,
    db: db as unknown as AdminDb,
    sessions,
    mailbox: { configured: true } as unknown as AdminContext['mailbox'],
    queueAgent: new QueueAgent({ baseUrl: '', token: '', logger }),
    branding: new BrandingStore(path.join(tmpdir(), 'mailtrue-dc-branding')),
    cookieSecure: false,
    importBox: createImportBox(SECRET),
    domainChangeBox: new SecretBox(SECRET),
    domainChangeRunner: {
      start(jobId: number) {
        started.push(jobId);
      },
    },
  };

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  await adminDomainChangeRoutes(app);

  const sessionId = 'test-session';
  await sessions.set(
    sessionId,
    { adminId: 1, login: 'rukovodstvo', role: db.role, createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  return { app, db, cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${app.signCookie(sessionId)}` };
}

/* ------------------------------------------------------------------ */
/* Права                                                               */
/* ------------------------------------------------------------------ */

void test('смена домена недоступна никому, кроме полного доступа', async () => {
  for (const role of ['readonly', 'user_manager']) {
    const { app, cookie } = await harness({ role });
    const look = await app.inject({ method: 'GET', url: '/domain-change', headers: { cookie } });
    assert.equal(look.statusCode, 403, `роль ${role} не должна видеть даже состояние раздела`);
    const plan = await app.inject({
      method: 'POST',
      url: '/domain-change/plan',
      headers: { cookie },
      payload: { newDomain: 'novaya.ru' },
    });
    assert.equal(plan.statusCode, 403, `роль ${role} не должна составлять план`);
    await app.close();
  }
});

void test('без сессии раздел отвечает 401, а не показывает состав сервера', async () => {
  const { app } = await harness();
  const res = await app.inject({ method: 'GET', url: '/domain-change' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

/* ------------------------------------------------------------------ */
/* Шаг 1: план                                                         */
/* ------------------------------------------------------------------ */

void test('план считает сервер, выпускает ключ DKIM и ничего не меняет', async () => {
  const { app, db, cookie } = await harness();
  const res = await app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie },
    payload: { newDomain: 'Novaya.RU' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = JSON.parse(res.body) as {
    newDomain: string;
    newHostname: string;
    plan: {
      counts: { mailboxes: number; aliases: number };
      dkim: { record: string; recordName: string };
      dnsToPublish: Array<{ type: string; name: string }>;
      breaks: string[];
      manual: string[];
      keeps: unknown[];
      downtimeSeconds: { min: number; max: number };
    };
  };

  assert.equal(body.newDomain, 'novaya.ru', 'домен приводится к нижнему регистру');
  assert.equal(body.newHostname, 'mail.novaya.ru');
  assert.equal(body.plan.counts.mailboxes, 12);
  assert.equal(body.plan.counts.aliases, 3);
  assert.match(body.plan.dkim.record, /^v=DKIM1; k=rsa; p=/u);
  assert.equal(body.plan.dkim.recordName, 'mail._domainkey.novaya.ru');
  assert.ok(
    body.plan.dnsToPublish.some((r) => r.name === 'novaya.ru' && r.type === 'MX'),
    'MX без объяснений не бывает смены домена',
  );
  assert.ok(body.plan.breaks.length > 0, 'последствия обязаны быть перечислены');
  assert.ok(body.plan.manual.length > 0, 'шаги на сервере обязаны быть названы');
  assert.ok(body.plan.keeps.length > 0, 'что не переписывается — тоже часть плана');
  assert.ok(body.plan.downtimeSeconds.max > body.plan.downtimeSeconds.min);

  // Ни одного изменения в почтовых данных: строка задания — не изменение
  // сервера, а запись о намерении.
  assert.equal(db.droppedDomains.length, 0);
  assert.equal(db.cancelled, 0);
  // План записан в журнал аудита наравне с выполнением.
  assert.equal(db.audits.length, 1);
  assert.equal((db.audits[0] as { action: string }).action, 'domainchange.plan');
  await app.close();
});

void test('приватный ключ DKIM не выходит наружу ни одним маршрутом', async () => {
  const { app, db, cookie } = await harness();
  const plan = await app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie },
    payload: { newDomain: 'novaya.ru' },
  });
  assert.equal(plan.statusCode, 201);
  // Доказательство, что ключ вообще был: шифротекст ушёл в базу.
  const saved = db.inserted[0]?.[8];
  assert.ok(typeof saved === 'string' && saved.length > 20, 'ключ должен быть сохранён');
  assert.equal(
    new SecretBox(SECRET).decrypt(saved as string).startsWith('-----BEGIN PRIVATE KEY-----'),
    true,
  );
  // А теперь — что его нет ни в одном ответе.
  for (const body of [
    plan.body,
    (await app.inject({ method: 'GET', url: '/domain-change', headers: { cookie } })).body,
    (await app.inject({ method: 'GET', url: '/domain-change/7', headers: { cookie } })).body,
  ]) {
    assert.doesNotMatch(body, /BEGIN PRIVATE KEY/u, 'приватный ключ в ответе — это утечка подписи');
    assert.doesNotMatch(body, /dkimPrivate/u);
    assert.doesNotMatch(body, new RegExp(saved as string, 'u'));
  }
  await app.close();
});

void test('второй план поверх первого не составляется', async () => {
  const { app, cookie } = await harness();
  const first = await app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie },
    payload: { newDomain: 'novaya.ru' },
  });
  assert.equal(first.statusCode, 201);
  const second = await app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie },
    payload: { newDomain: 'tretya.ru' },
  });
  assert.equal(second.statusCode, 409, 'два плана — это два ключа DKIM при одной записи в DNS');
  assert.match(second.body, /novaya\.ru/u, 'отказ называет, какой именно план уже есть');
  await app.close();
});

void test('домен проверяется по-человечески, а смена на себя отклоняется', async () => {
  const { app, cookie } = await harness();
  const bad = await app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie },
    payload: { newDomain: 'https://novaya.ru/' },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /без протокола/u, 'отказ должен говорить, что именно не так');

  const same = await app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie },
    payload: { newDomain: 'staraya.ru' },
  });
  assert.equal(same.statusCode, 400);
  await app.close();
});

void test('идущий перенос почты попадает в план препятствием', async () => {
  const { app, db, cookie } = await harness();
  db.liveMigrations = 2;
  const res = await app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie },
    payload: { newDomain: 'novaya.ru' },
  });
  assert.equal(res.statusCode, 201, 'план составляется всегда — он и объясняет, что мешает');
  const body = JSON.parse(res.body) as { plan: { blockers: Array<{ id: string; fix: string }> } };
  const blocker = body.plan.blockers.find((b) => b.id === 'migration-running');
  assert.ok(blocker, 'идущий перенос обязан быть препятствием');
  assert.match(blocker.fix, /Дождитесь/u, 'у препятствия должно быть указание, что делать');
  await app.close();
});

/* ------------------------------------------------------------------ */
/* Шаг 2: выполнение                                                   */
/* ------------------------------------------------------------------ */

async function withPlan(): Promise<Harness> {
  const h = await harness();
  const res = await h.app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie: h.cookie },
    payload: { newDomain: 'novaya.ru' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return h;
}

void test('без набранного имени домена смена не запускается', async () => {
  const { app, db, cookie } = await withPlan();
  const auditsBefore = db.audits.length;
  for (const confirm of ['да', 'yes', 'novaya', 'staraya.ru']) {
    const res = await app.inject({
      method: 'POST',
      url: '/domain-change/7/apply',
      headers: { cookie },
      payload: { confirm },
    });
    assert.equal(res.statusCode, 400, `«${confirm}» не должно запускать смену домена`);
    assert.match(res.body, /novaya\.ru/u, 'отказ подсказывает, что именно набрать');
  }
  assert.equal(db.audits.length, auditsBefore, 'неудачная попытка ничего не запускает');
  await app.close();
});

void test('верное подтверждение запускает работника и пишет в журнал', async () => {
  const { app, db, cookie } = await withPlan();
  const res = await app.inject({
    method: 'POST',
    url: '/domain-change/7/apply',
    headers: { cookie },
    payload: { confirm: '  Novaya.RU ' },
  });
  assert.equal(res.statusCode, 202, res.body);
  const applied = db.audits.find((a) => (a as { action: string }).action === 'domainchange.apply');
  assert.ok(applied, 'запуск смены домена обязан оставить след');
  assert.equal((applied as { targetLabel: string }).targetLabel, 'staraya.ru → novaya.ru');
  await app.close();
});

void test('запустить смену без плана нельзя', async () => {
  const { app, cookie } = await harness();
  const res = await app.inject({
    method: 'POST',
    url: '/domain-change/7/apply',
    headers: { cookie },
    payload: { confirm: 'novaya.ru' },
  });
  assert.equal(res.statusCode, 404, 'выполнение без плана — это одношаговая смена домена');
  await app.close();
});

/* ------------------------------------------------------------------ */
/* Отмена и точка невозврата                                           */
/* ------------------------------------------------------------------ */

void test('до точки невозврата отказ убирает и план, и заведённый домен', async () => {
  const { app, db, cookie } = await withPlan();
  const res = await app.inject({ method: 'DELETE', url: '/domain-change/7', headers: { cookie } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(db.cancelled, 1);
  assert.deepEqual(
    db.droppedDomains,
    ['novaya.ru'],
    'домен, смену на который отменили, не остаётся',
  );
  const cancelled = db.audits.find(
    (a) => (a as { action: string }).action === 'domainchange.cancel',
  );
  assert.ok(cancelled, 'отмена тоже пишется в журнал: домен исчез, и это должно быть объяснимо');
  await app.close();
});

void test('после точки невозврата отмена отказывает и объясняет почему', async () => {
  const { app, db, cookie } = await withPlan();
  // Работник дошёл до переноса писем.
  db.live = jobRow({ state: 'running', point_of_no_return_at: new Date('2026-01-01T10:05:00Z') });
  const res = await app.inject({ method: 'DELETE', url: '/domain-change/7', headers: { cookie } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /невозврата/u);
  assert.match(res.body, /нельзя/u, 'человеку говорится прямо, а не «попробуйте позже»');
  assert.equal(db.cancelled, 0, 'отмены не произошло');
  assert.equal(db.droppedDomains.length, 0, 'домен с уже переехавшими ящиками не трогаем');
  await app.close();
});

void test('без своей таблицы раздел честно отвечает, что не готов', async () => {
  const { app, db, cookie } = await harness();
  db.schemaReady = false;
  const look = await app.inject({ method: 'GET', url: '/domain-change', headers: { cookie } });
  assert.equal(look.statusCode, 200, 'состояние раздела должно читаться всегда');
  const body = JSON.parse(look.body) as { ready: boolean; reason: string };
  assert.equal(body.ready, false);
  assert.match(body.reason, /0033_domain_change\.sql/u, 'названа конкретная миграция');

  const plan = await app.inject({
    method: 'POST',
    url: '/domain-change/plan',
    headers: { cookie },
    payload: { newDomain: 'novaya.ru' },
  });
  assert.equal(plan.statusCode, 503);
  await app.close();
});
