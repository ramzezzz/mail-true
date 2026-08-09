/**
 * Авария Dovecot не должна выглядеть как подбор пароля.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Вход проверяется настоящим IMAP-логином, и ЛЮБОЙ отказ этой проверки
 * записывался одинаково: «Неудачная попытка входа». Отказ бывает двух
 * совершенно разных природ — «пароль не подошёл» и «почтовый сервер не
 * ответил», — а последствия у записи ровно те же, что у настоящего
 * подбора:
 *
 *   * владелец ящика видит в истории отказ со своего же адреса, то есть
 *     ровно то, что его учили читать как «кто-то лезет в мою почту»;
 *   * строку в api.log читает fail2ban и банит адрес ЦЕЛИКОМ, на всех
 *     портах (infra/fail2ban/filter.d/mailtrue-api.conf).
 *
 * Второе и есть беда. Авария почтового сервера — это когда входят ВСЕ и
 * всем отказывают. При пределе соединений Dovecot оно вдобавок
 * самоусиливается: чем больше людей ломится, тем больше отказов. Через
 * несколько минут забаненными оказываются свои же пользователи и адрес
 * офиса целиком — и после починки Dovecot войти всё равно нельзя, пока
 * не истечёт бан.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗАКРЕПЛЕНО ЗДЕСЬ
 * ------------------------------------------------------------------
 * Недоступность: ни записи в историю ящика, ни строки, по которой
 * стреляет камера. Неверный пароль: и то и другое на месте — иначе
 * починка отключила бы защиту от подбора.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerErrorHandling } from '../http-errors.js';
import { authRoutes } from './auth.js';
import { AuthFailedError, UpstreamUnavailableError } from '../errors.js';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../types.js';

interface Recorded {
  kind: string;
  detail: string;
}

interface Logged {
  level: 'warn' | 'error';
  kind: unknown;
  msg: string;
}

async function buildApp(failWith: Error): Promise<{
  app: FastifyInstance;
  history: Recorded[];
  log: Logged[];
}> {
  const history: Recorded[] = [];
  const log: Logged[] = [];

  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  await app.register(cookie, { secret: 'проверочный-ключ-подписи-cookie' });

  const config = {
    SESSION_COOKIE_NAME: 'mt_session',
    SESSION_TTL_SECONDS: 3600,
    COOKIE_SECURE: false,
  } as unknown as AppConfig;

  app.decorate('deps', {
    config,
    sessions: { set: async () => undefined },
    secretBox: { encrypt: (value: string) => value },
    pool: {
      verify: async () => {
        throw failWith;
      },
    },
    accessLog: {
      record: (row: { kind: string; detail: string }) => {
        history.push({ kind: row.kind, detail: row.detail });
      },
    },
  } as unknown as AppDeps);

  // Журнал перехватываем на самом запросе: именно request.log пишет ту
  // строку, за которой следит fail2ban.
  app.addHook('onRequest', (request, _reply, done) => {
    request.log = {
      warn: (obj: Record<string, unknown>, msg: string) =>
        log.push({ level: 'warn', kind: obj.kind, msg }),
      error: (obj: Record<string, unknown>, msg: string) =>
        log.push({ level: 'error', kind: obj.kind, msg }),
      info: () => undefined,
      debug: () => undefined,
    } as unknown as typeof request.log;
    done();
  });

  registerErrorHandling(app);
  await app.register(authRoutes, { prefix: '/api' });
  await app.ready();
  return { app, history, log };
}

async function login(app: FastifyInstance): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'ivan@mail.local', password: 'правильный-пароль' },
  });
  return response.statusCode;
}

test('почтовый сервер не ответил — это не «неудачная попытка входа»', async () => {
  const { app, history, log } = await buildApp(new UpstreamUnavailableError());
  try {
    assert.equal(await login(app), 503, 'человеку говорят про недоступность, а не про пароль');

    assert.deepEqual(
      history,
      [],
      'в истории ящика аварии не место: там события доступа, а не поломки сервера',
    );

    const forFail2ban = log.filter((line) => line.kind === 'login.failed');
    assert.deepEqual(
      forFail2ban,
      [],
      'строка с kind=login.failed банит адрес целиком — при аварии это забанит своих же',
    );

    const complaint = log.find((line) => line.level === 'error');
    assert.ok(complaint, 'администратор обязан узнать об аварии из журнала');
    assert.equal(complaint.kind, 'login.upstream');
  } finally {
    await app.close();
  }
});

test('неверный пароль по-прежнему учитывается и попадает под камеру', async () => {
  const { app, history, log } = await buildApp(new AuthFailedError());
  try {
    assert.equal(await login(app), 401);

    assert.equal(history.length, 1, 'владелец ящика обязан видеть чужие попытки входа');
    assert.equal(history[0]?.kind, 'login.failed');

    const forFail2ban = log.filter((line) => line.kind === 'login.failed');
    assert.equal(forFail2ban.length, 1, 'без этой строки подбор пароля через веб-форму не ловится');
    assert.equal(forFail2ban[0]?.level, 'warn', 'фильтр камеры ждёт уровень warn (40)');
  } finally {
    await app.close();
  }
});

test('неизвестный отказ считается аварией, а не подбором', async () => {
  /*
   * Осторожность в ту же сторону, что и в classifyImapError: ошибочно
   * назвать пароль неверным дороже, чем ошибочно сказать «сервер
   * недоступен». В первом случае баним живого человека, во втором —
   * всего лишь не поймали одну попытку подбора, которых у камеры и так
   * набирается пять.
   */
  const { app, history, log } = await buildApp(new Error('что-то оборвалось'));
  try {
    await login(app);
    assert.deepEqual(history, []);
    assert.deepEqual(
      log.filter((line) => line.kind === 'login.failed'),
      [],
    );
  } finally {
    await app.close();
  }
});
