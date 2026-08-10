/**
 * Подбор пароля к панели: запирается АДРЕС, а не учётная запись.
 *
 * Дефект, ради которого это написано, заметен на одном вопросе: «а если
 * админ в этот момент входит с другого места?». Раньше — не входил.
 * Счётчик промахов висел на учётной записи, и пять неверных паролей
 * подряд закрывали вход всем. Зная логин — а это «admin» на каждой второй
 * установке, — чужой человек держал администратора запертым бесконечно:
 * пять попыток раз в пятнадцать минут. Защита от подбора работала как
 * кнопка «выключить админу доступ», и нажимать её мог кто угодно.
 *
 * Здесь закреплено ровно то, что должно быть:
 *
 *   1. промахи считаются по паре «учётка + адрес», и запирается адрес;
 *   2. администратор с другого адреса входит, пока чужой заперт;
 *   3. промахи по НЕСУЩЕСТВУЮЩЕМУ логину тоже считаются — иначе перебор
 *      имён ничем не ограничен;
 *   4. удачный вход обнуляет счётчик своего адреса и запоминает адрес;
 *   5. учётная запись всё-таки запирается при подборе с МНОЖЕСТВА
 *      адресов — но своих, уже входивших, это не касается.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { hashAdminPassword } from './passwords.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminAuthRoutes } from './routes/auth.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const PASSWORD = 'pravilnyi-parol-8';
const logger = pino({ level: 'silent' });

/** Порог из настроек по умолчанию: пять промахов с адреса — и он заперт. */
const MAX_BY_IP = 5;

/**
 * Подделка базы, помнящая ровно то, что нужно этим проверкам: промахи по
 * паре «логин + адрес», блокировку учётки и список знакомых адресов.
 */
class FakeDb {
  admin = {
    id: 7,
    login: 'admin',
    role: 'owner',
    active: true,
    display_name: null,
    password_hash: hashAdminPassword(PASSWORD),
    failed_attempts: 0,
    locked_until: null as Date | null,
    last_login_at: null as Date | null,
    last_login_ip: null as string | null,
  };

  /** «логин|адрес» → счётчик и срок блокировки адреса. */
  byAddress = new Map<string, { attempts: number; locked_until: Date | null }>();
  /** Адреса, с которых входили успешно. */
  known = new Set<string>();
  audits: Array<Record<string, unknown>> = [];

  async findAdminByLogin(login: string): Promise<unknown> {
    return login === this.admin.login ? this.admin : null;
  }
  async findAdminById(id: number): Promise<unknown> {
    return id === this.admin.id ? this.admin : null;
  }

  async adminAddressLock(login: string, ip: string): Promise<Date | null> {
    const row = this.byAddress.get(`${login}|${ip}`);
    if (!row?.locked_until) return null;
    return row.locked_until.getTime() > Date.now() ? row.locked_until : null;
  }

  async markAdminAddressFailure(
    login: string,
    ip: string,
    maxFailures: number,
    lockMinutes: number,
  ): Promise<{ attempts: number; locked_until: Date | null }> {
    const key = `${login}|${ip}`;
    const row = this.byAddress.get(key) ?? { attempts: 0, locked_until: null };
    // Отсидевшая блокировка обнуляет счёт — так же, как настоящий запрос
    // (см. AdminDb.markAdminAddressFailure).
    const served = row.locked_until !== null && row.locked_until.getTime() <= Date.now();
    row.attempts = served ? 1 : row.attempts + 1;
    if (served) row.locked_until = null;
    if (row.attempts >= maxFailures) {
      row.locked_until = new Date(Date.now() + lockMinutes * 60_000);
    }
    this.byAddress.set(key, row);
    return row;
  }

  async clearAdminAddressFailures(login: string, ip: string): Promise<void> {
    this.byAddress.delete(`${login}|${ip}`);
  }

  async rememberAdminAddress(adminId: number, ip: string): Promise<void> {
    this.known.add(`${adminId}|${ip}`);
  }

  async adminAddressKnown(adminId: number, ip: string): Promise<boolean> {
    return this.known.has(`${adminId}|${ip}`);
  }

