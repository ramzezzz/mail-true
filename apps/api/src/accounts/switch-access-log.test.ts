/**
 * Переключение в связанный ящик обязано быть видно его владельцу.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * `POST /api/accounts/switch` заводит ПОЛНОЦЕННУЮ сессию на другой адрес
 * и не писал в историю ящика ни разу. В `/link` запись была только в
 * ветке отказа — то есть владелец ящика видел неудачные попытки его
 * захвата и не видел удавшуюся.
 *
 * Единственным следом оставалась строка Dovecot о входе с адреса самого
 * сервера приложения, а её помечают служебной
 * (settings/access-reader.ts): в разделе «Вход и действия» она неотличима
 * от собственной работы владельца в вебе. Для сравнения: вход
 * администратора в чужой ящик обставлен обязательной причиной и строкой
 * в admin_mailbox_access.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from '../http-errors.js';
import { SecretBox } from '../crypto.js';
import { MemorySessionStore } from '../session.js';
import type { AppDeps, MailSession } from '../types.js';
import type { AccessRecordInput } from '../settings/access-record.js';
import { accountsUserRoutes } from './routes.js';
import type { AccountsService } from './service.js';

const SECRET = 'test-secret-0123456789-0123456789';
const MOY = 'moy@nasha.ru';
const VTOROY = 'vtoroy@nasha.ru';

interface Harness {
  app: FastifyInstance;
  records: AccessRecordInput[];
  sessions: MemorySessionStore;
}

async function harness(): Promise<Harness> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const records: AccessRecordInput[] = [];
  const box = new SecretBox(SECRET);
  const sessions = new MemorySessionStore();

  app.decorate('deps', {
    config: { SESSION_COOKIE_NAME: 'mt_sess', COOKIE_SECURE: false, SESSION_TTL_SECONDS: 3600 },
    sessions,
    secretBox: box,
    // Пароль связанного ящика проверяется настоящим входом; здесь он
    // подходит — проверяется не проверка пароля, а запись в историю.
    pool: { verify: async () => undefined },
    uploads: {},
    logger: { warn: () => undefined, info: () => undefined },
    accessLog: {
      record: (input: AccessRecordInput) => {
        records.push(input);
      },
    },
  } as unknown as AppDeps);

  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async (request: { mailSession: MailSession | null }) => {
    request.mailSession = { id: 'sess-moy', email: MOY, password: 'parol-moy' };
  });

  const service = {
    requireDb: () => ({
      // Связь заведена заранее: пароль второго ящика доказан когда-то.
      findLinkedSecret: async () => box.encrypt('parol-vtorogo'),
      linkAccount: async () => [{ email: VTOROY }],
    }),
    requireSecretBox: () => box,
    config: { MAIL_DOMAIN: 'nasha.ru' },
  } as unknown as AccountsService;

  await app.register(async (scope) => accountsUserRoutes(scope, service), {
    prefix: '/api/accounts',
  });
  await app.ready();
  return { app, records, sessions };
}

void test('переключение в связанный ящик видно в его истории — и названо, откуда пришли', async () => {
  const h = await harness();

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/accounts/switch',
    payload: { email: VTOROY },
  });
  assert.equal(res.statusCode, 200, res.body);

  const record = h.records.find((r) => r.accountEmail === VTOROY);
  assert.ok(record, 'вход в ящик без записи — это вход, которого владелец не увидит');
  assert.equal(record.kind, 'login');
  assert.match(
    record.detail,
    new RegExp(MOY.replace('.', '\\.'), 'u'),
    'владелец должен видеть, ИЗ КАКОГО ящика к нему зашли',
  );
});

void test('удавшееся связывание тоже попадает в историю связанного ящика', async () => {
  const h = await harness();

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/accounts/link',
    payload: { email: VTOROY, password: 'parol-vtorogo', label: null },
  });
  assert.equal(res.statusCode, 200, res.body);

  const record = h.records.find((r) => r.accountEmail === VTOROY);
  assert.ok(record, 'раньше писалась только НЕудачная попытка — то есть всё, кроме главного');
  assert.match(record.detail, new RegExp(MOY.replace('.', '\\.'), 'u'));
});
