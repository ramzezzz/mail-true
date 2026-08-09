/**
 * Настройки чужого ящика из админки и групповая установка подписей.
 *
 * Каждая проверка здесь закрывает конкретное требование или конкретный
 * способ навредить чужому ящику, и падает без правки — это проверялось
 * откатом:
 *
 *   1. Настроек чужого ящика из админки не было вовсе: подписи и фильтры
 *      правились только самим владельцем.
 *   2. Чтение чужих настроек и их изменение — разные права. Роль
 *      «только чтение» обязана уметь посмотреть, почему у человека письма
 *      уезжают не в ту папку, и не уметь эту папку поменять.
 *   3. Любое действие над чужим ящиком обязано попадать в журнал аудита
 *      с указанием, ЧЕЙ ящик и что изменено.
 *   4. Правка фильтров обязана переписывать файл Sieve. Изменение только
 *      в базе означает «правило есть, а не работает».
 *   5. Групповая установка подписи не имеет права молча затирать чужую
 *      подпись: сколько их будет затёрто, видно ДО применения.
 *   6. Опечатка в подстановке («{{долность}}») не должна разъезжаться
 *      по живым ящикам.
 *   7. Ящик без имени в карточке не должен получать подпись, начинающуюся
 *      с пустой строки.
 *
 * База настоящая не нужна: подделки помнят вызовы, а проверяется поведение
 * маршрута — что он вызвал, что ответил и чего НЕ сделал.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { registerErrorHandling } from '../http-errors.js';
import {
  defaultMailSettings,
  type FilterRule,
  type MailSettings,
  type Signature,
} from '../settings/types.js';
import type { SettingsService } from '../settings/service.js';
import { BrandingStore } from './branding.js';
import { loadAdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import { createImportBox } from './import-jobs.js';
import { QueueAgent } from './queue-agent.js';
import { MemoryAdminSessionStore } from './session.js';
import { adminUserSettingsRoutes } from './routes/user-settings.js';
import type { AdminContext } from './types.js';

const SECRET = 'test-secret-0123456789-0123456789';
const logger = pino({ level: 'silent' });

/* ------------------------------------------------------------------ */
/* Подделки                                                             */
/* ------------------------------------------------------------------ */

interface FakeUser {
  id: number;
  email: string;
  display_name: string | null;
  domain: string;
  domain_id: number;
  active: boolean;
  quota_bytes: number;
  alias_count: number;
  created_at: Date;
  updated_at: Date;
}