  async markAdminLoginFailure(
    _id: number,
    maxFailures: number,
    lockMinutes: number,
  ): Promise<{ failed_attempts: number; locked_until: Date | null }> {
    const served =
      this.admin.locked_until !== null && this.admin.locked_until.getTime() <= Date.now();
    this.admin.failed_attempts = served ? 1 : this.admin.failed_attempts + 1;
    if (served) this.admin.locked_until = null;
    if (this.admin.failed_attempts >= maxFailures) {
      this.admin.locked_until = new Date(Date.now() + lockMinutes * 60_000);
    }
    return { failed_attempts: this.admin.failed_attempts, locked_until: this.admin.locked_until };
  }

  async markAdminLoginSuccess(_id: number, ip: string | null): Promise<void> {
    this.admin.failed_attempts = 0;
    this.admin.locked_until = null;
    this.admin.last_login_ip = ip;
  }

  async writeAudit(record: Record<string, unknown>): Promise<void> {
    this.audits.push(record);
  }
  async listServerSettings(): Promise<unknown[]> {
    return [];
  }
  async query(): Promise<unknown[]> {
    return [];
  }
}

async function build(db: FakeDb): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  registerErrorHandling(app);
  await app.register(cookiePlugin, { secret: SECRET });

  const ctx: AdminContext = {
    db: db as unknown as AdminDb,
    sessions: new MemoryAdminSessionStore(),
    config: loadAdminConfig({
      ...process.env,
      ADMIN_SESSION_SECRET: SECRET,
      ADMIN_SESSION_COOKIE_NAME: 'mt_admin',
    }),
    logger,
  } as unknown as AdminContext;

  app.decorate('adminCtx', ctx);
  await app.register(adminAuthRoutes);
  await app.ready();
  return app;
}

/** Попытка входа с указанного адреса. */
async function attempt(
  app: FastifyInstance,
  ip: string,
  password: string,
  login = 'admin',
): Promise<{ status: number; message: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'x-forwarded-for': ip },
    payload: { login, password },
  });
  const body = response.json<{ message?: string }>();
  return { status: response.statusCode, message: body.message ?? '' };
}

test('промахи запирают адрес, а не учётную запись', async () => {
  const db = new FakeDb();
  const app = await build(db);
  try {
    for (let i = 0; i < MAX_BY_IP; i += 1) {
      const bad = await attempt(app, '203.0.113.9', 'nevernyi-parol');
      assert.equal(bad.status, 401, `попытка ${String(i + 1)} должна быть отказом по паролю`);
    }

    // Шестая попытка с того же адреса — уже блокировка адреса.
    const locked = await attempt(app, '203.0.113.9', PASSWORD);
    assert.equal(locked.status, 423, 'адрес, перебиравший пароль, обязан быть заперт');
    assert.match(locked.message, /с этого адреса/iu, 'из отказа не видно, что заперт именно адрес');

    // А администратор со своего места входит как ни в чём не бывало —
    // ровно то, чего не было в прежнем поведении.
    const own = await attempt(app, '192.168.1.10', PASSWORD);
    assert.equal(own.status, 200, 'настоящий администратор с другого адреса должен войти');
  } finally {
    await app.close();
  }
});

test('перебор несуществующих логинов тоже считается', async () => {
  const db = new FakeDb();
  const app = await build(db);
  try {
    for (let i = 0; i < MAX_BY_IP; i += 1) {
      await attempt(app, '198.51.100.4', 'chto-nibud', 'nesushchestvuyushchiy');
    }
    const row = db.byAddress.get('nesushchestvuyushchiy|198.51.100.4');
    assert.ok(row, 'промахи по несуществующему логину не записаны — перебор имён не ограничен');
    assert.ok(row.locked_until, 'адрес, перебиравший имена, обязан быть заперт');
  } finally {
    await app.close();
  }
});

test('удачный вход обнуляет счётчик своего адреса и запоминает адрес', async () => {
  const db = new FakeDb();
  const app = await build(db);
  try {
    await attempt(app, '192.168.1.10', 'ne-tot-parol');
    assert.equal(db.byAddress.get('admin|192.168.1.10')?.attempts, 1);

    const ok = await attempt(app, '192.168.1.10', PASSWORD);
    assert.equal(ok.status, 200);
    assert.equal(db.byAddress.has('admin|192.168.1.10'), false, 'счётчик адреса не обнулён');
    assert.ok(db.known.has('7|192.168.1.10'), 'адрес удачного входа не запомнен');
  } finally {
    await app.close();
  }
});

