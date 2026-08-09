/**
 * Правка фильтров обязана оставлять след в истории ящика.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Вид события `filters` был объявлен (settings/owner-db.ts) и не писался
 * НИГДЕ. Маршруты фильтров не звали запись в историю ни разу — и выходило
 * наизнанку: безобидная очистка папки след оставляла
 * (settings/folders.ts), а самый частый способ закрепиться в чужом ящике
 * не оставлял ничего.
 *
 * Способ этот — «копию всей почты на свой адрес». У нас пересылка не
 * отдельная настройка, а действие правила (`forwardTo`), которое уезжает
 * в файл Sieve как `redirect`. Тот, кто получил доступ к ящику на минуту,
 * заводил такое правило и уходил; почта продолжала течь к нему сама, а в
 * разделе «Вход и действия», заведённом ровно ради вопроса «не заходил ли
 * кто чужой», не было об этом ни строки.
 *
 * Поэтому в записи назван и адрес пересылки: «изменены фильтры» владельцу
 * ящика не говорит ничего — искать он будет адрес.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps, MailSession } from '../types.js';
import type { AccessRecordInput } from './access-record.js';
import { settingsUserRoutes } from './routes.js';
import type { SettingsService } from './service.js';
import type { FilterRule } from './types.js';

const EMAIL = 'vladelec@nasha.ru';

/** Правило, каким его вернёт база после записи. */
function savedRule(name: string, id = 7): FilterRule {
  return {
    id,
    name,
    position: 0,
    enabled: true,
    auto: false,
    matchMode: 'all',
    conditions: [],
    actions: {
      folder: null,
      markRead: false,
      flag: false,
      labels: [],
      deleteMessage: null,
      forwardTo: [],
      autoReply: null,
      applyToSpam: false,
      continueFiltering: true,
    },
  };
}

interface Harness {
  app: FastifyInstance;
  records: AccessRecordInput[];
}

async function harness(): Promise<Harness> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  registerErrorHandling(app);

  const records: AccessRecordInput[] = [];

  const db = {
    listFilters: async (): Promise<FilterRule[]> => [],
    createFilter: async (_email: string, rule: { name: string }): Promise<FilterRule> =>
      savedRule(rule.name),
    getFilter: async (): Promise<FilterRule> => savedRule('Счета в «Бухгалтерию»'),
    updateFilter: async (): Promise<FilterRule> => savedRule('Счета в «Бухгалтерию»'),
    deleteFilter: async (): Promise<boolean> => true,
  };

  app.decorate('deps', {
    // Список папок правилу не нужен: проверяется запись в историю, а не
    // перевод идентификаторов папок в пути IMAP.
    pool: { withClient: async () => [] },
    accessLog: {
      record: (input: AccessRecordInput) => {
        records.push(input);
      },
    },
    logger: { warn: () => undefined, info: () => undefined },
  } as unknown as AppDeps);

  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async (request: { mailSession: MailSession | null }) => {
    request.mailSession = { id: 'sess', email: EMAIL, password: 'parol' };
  });

  const service = {
    requireDb: () => db,
    syncSieve: async () => ({ ok: true, written: true, error: '', activeRules: 1 }),
    config: { FILTER_APPLY_MAX_MESSAGES: 100 },
  } as unknown as SettingsService;

  await app.register(async (scope) => settingsUserRoutes(scope, service), {
    prefix: '/api/settings',
  });
  await app.ready();
  return { app, records };
}

/** Правило «копию всей почты — на сторонний адрес». */
const forwardingRule = {
  id: '',
  enabled: true,
  auto: false,
  conditions: [],
  actions: {
    moveToFolderId: null,
    markRead: false,
    markFlagged: false,
    applyToExistingFolderIds: [],
    forwardTo: 'chuzhoy@example.com',
    autoReply: null,
    continueOtherFilters: true,
    applyToSpam: false,
  },
};

void test('заведённая пересылка попадает в историю ящика — вместе с адресом', async () => {
  const h = await harness();

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/settings/filters',
    payload: forwardingRule,
  });
  assert.equal(res.statusCode, 200, res.body);

  const record = h.records.find((r) => r.kind === 'filters');
  assert.ok(record, 'правка фильтров обязана оставлять след — иначе захват ящика не виден');
  assert.equal(record.accountEmail, EMAIL);
  assert.match(
    record.detail,
    /chuzhoy@example\.com/u,
    'без адреса владельцу нечего искать: «изменены фильтры» не говорит ничего',
  );
});

void test('изменение правила пишется так же, как создание', async () => {
  const h = await harness();
  const res = await h.app.inject({
    method: 'PUT',
    url: '/api/settings/filters/7',
    payload: forwardingRule,
  });
  assert.equal(res.statusCode, 200, res.body);

  const record = h.records.find((r) => r.kind === 'filters');
  assert.ok(record);
  assert.match(record.detail, /chuzhoy@example\.com/u);
});

void test('удаление правила тоже оставляет след, и правило названо по имени', async () => {
  const h = await harness();
  const res = await h.app.inject({ method: 'DELETE', url: '/api/settings/filters/7' });
  assert.equal(res.statusCode, 200, res.body);

  const record = h.records.find((r) => r.kind === 'filters');
  assert.ok(record);
  assert.match(record.detail, /Бухгалтерию/u);
});