function user(id: number, email: string, displayName: string | null): FakeUser {
  return {
    id,
    email,
    display_name: displayName,
    domain: email.slice(email.indexOf('@') + 1),
    domain_id: 1,
    active: true,
    quota_bytes: 0,
    alias_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

class FakeAdminDb {
  role = 'owner';
  users = new Map<number, FakeUser>();
  audits: Array<Record<string, unknown>> = [];

  async findAdminById(id: number): Promise<Record<string, unknown>> {
    return { id, login: 'osmotr', role: this.role, active: true, display_name: null };
  }
  async writeAudit(record: Record<string, unknown>): Promise<void> {
    this.audits.push(record);
  }
  async findMailUserById(id: number): Promise<FakeUser | null> {
    return this.users.get(id) ?? null;
  }
  async listMailUsers(filters: {
    domainId?: number | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: FakeUser[]; total: number }> {
    const rows = [...this.users.values()].filter(
      (u) => filters.domainId === undefined || u.domain_id === filters.domainId,
    );
    return { rows, total: rows.length };
  }

  /** Записи журнала по действию — так проверки читаются глазами. */
  auditsOf(action: string): Array<Record<string, unknown>> {
    return this.audits.filter((a) => a.action === action);
  }
}

/** Подделка базы настроек: держит подписи и фильтры в памяти. */
class FakeSettingsDb {
  settings = new Map<string, MailSettings>();
  signatures = new Map<string, Signature[]>();
  filters = new Map<string, FilterRule[]>();
  #nextId = 1;

  #key(email: string): string {
    return email.toLowerCase();
  }

  async getSettings(email: string): Promise<MailSettings> {
    return this.settings.get(this.#key(email)) ?? defaultMailSettings(this.#key(email));
  }
  async saveSettings(email: string, patch: Record<string, unknown>): Promise<MailSettings> {
    const current = await this.getSettings(email);
    const next: MailSettings = { ...current };
    if (patch.senderName !== undefined) next.senderName = patch.senderName as string | null;
    if (patch.autoReply) {
      next.autoReply = { ...next.autoReply, ...(patch.autoReply as Record<string, unknown>) };
    }
    this.settings.set(this.#key(email), next);
    return next;
  }

  async listSignatures(email: string): Promise<Signature[]> {
    return [...(this.signatures.get(this.#key(email)) ?? [])];
  }
  async createSignature(
    email: string,
    input: { name: string; bodyHtml: string; isDefault: boolean },
  ): Promise<Signature[]> {
    const list = this.signatures.get(this.#key(email)) ?? [];
    if (input.isDefault) for (const s of list) s.isDefault = false;
    list.push({
      id: this.#nextId++,
      name: input.name,
      bodyHtml: input.bodyHtml,
      isDefault: input.isDefault,
      position: list.length,
    });
    this.signatures.set(this.#key(email), list);
    return [...list];
  }
  async updateSignature(
    email: string,
    id: number,
    patch: Record<string, unknown>,
  ): Promise<Signature[]> {
    const list = this.signatures.get(this.#key(email)) ?? [];
    const found = list.find((s) => s.id === id);
    if (found) {
      if (patch.name !== undefined) found.name = patch.name as string;
      if (patch.bodyHtml !== undefined) found.bodyHtml = patch.bodyHtml as string;
      if (patch.isDefault === true) for (const s of list) s.isDefault = s.id === id;
      if (patch.position !== undefined) found.position = patch.position as number;
    }
    return [...list];
  }
  /** Замена всех подписей одной — как в настоящем хранилище, одной операцией. */
  async replaceSignatures(
    email: string,
    input: { name: string; bodyHtml: string; isDefault: boolean },
  ): Promise<Signature[]> {
    const list: Signature[] = [
      {
        id: this.#nextId++,
        name: input.name,
        bodyHtml: input.bodyHtml,
        isDefault: input.isDefault,
        position: 0,
      },
    ];
    this.signatures.set(this.#key(email), list);
    return [...list];
  }

  async deleteSignature(email: string, id: number): Promise<Signature[]> {
    const list = (this.signatures.get(this.#key(email)) ?? []).filter((s) => s.id !== id);
    this.signatures.set(this.#key(email), list);
    return [...list];
  }

  async listFilters(email: string): Promise<FilterRule[]> {
    return [...(this.filters.get(this.#key(email)) ?? [])];
  }
  async getFilter(email: string, id: number): Promise<FilterRule | null> {
    return (this.filters.get(this.#key(email)) ?? []).find((r) => r.id === id) ?? null;
  }
  async createFilter(email: string, input: Record<string, unknown>): Promise<FilterRule> {
    const list = this.filters.get(this.#key(email)) ?? [];
    const rule = { id: this.#nextId++, position: list.length, ...input } as FilterRule;
    list.push(rule);
    this.filters.set(this.#key(email), list);
    return rule;
  }
  async updateFilter(
    email: string,
    id: number,
    patch: Record<string, unknown>,
  ): Promise<FilterRule | null> {
    const rule = await this.getFilter(email, id);
    if (!rule) return null;
    Object.assign(rule, patch);
    return rule;
  }
  async deleteFilter(email: string, id: number): Promise<boolean> {
    const list = this.filters.get(this.#key(email)) ?? [];
    const next = list.filter((r) => r.id !== id);
    this.filters.set(this.#key(email), next);
    return next.length !== list.length;
  }
  async reorderFilters(email: string, ids: number[]): Promise<FilterRule[]> {
    const list = this.filters.get(this.#key(email)) ?? [];
    list.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return [...list];
  }
}

/** Подделка сервиса настроек: помнит, для каких ящиков переписан Sieve. */
class FakeSettingsService {
  readonly synced: string[] = [];
  constructor(readonly db: FakeSettingsDb) {}
  requireDb(): FakeSettingsDb {
    return this.db;
  }
  async syncSieve(email: string): Promise<Record<string, unknown>> {
    this.synced.push(email);
    return { transport: 'off', path: '/dev/null', activeRules: 0, ok: true, error: '' };
  }
  async readSieve(): Promise<string | null> {
    return null;
  }
  get store(): { transport: string; activePath: (email: string) => string } {
    return { transport: 'off', activePath: () => '/dev/null' };
  }
}

interface Harness {
  app: FastifyInstance;
  db: FakeAdminDb;
  settingsDb: FakeSettingsDb;
  service: FakeSettingsService;
  cookie: string;
}

async function harness(options?: { role?: string }): Promise<Harness> {
  const app = Fastify({ loggerInstance: logger }) as unknown as FastifyInstance;
  await app.register(cookiePlugin, { secret: SECRET });
  registerErrorHandling(app);

  const db = new FakeAdminDb();
  db.role = options?.role ?? 'owner';
  const sessions = new MemoryAdminSessionStore();
  const config = loadAdminConfig({
    ADMIN_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: SECRET,
  } as NodeJS.ProcessEnv);

  // Служебный доступ намеренно не настроен: папки нужны только для
  // перевода «идентификатор папки -> путь», а проверяем мы права,
  // журнал и подписи. Маршрут обязан работать и без Dovecot.
  const mailbox = { configured: false };

  const ctx: AdminContext = {
    config,
    db: db as unknown as AdminDb,
    sessions,
    mailbox: mailbox as unknown as AdminContext['mailbox'],
    queueAgent: new QueueAgent({ baseUrl: '', token: '', logger }),
    // Оформление входа этим проверкам не нужно, но контекст обязан быть
    // полным: каталог указываем временный, ни один тест в него не пишет.
    branding: new BrandingStore('./data/branding-test-unused'),
    cookieSecure: false,
    importBox: createImportBox(SECRET),
  };

  app.decorate('adminCtx', ctx);
  app.decorateRequest('admin', null);

  const settingsDb = new FakeSettingsDb();
  const service = new FakeSettingsService(settingsDb);
  await adminUserSettingsRoutes(app, () => service as unknown as SettingsService);

  const sessionId = 'test-session';
  await sessions.set(
    sessionId,
    { adminId: 1, login: 'osmotr', role: db.role, createdAt: Date.now(), ip: '127.0.0.1' },
    3600,
  );
  const signed = app.signCookie(sessionId);
  return {
    app,
    db,
    settingsDb,
    service,
    cookie: `${config.ADMIN_SESSION_COOKIE_NAME}=${signed}`,
  };
}

/** Тело общих настроек в контракте интерфейса. */
function generalBody(over?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    senderName: 'Пётр Иванов',
    signatures: [{ id: '', name: 'Рабочая', text: 'С уважением, Пётр' }],
    defaultSignatureId: null,
    autoReply: { enabled: false, text: '', from: null, to: null },
    notifications: { browser: false, tabCounter: true },
    quoteOriginalOnReply: true,
    afterDelete: 'list',
    autoCollectContacts: true,
    ...over,
  };
}

/** Правило фильтрации в контракте интерфейса. */
const RULE_BODY = {
  id: '',
  enabled: true,
  conditions: [{ field: 'from', operator: 'contains', value: 'boss@mail.local' }],
  actions: {
    moveToFolderId: null,
    markRead: false,
    markFlagged: true,
    applyToExistingFolderIds: [],
    forwardTo: null,
    autoReply: null,
    continueOtherFilters: true,
    applyToSpam: false,
  },
};

/* ------------------------------------------------------------------ */
/* 1. Настройки чужого ящика доступны из админки                        */
/* ------------------------------------------------------------------ */

void test('админ видит подписи и фильтры чужого ящика теми же средствами, что и владелец', async () => {
  const h = await harness();
  h.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));
  await h.settingsDb.createSignature('demo@mail.local', {
    name: 'Личная',
    bodyHtml: 'Пока!',
    isDefault: true,
  });

  const response = await h.app.inject({
    method: 'GET',
    url: '/users/7/settings',
    headers: { cookie: h.cookie },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    mailbox: { email: string };
    general: {
      signatures: Array<{ id: string; name: string; text: string }>;
      defaultSignatureId: string | null;
    };
    filters: unknown[];
  }>();
  assert.equal(body.mailbox.email, 'demo@mail.local');
  assert.equal(body.general.signatures.length, 1);
  assert.equal(body.general.signatures[0]?.text, 'Пока!');
  // Контракт тот же, что у пользовательских настроек: подпись по умолчанию
  // приходит идентификатором, а не флажком внутри списка.
  assert.equal(body.general.defaultSignatureId, body.general.signatures[0]?.id);
  await h.app.close();
});

void test('несуществующий ящик — 404, а не пустые настройки', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'GET',
    url: '/users/999/settings',
    headers: { cookie: h.cookie },
  });
  assert.equal(response.statusCode, 404);
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 2. Чтение чужих настроек — не то же самое, что изменение             */
/* ------------------------------------------------------------------ */

void test('роль «только чтение» видит чужие настройки, но не может их менять', async () => {
  const h = await harness({ role: 'readonly' });
  h.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));

  const read = await h.app.inject({
    method: 'GET',
    url: '/users/7/settings',
    headers: { cookie: h.cookie },
  });
  assert.equal(read.statusCode, 200);

  const write = await h.app.inject({
    method: 'PUT',
    url: '/users/7/settings/general',
    headers: { cookie: h.cookie },
    payload: generalBody(),
  });
  assert.equal(write.statusCode, 403);
  // Настройки не тронуты ни на байт.
  assert.equal((await h.settingsDb.listSignatures('demo@mail.local')).length, 0);
  await h.app.close();
});

void test('групповая установка подписей доступна только владельцу панели', async () => {
  const manager = await harness({ role: 'user_manager' });
  manager.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));

  const denied = await manager.app.inject({
    method: 'POST',
    url: '/signatures/bulk/apply',
    headers: { cookie: manager.cookie },
    payload: { ids: [7], template: 'Привет', mode: 'append' },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal((await manager.settingsDb.listSignatures('demo@mail.local')).length, 0);
  await manager.app.close();

  const owner = await harness({ role: 'owner' });
  owner.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));
  const allowed = await owner.app.inject({
    method: 'POST',
    url: '/signatures/bulk/apply',
    headers: { cookie: owner.cookie },
    payload: { ids: [7], template: 'Привет', mode: 'append' },
  });
  assert.equal(allowed.statusCode, 200);
  await owner.app.close();
});

/* ------------------------------------------------------------------ */
/* 3. Журнал аудита                                                     */
/* ------------------------------------------------------------------ */

void test('просмотр чужих настроек попадает в журнал аудита с адресом ящика', async () => {
  const h = await harness();
  h.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));

  await h.app.inject({ method: 'GET', url: '/users/7/settings', headers: { cookie: h.cookie } });

  const records = h.db.auditsOf('usersettings.view');
  assert.equal(records.length, 1);
  assert.equal(records[0]?.targetLabel, 'demo@mail.local');
  assert.equal(records[0]?.targetType, 'settings');
  await h.app.close();
});

void test('изменение чужой подписи записывается в журнал вместе с текстом', async () => {
  const h = await harness();
  h.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));
  await h.settingsDb.createSignature('demo@mail.local', {
    name: 'Старая',
    bodyHtml: 'Было так',
    isDefault: true,
  });

  const response = await h.app.inject({
    method: 'PUT',
    url: '/users/7/settings/general',
    headers: { cookie: h.cookie },
    payload: generalBody({
      signatures: [{ id: '', name: 'Новая', text: 'Стало так' }],
    }),
  });
  assert.equal(response.statusCode, 200);

  const records = h.db.auditsOf('usersettings.general');
  assert.equal(records.length, 1);
  assert.equal(records[0]?.targetLabel, 'demo@mail.local');
  const oldValue = JSON.stringify(records[0]?.oldValue);
  const newValue = JSON.stringify(records[0]?.newValue);
  // В журнале видно и что было, и что стало: «изменены подписи» без самих
  // подписей не отвечает на вопрос владельца ящика.
  assert.match(oldValue, /Было так/);
  assert.match(newValue, /Стало так/);
  await h.app.close();
});

void test('каждое действие над фильтром чужого ящика попадает в журнал', async () => {
  const h = await harness();
  h.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));

  const created = await h.app.inject({
    method: 'POST',
    url: '/users/7/settings/filters',
    headers: { cookie: h.cookie },
    payload: RULE_BODY,
  });
  assert.equal(created.statusCode, 200);
  const ruleId = created.json<{ id: string }>().id;

  const removed = await h.app.inject({
    method: 'DELETE',
    url: `/users/7/settings/filters/${ruleId}`,
    headers: { cookie: h.cookie },
  });
  assert.equal(removed.statusCode, 200);

  assert.equal(h.db.auditsOf('usersettings.filter.create').length, 1);
  assert.equal(h.db.auditsOf('usersettings.filter.delete').length, 1);
  assert.equal(h.db.auditsOf('usersettings.filter.create')[0]?.targetLabel, 'demo@mail.local');
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 4. Правка настроек переписывает файл Sieve                           */
/* ------------------------------------------------------------------ */

void test('созданный админом фильтр переписывает личный файл правил ящика', async () => {
  const h = await harness();
  h.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));

  await h.app.inject({
    method: 'POST',
    url: '/users/7/settings/filters',
    headers: { cookie: h.cookie },
    payload: RULE_BODY,
  });

  // Без этого правило лежало бы в базе, а Dovecot фильтровал бы по старому
  // файлу: «правило есть, а не работает».
  assert.deepEqual(h.service.synced, ['demo@mail.local']);
  await h.app.close();
});

void test('включённый админом автоответчик тоже переписывает файл правил', async () => {
  const h = await harness();
  h.db.users.set(7, user(7, 'demo@mail.local', 'Демо Демов'));

  await h.app.inject({
    method: 'PUT',
    url: '/users/7/settings/general',
    headers: { cookie: h.cookie },
    payload: generalBody({
      autoReply: { enabled: true, text: 'В отпуске до 1 сентября', from: null, to: null },
    }),
  });

  assert.deepEqual(h.service.synced, ['demo@mail.local']);
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 5. Групповая установка подписей: предпросмотр честен                 */
/* ------------------------------------------------------------------ */

void test('предпросмотр считает, скольким применится и сколько чужих подписей будет затёрто', async () => {
  const h = await harness();
  h.db.users.set(1, user(1, 'a@mail.local', 'Анна Аникина'));
  h.db.users.set(2, user(2, 'b@mail.local', 'Борис Борисов'));
  h.db.users.set(3, user(3, 'c@mail.local', 'Вера Верина'));
  await h.settingsDb.createSignature('b@mail.local', {
    name: 'Своя',
    bodyHtml: 'Не трогать',
    isDefault: true,
  });
  await h.settingsDb.createSignature('b@mail.local', {
    name: 'Вторая',
    bodyHtml: 'И эту тоже',
    isDefault: false,
  });

  const response = await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/preview',
    headers: { cookie: h.cookie },
    payload: {
      ids: [1, 2, 3],
      template: '{{имя}}\n{{должность}}\n{{адрес}}',
      extras: { должность: 'Менеджер' },
      mode: 'replace',
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    total: number;
    willAdd: number;
    willReplace: number;
    signaturesReplaced: number;
    withExistingSignatures: number;
    sample: { email: string; text: string } | null;
  }>();
  assert.equal(body.total, 3);
  assert.equal(body.willAdd, 2);
  assert.equal(body.willReplace, 1);
  // Обе подписи Бориса будут уничтожены — и это сказано числом до применения.
  assert.equal(body.signaturesReplaced, 2);
  assert.equal(body.withExistingSignatures, 1);

  // Предпросмотр — на живом человеке и с уже подставленными значениями.
  assert.ok(body.sample);
  assert.match(body.sample.text, /Менеджер/);
  assert.match(body.sample.text, /@mail\.local/);

  // И ни одной записи в базу: предпросмотр ничего не применяет.
  assert.equal((await h.settingsDb.listSignatures('a@mail.local')).length, 0);
  assert.equal((await h.settingsDb.listSignatures('b@mail.local')).length, 2);
  await h.app.close();
});

void test('предпросмотр показывает шаблон на выбранном человеке', async () => {
  const h = await harness();
  h.db.users.set(1, user(1, 'a@mail.local', 'Анна Аникина'));
  h.db.users.set(2, user(2, 'b@mail.local', 'Борис Борисов'));

  const response = await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/preview',
    headers: { cookie: h.cookie },
    payload: {
      ids: [1, 2],
      template: '{{имя}} <{{адрес}}>',
      mode: 'append',
      previewEmail: 'b@mail.local',
    },
  });

  const body = response.json<{ sample: { email: string; text: string } }>();
  assert.equal(body.sample.email, 'b@mail.local');
  assert.equal(body.sample.text, 'Борис Борисов <b@mail.local>');
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 6. Опечатка в подстановке не уходит в живые ящики                    */
/* ------------------------------------------------------------------ */

void test('неизвестная подстановка отклоняется до единой записи в базу', async () => {
  const h = await harness();
  h.db.users.set(1, user(1, 'a@mail.local', 'Анна Аникина'));

  const response = await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/apply',
    headers: { cookie: h.cookie },
    payload: { ids: [1], template: '{{имя}}, {{долность}}', mode: 'append' },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json<{ message: string }>().message, /долность/);
  assert.equal((await h.settingsDb.listSignatures('a@mail.local')).length, 0);
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 7. Что происходит с уже существующими подписями                      */
/* ------------------------------------------------------------------ */

void test('режим «добавить» не трогает существующую подпись', async () => {
  const h = await harness();
  h.db.users.set(1, user(1, 'a@mail.local', 'Анна Аникина'));
  await h.settingsDb.createSignature('a@mail.local', {
    name: 'Своя',
    bodyHtml: 'Не трогать',
    isDefault: true,
  });

  const response = await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/apply',
    headers: { cookie: h.cookie },
    payload: { ids: [1], template: 'Корпоративная', mode: 'append', makeDefault: false },
  });
  assert.equal(response.statusCode, 200);

  const list = await h.settingsDb.listSignatures('a@mail.local');
  assert.equal(list.length, 2);
  assert.ok(list.some((s) => s.bodyHtml === 'Не трогать'));
  await h.app.close();
});

void test('режим «пропустить» не создаёт подпись тем, у кого она уже есть', async () => {
  const h = await harness();
  h.db.users.set(1, user(1, 'a@mail.local', 'Анна Аникина'));
  h.db.users.set(2, user(2, 'b@mail.local', 'Борис Борисов'));
  await h.settingsDb.createSignature('a@mail.local', {
    name: 'Своя',
    bodyHtml: 'Не трогать',
    isDefault: true,
  });

  const response = await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/apply',
    headers: { cookie: h.cookie },
    payload: { ids: [1, 2], template: 'Корпоративная', mode: 'skip-existing' },
  });

  const body = response.json<{ applied: number; willSkipExisting: number }>();
  assert.equal(body.applied, 1);
  assert.equal(body.willSkipExisting, 1);
  assert.deepEqual(
    (await h.settingsDb.listSignatures('a@mail.local')).map((s) => s.bodyHtml),
    ['Не трогать'],
  );
  assert.deepEqual(
    (await h.settingsDb.listSignatures('b@mail.local')).map((s) => s.bodyHtml),
    ['Корпоративная'],
  );
  await h.app.close();
});

void test('режим «заменить» уносит старые подписи и пишет об этом в журнал по каждому ящику', async () => {
  const h = await harness();
  h.db.users.set(1, user(1, 'a@mail.local', 'Анна Аникина'));
  await h.settingsDb.createSignature('a@mail.local', {
    name: 'Своя',
    bodyHtml: 'Было так',
    isDefault: true,
  });

  await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/apply',
    headers: { cookie: h.cookie },
    payload: { ids: [1], template: 'Стало так', mode: 'replace' },
  });

  assert.deepEqual(
    (await h.settingsDb.listSignatures('a@mail.local')).map((s) => s.bodyHtml),
    ['Стало так'],
  );

  // Запись на КАЖДЫЙ ящик, а не одна на всю рассылку: иначе владелец ящика
  // не найдёт в журнале, кто и когда затёр его подпись.
  const perMailbox = h.db.auditsOf('usersettings.signature.bulk');
  assert.equal(perMailbox.length, 1);
  assert.equal(perMailbox[0]?.targetLabel, 'a@mail.local');
  assert.match(JSON.stringify(perMailbox[0]?.oldValue), /Было так/);
  assert.match(JSON.stringify(perMailbox[0]?.newValue), /Стало так/);
  // И одна общая запись об операции целиком.
  assert.equal(h.db.auditsOf('usersettings.signature.bulk.run').length, 1);
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 8. Ящик без имени не получает кривую подпись                         */
/* ------------------------------------------------------------------ */

void test('ящик без имени в карточке пропускается, а не получает подпись с пустой строкой', async () => {
  const h = await harness();
  h.db.users.set(1, user(1, 'a@mail.local', 'Анна Аникина'));
  h.db.users.set(2, user(2, 'noname@mail.local', null));

  const response = await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/apply',
    headers: { cookie: h.cookie },
    payload: { ids: [1, 2], template: '{{имя}}\nМенеджер', mode: 'append' },
  });

  const body = response.json<{ applied: number; willSkipIncomplete: number }>();
  assert.equal(body.applied, 1);
  assert.equal(body.willSkipIncomplete, 1);
  assert.equal((await h.settingsDb.listSignatures('noname@mail.local')).length, 0);
  assert.deepEqual(
    (await h.settingsDb.listSignatures('a@mail.local')).map((s) => s.bodyHtml),
    ['Анна Аникина\nМенеджер'],
  );
  await h.app.close();
});

/* ------------------------------------------------------------------ */
/* 9. Выбор всех ящиков домена                                          */
/* ------------------------------------------------------------------ */

void test('вместо перечисления ящиков можно выбрать весь домен', async () => {
  const h = await harness();
  h.db.users.set(1, user(1, 'a@mail.local', 'Анна Аникина'));
  h.db.users.set(2, user(2, 'b@mail.local', 'Борис Борисов'));

  const response = await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/preview',
    headers: { cookie: h.cookie },
    payload: { domainId: 1, template: '{{имя}}', mode: 'append' },
  });

  assert.equal(response.json<{ total: number }>().total, 2);
  await h.app.close();
});

void test('без выбранных ящиков и без домена операция отклоняется', async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: 'POST',
    url: '/signatures/bulk/preview',
    headers: { cookie: h.cookie },
    payload: { template: '{{имя}}', mode: 'append' },
  });
  assert.equal(response.statusCode, 400);
  await h.app.close();
});