test('запертая учётная запись не мешает своему адресу', async () => {
  const db = new FakeDb();
  const app = await build(db);
  try {
    // Сначала честный вход: адрес становится знакомым.
    assert.equal((await attempt(app, '192.168.1.10', PASSWORD)).status, 200);

    // Теперь учётка заперта — как после подбора с множества адресов.
    db.admin.locked_until = new Date(Date.now() + 15 * 60_000);

    // Чужой адрес проверяем ПЕРВЫМ: удачный вход снимает блокировку
    // учётной записи (и правильно делает), поэтому обратный порядок
    // проверял бы уже не то.
    const stranger = await attempt(app, '203.0.113.77', PASSWORD);
    assert.equal(stranger.status, 423, 'чужой адрес при запертой учётке пускать нельзя');
    assert.match(stranger.message, /со своего обычного адреса/iu);

    const own = await attempt(app, '192.168.1.10', PASSWORD);
    assert.equal(own.status, 200, 'свой адрес обязан входить и при запертой учётке');
    assert.equal(db.admin.locked_until, null, 'удачный вход обязан снимать блокировку учётки');
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------------------ */
/* Отсидевшая блокировка обнуляет счёт                                  */
/* ------------------------------------------------------------------ */

void test('после отсиженной блокировки бюджет попыток возвращается целиком', async () => {
  /*
   * ЧТО БЫЛО. Счётчик рос монотонно и обнулялся ТОЛЬКО удачным входом.
   * Значит после первой блокировки бюджет молча становился равен одной
   * попытке: отсидел пятнадцать минут, ошибся ещё раз — снова пятнадцать.
   * Человеку, честно забывшему пароль, сообщение при этом обещало пять.
   */
  const db = new FakeDb();
  const key = 'admin|203.0.113.5';
  // Блокировка была и уже отсижена.
  db.byAddress.set(key, {
    attempts: 5,
    locked_until: new Date(Date.now() - 60_000),
  });

  const after = await db.markAdminAddressFailure('admin', '203.0.113.5', 5, 15);

  assert.equal(after.attempts, 1, 'счёт начинается заново');
  assert.equal(after.locked_until, null, 'и запирать снова не за что');
});

void test('учётную запись нельзя держать запертой одним промахом в четверть часа', async () => {
  /*
   * Тот же счётчик у самой учётной записи. Пока он не обнулялся, ОДИН
   * неверный пароль раз в пятнадцать минут держал панель запертой вечно —
   * четыре запроса в час с одного адреса. Спастись можно было только со
   * «знакомого» адреса, то есть администратор в командировке не входил
   * уже никогда.
   */
  const db = new FakeDb();
  db.admin.failed_attempts = 30;
  db.admin.locked_until = new Date(Date.now() - 60_000);

  const after = await db.markAdminLoginFailure(db.admin.id, 30, 15);

  assert.equal(after.failed_attempts, 1);
  assert.equal(after.locked_until, null, 'один промах после отсидки не запирает снова');
});

void test('в запросе к базе обнуление счёта действительно есть', () => {
  /*
   * Подделка выше повторяет поведение настоящего запроса. Чтобы они не
   * разъехались молча, сверяем сам текст: без этой ветки проверки выше
   * зеленели бы на сломанном сервере.
   */
  const source = readFileSync(
    fileURLToPath(new URL('./db.ts', import.meta.url).href.replace('/dist/', '/src/')),
    'utf8',
  );
  const address = source.slice(
    source.indexOf('async markAdminAddressFailure'),
    source.indexOf('async clearAdminLoginFailures'),
  );
  assert.match(address, /locked_until <= now\(\)\s*\n\s*THEN 1/u);
  const account = source.slice(
    source.indexOf('async markAdminLoginFailure'),
    source.indexOf(
      '/* ---------------------------------------------------------------- */',
      source.indexOf('async markAdminLoginFailure'),
    ),
  );
  assert.match(account, /locked_until <= now\(\)\s*\n\s*THEN 1/u);
});
