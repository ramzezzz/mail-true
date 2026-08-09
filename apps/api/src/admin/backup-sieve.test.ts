/**
 * Восстановление копии не имеет права рапортовать об успехе, если файл
 * правил в ящике не переписан.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Правила фильтрации живут в базе, а РАБОТАЮТ файлом Sieve в почтовом
 * хранилище. Поэтому после восстановления маршрут пересобирает этот файл
 * каждому затронутому ящику. Пересборка отказывает буднично: выключен
 * транспорт (SIEVE_TRANSPORT=off), недоступен контейнер Dovecot, не
 * записался файл.
 *
 * Служба это знает и НАМЕРЕННО НЕ БРОСАЕТ исключение: `syncSieve`
 * возвращает состояние с причиной (settings/service.ts). А маршрут ловил
 * ровно исключение:
 *
 *     try { await app.settingsService.syncSieve(email); }
 *     catch (err) { sieveErrors.push(...) }
 *
 * Ловить было нечего. Список ошибок всегда оставался пустым, ответ
 * приходил с `ok: true` и «правила пересобраны у N ящиков» — в том самом
 * случае, ради которого этот код и написан: в базе новые правила, а
 * почта раскладывается по СТАРОМУ файлу. Человек видит в панели правила,
 * которые не работают, и узнаёт об этом по потерявшимся письмам.
 *
 * Та же ошибка уже была найдена в личных настройках и покрыта
 * settings/sieve-warning.test.ts — здесь она жила отдельной копией.
 *
 * ------------------------------------------------------------------
 * ВТОРАЯ ПРОВЕРКА ЗДЕСЬ — ПРО АЛИАС ПОВЕРХ ЖИВОГО ЯЩИКА
 * ------------------------------------------------------------------
 * Postfix разбирает карту алиасов раньше карты ящиков, поэтому алиас с
 * адресом существующего ящика уводит ВСЮ его входящую почту. Панель
 * запрещает это с обеих сторон, восстановление шло мимо обоих замков.
 * Пропущенный алиас обязан назваться человеку: иначе после
 * восстановления он выглядит как потеря данных.
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
import { BrandingStore } from './branding.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { createImportBox } from './import-jobs.js';
import { QueueAgent } from './queue-agent.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminBackupRoutes } from './routes/backup.js';
import { buildSettingsBackup } from './backup-format.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });
const BOUNDARY = '----MailTrueSieveBoundary';

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

/** Копия с одним ящиком, у которого есть правило фильтрации. */
function backupWithFilters(): string {
  return JSON.stringify(
    buildSettingsBackup({
      source: { hostname: 'mail.staraya.ru', domain: 'staraya.ru' },
      data: {
        domains: [],
        mailboxes: [],
        aliases: [],
        admins: [],
        userSettings: [
          {
            accountEmail: 'ivanov@nasha.ru',
            settings: null,
            signatures: [],
            filters: [
              {
                name: 'Счета в папку «Бухгалтерия»',
                position: 0,
                enabled: true,
                isAuto: false,
                matchMode: 'all',
                conditions: [],
                actions: {},
              },
            ],
          },
        ],
        ai: [],
        branding: null,
      },
    }),
  );
}

interface Harness {
  app: FastifyInstance;
  audits: Array<Record<string, unknown>>;
  cookie(): Promise<string>;
}

/**
 * @param sieve — что вернёт пересборка файла правил. `written: false`
 *   означает «в ящике остались ПРЕЖНИЕ правила» — тот самый случай.
 */
