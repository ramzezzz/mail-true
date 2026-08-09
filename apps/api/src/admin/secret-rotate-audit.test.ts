/**
 * Перевыпуск секрета обязан остаться в журнале аудита.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Запись в аудит стояла ПОСЛЕ пересоздания служб. Для главного секрета —
 * SESSION_SECRET, подписи сессий и почты, и панели, — она не появлялась
 * НИКОГДА: его перевыпуск пересоздаёт контейнер api, то есть
 * останавливает тот самый процесс, которому оставалось записать строчку.
 *
 * То есть смена секрета, из-за которой все до единого оказываются на
 * странице входа, не оставляла в журнале ни следа. А это ровно то
 * событие, которое ищут первым, когда разбираются, что произошло.
 *
 * ------------------------------------------------------------------
 * ЧЕМ ПЛАТИМ
 * ------------------------------------------------------------------
 * Записью о начатом действии, которое могло не доехать до конца. Это
 * честнее пропуска: «перевыпуск начат, службы такие-то» проверяется
 * одним взглядом на службы, а отсутствие записи не проверяется ничем.
 * Отказ посреди списка пишется отдельной строкой — у общего секрета двух
 * служб это состояние «одна с новым, вторая со старым», и видеть его
 * надо в журнале, а не по отказам служб.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminServerSettingsRoutes } from './routes/server-settings.js';
import { ServerSettings } from './server-settings.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';

/*
 * Отдельный ADMIN_SESSION_SECRET — условие, без которого перевыпуск
 * SESSION_SECRET запрещён: иначе он работает ещё и ключом шифрования
 * (пароли импорта, задания переноса, ключ DKIM). Проверяется по
 * process.env живого процесса, поэтому задаём его здесь.
 */
process.env.ADMIN_SESSION_SECRET = 'z'.repeat(48);
const logger = pino({ level: 'silent' });

interface Audit {
  action: string;
  targetLabel: string;
  newValue: unknown;
}

/** Посредник, который пересоздаёт api — то есть убивает этот процесс. */
function agentThatKillsApi(order: string[], failOn?: string, downOn?: string) {
  return {
    configured: true,
    apply: async (target: { id: string }) => {
      order.push(target.id);
      if (failOn === target.id) throw new Error('посредник не ответил');
      /*
       * Служба ОТВЕТИЛА, но не поднялась. Настоящий посредник различает
       * это с «команда не выполнилась» намеренно: там 500, а здесь
       * обычный ответ с ok=false.
       */
      if (downOn === target.id) {
        return { up: false, detail: 'контейнер вышел с кодом 1' };
      }
      // Настоящий посредник в этот момент останавливает контейнер api:
      // всё, что стоит в коде после этой строки, может не выполниться.
      return { up: true };
    },
  };
}

async function harness(options: { failOn?: string; downOn?: string } = {}): Promise<{
  app: FastifyInstance;
  cookie: string;
  audits: Audit[];
  order: string[];
}> {
  const audits: Audit[] = [];
  const order: string[] = [];

  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const db = {
    findAdminById: async (id: number) => ({ id, login: 'osmotr', role: 'owner', active: true }),
    writeAudit: async (record: Record<string, unknown>) => {
      audits.push({
        action: String(record.action),
        targetLabel: String(record.targetLabel),
        newValue: record.newValue,
      });
    },
    query: async () => [],
  } as unknown as AdminDb;

  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: SECRET,
  } as NodeJS.ProcessEnv);

  const ctx: AdminContext = {
    config,
    db,
    sessions: new MemoryAdminSessionStore(),
    mailbox: {} as AdminContext['mailbox'],
    queueAgent: {} as AdminContext['queueAgent'],
    branding: {} as AdminContext['branding'],
    cookieSecure: false,
    importBox: null,
    serverSettings: new ServerSettings({
      db: null,
      env: {
        MAIL_DOMAIN: 'mail.local',
        // Иначе перевыпуск SESSION_SECRET запрещён: без отдельного
        // ADMIN_SESSION_SECRET он работает ещё и ключом шифрования.
        ADMIN_SESSION_SECRET: 'z'.repeat(48),
      } as NodeJS.ProcessEnv,
      cacheMs: 0,
    }),
    serviceAgent: agentThatKillsApi(order, options.failOn, options.downOn),
  } as unknown as AdminContext;

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);
  await adminServerSettingsRoutes(app);

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
    audits,
    order,
  };
}

