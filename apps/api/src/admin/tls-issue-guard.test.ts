/**
 * Выпуск Let's Encrypt не затирает купленный сертификат молча.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Выпуск раскладывает по стеку новый ключ и новый сертификат поверх
 * старых. Если там лежал купленный у удостоверяющего центра, его
 * приватный ключ пропадал безвозвратно: вернуть можно было только из
 * внешней копии, а её у владельца сервера обычно нет.
 *
 * Консольный путь этот случай закрывает давно — renew-certs.sh
 * отказывается работать при source=custom и требует
 * MT_REPLACE_CUSTOM_CERT=1. Панель шла мимо: кнопка «Выпустить и
 * установить» стояла рядом, без подтверждения, и на той же странице
 * советовала эту переменную.
 *
 * Защита обязана быть НА СЕРВЕРЕ, а не только в форме: галочка в
 * браузере обходится запросом мимо неё — curl, старая сборка панели,
 * чей-нибудь скрипт.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminTlsRoutes } from './routes/tls.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

/** Каталог сертификатов с отметкой источника. */
async function certDirWith(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-tls-guard-'));
  await writeFile(path.join(dir, 'source'), `${source}\n`, 'utf8');
  return dir;
}

interface Rig {
  app: FastifyInstance;
  cookie: string;
  /** Дошло ли дело до настоящего выпуска. */
  issued: () => boolean;
}

async function harness(source: string): Promise<Rig> {
  const dir = await certDirWith(source);
  let issuedCalls = 0;

  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const db = {
    findAdminById: async (id: number) => ({ id, login: 'osmotr', role: 'owner', active: true }),
    writeAudit: async () => undefined,
    query: async () => [],
  } as unknown as AdminDb;

  const config = {
    ...loadAdminConfig({
      ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
      SESSION_SECRET: SECRET,
    } as NodeJS.ProcessEnv),
    TLS_CERT_DIR: dir,
    MAIL_DOMAIN: 'mail.local',
    MAIL_HOSTNAME: 'mail.mail.local',
  };

  const ctx = {
    config,
    db,
    sessions: new MemoryAdminSessionStore(),
    serviceAgent: {
      configured: true,
      issueLetsEncrypt: async () => {
        issuedCalls += 1;
        return { staging: false, certName: 'mailtrue', output: 'ok' };
      },
    },
  } as unknown as AdminContext;

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  await adminTlsRoutes(app);

  const sessionId = 'test-session';
  await ctx.sessions.set(
    sessionId,
    { adminId: 1, login: 'osmotr', role: 'owner', createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  await app.ready();

  return {
    app,
    cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${app.signCookie(sessionId)}`,
    issued: () => issuedCalls > 0,
  };
}

function issue(rig: Rig, body: Record<string, unknown>) {
  return rig.app.inject({
    method: 'POST',
    url: '/tls/letsencrypt',
    headers: { cookie: rig.cookie },
    payload: { email: 'admin@mail.local', ...body },
  });
}

test('поверх своего сертификата выпуск без подтверждения не идёт', async () => {
  const rig = await harness('custom');
  try {
    const res = await issue(rig, {});
    assert.notEqual(res.statusCode, 200, 'купленный сертификат затёрт без единого вопроса');
    assert.match(res.body, /свой сертификат/i, 'человеку не сказано, чем он рискует');
    assert.match(res.body, /коп/i, 'не сказано, что вернуть можно только из копии');
    assert.equal(rig.issued(), false, 'выпуск всё равно был запущен');
  } finally {
    await rig.app.close();
  }
});

test('с явным подтверждением замена разрешена: это осознанный выбор', async () => {
  const rig = await harness('custom');
  try {
    const res = await issue(rig, { replaceCustom: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(rig.issued(), true, 'подтверждение есть, а выпуск не пошёл');
  } finally {
    await rig.app.close();
  }
});

test('поверх самоподписанного и прежнего Let’s Encrypt вопросов нет — терять нечего', async () => {
  for (const source of ['selfsigned', 'letsencrypt']) {
    const rig = await harness(source);
    try {
      const res = await issue(rig, {});
      assert.equal(res.statusCode, 200, `${source}: ${res.body}`);
      assert.equal(rig.issued(), true, `${source}: выпуск не пошёл`);
    } finally {
      await rig.app.close();
    }
  }
});

test('пробный выпуск поверх своего сертификата разрешён: он ничего не раскладывает', async () => {
  // Испытательный сертификат никуда не устанавливается, поэтому спрашивать
  // согласие не о чем — а спросив, мы отучили бы проверять домен заранее.
  const rig = await harness('custom');
  try {
    const res = await issue(rig, { staging: true });
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    await rig.app.close();
  }
});