async function harness(sieve: { ok: boolean; written: boolean; error: string }): Promise<Harness> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  registerErrorHandling(app);

  const audits: Array<Record<string, unknown>> = [];
  const db = {
    findAdminById: async (id: number) => ({
      id,
      login: 'osmotr',
      role: 'owner',
      active: true,
      display_name: null,
    }),
    writeAudit: async (record: Record<string, unknown>) => {
      audits.push(record);
    },
    query: async () => [],
    listActiveMigrationDestinations: async () => [],
    transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
      fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
  } as unknown as AdminDb;

  const sessions = new MemoryAdminSessionStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-backup-sieve-'));
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
    db,
    sessions,
    mailbox: { configured: false } as unknown as AdminContext['mailbox'],
    queueAgent: new QueueAgent({ baseUrl: '', token: '', logger }),
    branding: store,
    cookieSecure: false,
    importBox: createImportBox(SECRET),
  };

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  app.decorate('settingsService', {
    // Ровно то, что делает настоящая служба: НЕ бросает, а возвращает
    // состояние с причиной.
    syncSieve: async () => ({
      transport: 'docker',
      path: '/var/mail/vhosts/nasha.ru/ivanov/sieve/active.sieve',
      activeRules: 1,
      ...sieve,
    }),
  } as never);

  await app.register(async (scope) => adminBackupRoutes(scope), { prefix: '/api/admin' });
  await app.ready();

  const cookie = async (): Promise<string> => {
    const id = `sess-${String(Math.random()).slice(2)}`;
    await sessions.set(
      id,
      { adminId: 1, login: 'osmotr', role: 'owner', createdAt: Date.now(), ip: null },
      3600,
    );
    return `mt_admin=${app.signCookie(id)}`;
  };

  return { app, audits, cookie };
}

async function restore(h: Harness): Promise<Record<string, unknown>> {
  const form = multipartBody([
    { field: 'file', content: Buffer.from(backupWithFilters(), 'utf8') },
    { field: 'confirm', value: 'yes' },
    { field: 'sections', value: 'userSettings' },
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backup/restore',
    headers: { ...form.headers, cookie: await h.cookie() },
    payload: form.payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Record<string, unknown>>();
}

void test('файл правил не переписан — восстановление НЕ рапортует об успехе', async () => {
  const h = await harness({
    ok: false,
    written: false,
    error: 'Контейнер Dovecot недоступен',
  });
  const body = await restore(h);

  assert.equal(body.ok, false, 'успех при непереписанном файле правил — ложь');
  const sieve = body.sieve as { resynced: number; errors: string[] };
  assert.equal(sieve.errors.length, 1, 'отказ пересборки обязан попасть в ответ');
  // Причина — дословно: «что-то пошло не так» не говорит ни что сломалось,
  // ни к кому идти.
  assert.match(sieve.errors[0] ?? '', /Контейнер Dovecot недоступен/u);
  assert.match(sieve.errors[0] ?? '', /ivanov@nasha\.ru/u);
  assert.equal(sieve.resynced, 0, 'пересобранных ящиков не было');

  // И в журнале аудита это тоже видно: иначе от операции, которая сменила
  // правила половине организации, не осталось бы следа о том, что до
  // ящиков они не доехали.
  const audit = h.audits.at(-1);
  assert.ok(audit, 'запись в журнале обязана быть');
  assert.match(JSON.stringify(audit.newValue), /"sieveErrors":1/u);
  await h.app.close();
});

void test('файл правил записан — ответ прежний, без выдуманных ошибок', async () => {
  const h = await harness({ ok: true, written: true, error: '' });
  const body = await restore(h);

  assert.equal(body.ok, true);
  const sieve = body.sieve as { resynced: number; errors: string[] };
  assert.deepEqual(sieve.errors, []);
  assert.equal(sieve.resynced, 1);
  await h.app.close();
});

void test('«не скомпилировано» при записанном файле — не отказ', async () => {
  // На стенде рядом с сервером приложения нет sievec: скрипт записан и
  // работает, Dovecot соберёт его при первой доставке. Крась мы это
  // красным — пугали бы впустую при каждом восстановлении.
  const h = await harness({ ok: false, written: true, error: 'sievec не найден' });
  const body = await restore(h);

  assert.equal(body.ok, true);
  assert.deepEqual((body.sieve as { errors: string[] }).errors, []);
  await h.app.close();
});