test('запись в аудит делается ДО пересоздания служб', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'POST',
    url: '/server-settings/secrets/SESSION_SECRET/rotate',
    headers: { cookie: h.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);

  const record = h.audits.find((item) => item.action === 'serversettings.secret.rotate');
  assert.ok(record, 'перевыпуск обязан оставить след');
  assert.equal(record.targetLabel, 'SESSION_SECRET');

  // Главное: запись сделана раньше, чем посредник тронул api. Иначе она
  // не появится вовсе — процесса к тому времени не будет.
  assert.ok(h.order.includes('api'), 'проверка бессмысленна, если api не пересоздавали');
  assert.equal(
    h.audits.length >= 1 && h.order.length >= 1,
    true,
    'обе стороны должны были сработать',
  );
});

test('в журнал не попадает само значение секрета', async () => {
  const h = await harness();
  await h.app.inject({
    method: 'POST',
    url: '/server-settings/secrets/SESSION_SECRET/rotate',
    headers: { cookie: h.cookie },
  });
  const text = JSON.stringify(h.audits);
  assert.ok(!/[A-Za-z0-9_-]{40,}/.test(text), 'в аудите не должно быть ничего похожего на секрет');
});

test('отказ посреди списка виден отдельной записью', async () => {
  const h = await harness({ failOn: 'api' });
  const response = await h.app.inject({
    method: 'POST',
    url: '/server-settings/secrets/SESSION_SECRET/rotate',
    headers: { cookie: h.cookie },
  });
  assert.equal(response.statusCode >= 500, true, 'отказ обязан дойти до человека');

  const failure = h.audits.find((item) => item.action === 'serversettings.secret.rotate.failed');
  assert.ok(failure, 'без этой записи «одна служба с новым секретом, вторая со старым» не видно');

  /*
   * И вот это доказывает порядок.
   *
   * Посредник не дошёл до конца — значит всё, что стояло ПОСЛЕ цикла, не
   * выполнилось. Раньше там была единственная запись о перевыпуске, и
   * при таком отказе её не появлялось вовсе. Настоящий отказ выглядит
   * ещё жёстче: контейнер api останавливают, и «после цикла» не
   * наступает никогда.
   */
  assert.ok(
    h.audits.some((item) => item.action === 'serversettings.secret.rotate'),
    'запись о самом перевыпуске обязана быть даже тогда, когда применение сорвалось',
  );
});

test('служба ответила, но не встала — это отказ, а не «пересоздана»', async () => {
  /*
   * Посредник различает «команда не выполнилась» (500) и «выполнилась,
   * служба не поднялась» (обычный ответ с ok=false). Второй случай сюда
   * приходил как удача: результат apply выбрасывался, и служба попадала
   * в список пересозданных.
   *
   * Цена прямая. Перевыпуск QUEUE_AGENT_TOKEN пересоздаёт postfix, новое
   * значение уже в infra/.env и назад не откатывается. Контейнер не
   * встал — почта не принимается вовсе, а администратор прочитал
   * «Секрет выпущен заново. Пересозданы службы: postfix» и ушёл.
   */
  const h = await harness({ downOn: 'api' });
  const response = await h.app.inject({
    method: 'POST',
    url: '/server-settings/secrets/SESSION_SECRET/rotate',
    headers: { cookie: h.cookie },
  });

  assert.notEqual(response.statusCode, 200, 'не поднявшаяся служба выдана за успех');
  assert.match(response.body, /не поднялась/i, 'человеку не сказано, что именно случилось');
  assert.match(response.body, /вручную|проверьте/i, 'не сказано, что делать дальше');

  // И это обязано быть в журнале: секрет уже сменён, состояние половинчатое.
  const failed = h.audits.find((item) => item.action === 'serversettings.secret.rotate.failed');
  assert.ok(failed, 'в журнале нет следа о том, что перевыпуск не доехал');
});
