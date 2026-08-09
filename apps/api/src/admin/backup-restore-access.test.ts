/**
 * Восстановление копии обязано ЗАКРЫВАТЬ доступ, а не только менять базу.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Восстановление переписывает `virtual_users.password` и
 * `virtual_users.active` сразу у всех ящиков из файла — и не звало при
 * этом ничего из того, чем закрывают доступ. А ни пароль, ни `active` не
 * выгоняют никого сами: Dovecot отсеивает их ТОЛЬКО при проверке пароля,
 * у вошедшего же проверять нечего. Сессия продлевается каждым запросом,
 * соединение в пуле переиспользуется по адресу без сверки пароля,
 * наблюдатель держит своё до суток.
 *
 * Сценарий целиком: сотрудника уволили, его ящик отключили — вернув
 * настройки из копии, где он уже был отключён. Панель показывает ящик
 * заблокированным, а бывший сотрудник в открытой вкладке продолжает
 * читать и отправлять почту и может заказать выгрузку ВСЕГО ящика.
 *
 * Ровно тем же болели администраторы: копия переписывает их пароли, а
 * план восстановления обещает «вход по нынешнему паролю перестанет
 * работать». Обещание было ложным — админская сессия о пароле не знает
 * ничего.
 *
 * Здесь проверяется, что оба замка теперь защёлкиваются.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import cookiePlugin from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { MemorySessionStore } from '../session.js';
import type { AppDeps } from '../types.js';
import { BrandingStore } from './branding.js';
import { buildSettingsBackup } from './backup-format.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { createImportBox } from './import-jobs.js';
import { QueueAgent } from './queue-agent.js';
import { adminBackupRoutes } from './routes/backup.js';
import { MemoryAdminSessionStore } from './session.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });
const BOUNDARY = '----MailTrueRestoreAccessBoundary';
const UVOLEN = 'uvolen@nasha.ru';

/** Тело multipart вручную: inject не умеет собирать форму сам. */
function multipartBody(
  parts: ReadonlyArray<{ field: string; value: string } | { field: string; content: Buffer }>,
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
          `Content-Disposition: form-data; name="${part.field}"; filename="backup.json"\r\n` +
            'Content-Type: application/json\r\n\r\n',
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

/** Копия: один отключённый ящик и один администратор. */
function backupFile(): string {
  return JSON.stringify(
    buildSettingsBackup({
      source: { hostname: 'mail.nasha.ru', domain: 'nasha.ru' },
      data: {
        domains: [],
        mailboxes: [
          {
            email: UVOLEN,
            displayName: 'Уволенный',
            quotaBytes: 1024,
            active: false,
            passwordHash: '{SHA512-CRYPT}$6$staryy$hash',
          },
        ],
        aliases: [],
        admins: [
          {
            login: 'osmotr',
            displayName: null,
            role: 'owner',
            active: true,
            passwordHash: 'scrypt$16384$8$1$AAAA$BBBB',
          },
        ],
        userSettings: [],
        ai: [],
        branding: null,
      },
    }),
  );
}

interface Harness {
  app: FastifyInstance;
  /** Ящики, которым закрыли соединения пула. */
  closedUsers: string[];
  /** Ящики, за которыми прекратили наблюдение. */
  droppedWatchers: string[];
  mailSessions: MemorySessionStore;
  adminSessions: MemoryAdminSessionStore;
  cookie: string;
}

async function harness(): Promise<Harness> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  registerErrorHandling(app);

  /*
   * База отвечает ровно на то, что спрашивает восстановление ящиков и
   * администраторов: домен есть, ящик существует, строка администратора
   * обновлена. Настоящий Postgres здесь не нужен — проверяется не SQL, а
   * то, что после него закрывают доступ.
   */
  const db = {
    findAdminById: async (id: number) => ({
      id,
      login: 'osmotr',
      role: 'owner',
      active: true,
      display_name: null,
    }),
    writeAudit: async () => undefined,
    // Снимок «что уже есть»: по нему план решает, перезапись это или
    // создание. Ящик и администратор из копии здесь уже существуют —
    // значит копия переписывает их пароли, а не заводит новых.
    query: async (text: string) => {
      if (text.includes('FROM virtual_users')) return [{ email: UVOLEN }];
      if (text.includes('FROM admin_users')) return [{ login: 'osmotr' }];
      return [];
    },
    listActiveMigrationDestinations: async () => [],
    transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async (text: string) => {
          if (text.includes('FROM virtual_domains')) return { rows: [{ id: 1 }], rowCount: 1 };
          if (text.includes('FROM virtual_users')) return { rows: [{ id: 5 }], rowCount: 1 };
          if (text.includes('UPDATE admin_users')) return { rows: [{ id: 42 }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      }),
  } as unknown as AdminDb;

  const adminSessions = new MemoryAdminSessionStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-restore-access-'));
  const branding = new BrandingStore(dir);
  await branding.init();

  const config = loadAdminConfig({
    DATABASE_URL: 'postgres://x/y',
    MAIL_HOSTNAME: 'mail.nasha.ru',
    MAIL_DOMAIN: 'nasha.ru',
    BRANDING_DIR: dir,
  } as NodeJS.ProcessEnv);

  const ctx: AdminContext = {
    config,
    db,
    sessions: adminSessions,
    mailbox: { configured: false } as unknown as AdminContext['mailbox'],
    queueAgent: new QueueAgent({ baseUrl: '', token: '', logger }),
    branding,
    cookieSecure: false,
    importBox: createImportBox(SECRET),
  };

  const closedUsers: string[] = [];
  const droppedWatchers: string[] = [];
  const mailSessions = new MemorySessionStore();

  app.decorate('deps', {
    sessions: mailSessions,
    pool: {
      closeUser: async (email: string) => {
        closedUsers.push(email);
      },
    },
  } as unknown as AppDeps);
  app.decorate('mailNotifier', {
    notify: () => false,
    dropWatcher: (email: string) => {
      droppedWatchers.push(email);
      return true;
    },
  });
  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  app.decorate('settingsService', {
    syncSieve: async () => ({ ok: true, written: true, error: '' }),
  } as never);

  await app.register(async (scope) => adminBackupRoutes(scope), { prefix: '/api/admin' });
  await app.ready();

  // Сессия того, кто восстанавливает: его учётная запись в копии есть,
  // значит его собственный пароль тоже будет переписан.
  await adminSessions.set(
    'sess-osmotr',
    { adminId: 42, login: 'osmotr', role: 'owner', createdAt: Date.now(), ip: null },
    3600,
  );

  return {
    app,
    closedUsers,
    droppedWatchers,
    mailSessions,
    adminSessions,
    cookie: `mt_admin=${app.signCookie('sess-osmotr')}`,
  };
}

async function restore(h: Harness, sections: string): Promise<Record<string, unknown>> {
  const form = multipartBody([
    { field: 'file', content: Buffer.from(backupFile(), 'utf8') },
    { field: 'confirm', value: 'yes' },
    { field: 'sections', value: sections },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/restore',
    headers: { ...form.headers, cookie: h.cookie },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Record<string, unknown>>();
}

void test('восстановление копии выгоняет ящик, которому переписало пароль', async () => {
  const h = await harness();
  // Уволенный сидит в почте прямо сейчас: сессия, соединение, наблюдатель.
  await h.mailSessions.set(
    'sess-uvolen',
    { email: UVOLEN, passwordEnc: 'zashifrovano', createdAt: Date.now() },
    3600,
  );

  await restore(h, 'mailboxes');

  assert.equal(
    await h.mailSessions.get('sess-uvolen'),
    null,
    'открытая вкладка обязана перестать работать — иначе блокировка ничего не значит',
  );
  assert.deepEqual(h.closedUsers, [UVOLEN], 'соединение в пуле переживает смену пароля само');
  assert.deepEqual(h.droppedWatchers, [UVOLEN], 'наблюдатель живёт до суток и без вкладок');
});

void test('чужую почтовую сессию восстановление не трогает', async () => {
  const h = await harness();
  await h.mailSessions.set(
    'sess-sosed',
    { email: 'sosed@nasha.ru', passwordEnc: 'zashifrovano', createdAt: Date.now() },
    3600,
  );

  await restore(h, 'mailboxes');

  assert.notEqual(
    await h.mailSessions.get('sess-sosed'),
    null,
    'этого ящика в копии нет — выгонять его не за что',
  );
});

void test('восстановление администраторов закрывает сессии панели — включая свою', async () => {
  const h = await harness();

  const body = await restore(h, 'admins');

  assert.equal(
    await h.adminSessions.get('sess-osmotr'),
    null,
    'пароль переписан копией — сессия обязана закрыться, чужая она или своя',
  );
  // И человеку об этом сказано словами, а не оставлено на «узнает сам».
  assert.match(String(body.note ?? ''), /закрыт/u);
});
