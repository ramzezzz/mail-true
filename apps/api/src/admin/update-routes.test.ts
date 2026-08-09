/**
 * Обновление продукта из панели.
 *
 * ------------------------------------------------------------------
 * ЧЕМ ЭТО ОПАСНО
 * ------------------------------------------------------------------
 * Кнопка «обновить» — самое разрушительное действие панели: она
 * пересобирает и поднимает заново ВЕСЬ стек. Поэтому здесь закрыто то,
 * что стоит дорого и проверяется только тестом:
 *
 *   1. Правки руками на сервере. Обновление кода поверх них либо встанет
 *      с конфликтом на середине, либо переедет вместе с ними в состояние,
 *      которого нет ни в одном репозитории. Отказ обязан быть ДО запуска,
 *      а не в выводе через три минуты.
 *   2. Базовые образы правок руками не касаются — запрет на них
 *      распространяться не должен, иначе исправления безопасности
 *      окажутся недоступны на том самом сервере, где что-то правили.
 *   3. Режим обновления — закрытый список из двух значений. Он уезжает
 *      посреднику, у которого сокет Docker.
 *   4. Без посредника обязан быть внятный отказ с командой для консоли, а
 *      не тишина и не «принято».
 *   5. Состояние обновления пересказывается как есть, а незнакомое —
 *      как «ничего не идёт»: выдумывать «идёт» опаснее всего, потому что
 *      на это состояние завязан запрет второго запуска.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { adminRestartRoutes } from './routes/restart.js';
import { MemoryAdminSessionStore } from './session.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

/** Что посредник успел получить: сюда пишутся все обращения. */
interface Calls {
  started: string[];
}

interface Rig {
  app: FastifyInstance;
  cookie: string;
  calls: Calls;
}

/**
 * Стенд с поддельным посредником.
 *
 * `dirty` — правки руками в каталоге сервера; `configured` — настроен ли
 * посредник вообще.
 */
async function harness(options: { dirty?: boolean; configured?: boolean } = {}): Promise<Rig> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const calls: Calls = { started: [] };
  const agent = {
    configured: options.configured ?? true,
    version: async () => ({
      commit: 'a'.repeat(40),
      short: 'aaaaaaa',
      branch: 'master',
      committedAt: '2026-08-09T10:00:00.000Z',
      subject: 'что-то полезное',
      dirty: options.dirty ?? false,
      behind: 3,
      ahead: 0,
      pending: [],
      images: [],
    }),
    startUpdate: async (mode: string) => {
      calls.started.push(mode);
    },
    updateStatus: async () => ({
      state: 'running' as const,
      mode: 'code' as const,
      exitCode: 0,
      startedAt: '2026-08-09T10:05:00.000Z',
      finishedAt: '',
      log: 'сборка идёт',
    }),
  };

  const db = {
    findAdminById: async (id: number) => ({ id, login: 'osmotr', role: 'owner', active: true }),
    writeAudit: async () => undefined,
    query: async () => [],
  } as unknown as AdminDb;

  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: SECRET,
    MAIL_DOMAIN: 'home.local',
    MAIL_HOSTNAME: 'mail.home.local',
  } as unknown as NodeJS.ProcessEnv);

  const ctx = {
    config,
    db,
    sessions: new MemoryAdminSessionStore(),
    serviceAgent: agent,
    selfRestart: null,
    restarts: null,
  } as unknown as AdminContext;

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  await adminRestartRoutes(app);

  const sessionId = 'test-session';
  await ctx.sessions.set(
    sessionId,
    { adminId: 1, login: 'osmotr', role: 'owner', createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  await app.ready();

  return { app, cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${app.signCookie(sessionId)}`, calls };
}

/** Запуск обновления выбранного вида. */
async function start(rig: Rig, mode: string) {
  return rig.app.inject({
    method: 'POST',
    url: '/version/update',
    headers: { cookie: rig.cookie },
    payload: { mode },
  });
}

void test('обновление кода поверх правок руками не запускается', async () => {
  const rig = await harness({ dirty: true });
  try {
    const res = await start(rig, 'code');
    assert.notEqual(res.statusCode, 202, 'обновление запущено поверх чужих правок');
    assert.deepEqual(rig.calls.started, [], 'до посредника дошло');
    assert.match(res.body, /руками/iu, 'человеку не сказано, что именно мешает');
  } finally {
    await rig.app.close();
  }
});

void test('отказ подсказывает, чем посмотреть эти правки', async () => {
  // Отказ читает человек, у которого сервера перед глазами нет. «Нельзя»
  // без «вот как проверить» отправляет его искать причину наугад.
  const rig = await harness({ dirty: true });
  try {
    const res = await start(rig, 'code');
    assert.match(res.body, /git/u);
    assert.match(res.body, /status/u);
  } finally {
    await rig.app.close();
  }
});

void test('свежие базовые образы правки руками не блокируют', async () => {
  /*
   * Обратная сторона запрета. Образы не трогают рабочее дерево, и запрет
   * на них означал бы, что сервер с одной поправленной строкой в конфиге
   * навсегда остаётся со старым nginx — то есть без исправлений
   * безопасности.
   */
  const rig = await harness({ dirty: true });
  try {
    const res = await start(rig, 'images');
    assert.equal(res.statusCode, 202, res.body);
    assert.deepEqual(rig.calls.started, ['images']);
  } finally {
    await rig.app.close();
  }
});

void test('обычное обновление кода уходит посреднику', async () => {
  const rig = await harness();
  try {
    const res = await start(rig, 'code');
    assert.equal(res.statusCode, 202, res.body);
    assert.deepEqual(rig.calls.started, ['code']);
  } finally {
    await rig.app.close();
  }
});

void test('режим обновления — закрытый список, чужое до посредника не доходит', async () => {
  const rig = await harness();
  try {
    for (const evil of ['', 'all', 'CODE', 'code; rm -rf /', 'images ', '../code']) {
      const res = await start(rig, evil);
      assert.equal(res.statusCode, 400, `режим «${evil}» принят`);
    }
    assert.deepEqual(rig.calls.started, []);
  } finally {
    await rig.app.close();
  }
});

void test('без посредника — внятный отказ с командой для консоли', async () => {
  const rig = await harness({ configured: false });
  try {
    const res = await start(rig, 'code');
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /посредник/iu);
    assert.match(res.body, /git/u, 'не сказано, как обновиться руками');
  } finally {
    await rig.app.close();
  }
});

void test('ход обновления отдаётся как есть', async () => {
  const rig = await harness();
  try {
    const res = await rig.app.inject({
      method: 'GET',
      url: '/version/update',
      headers: { cookie: rig.cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { state: string; log: string };
    assert.equal(body.state, 'running');
    assert.equal(body.log, 'сборка идёт');
  } finally {
    await rig.app.close();
  }
});
