/**
 * Регистрация админки в приложении. Единственная точка соприкосновения
 * с остальным API — вызов adminRoutes(app) в src/app.ts.
 *
 * Админка самодостаточна: своя конфигурация, своё подключение к Postgres,
 * своё хранилище сессий, свои cookie. Если Postgres не настроен, почтовый
 * API продолжает работать, а админские маршруты честно отвечают 503.
 */
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { loadAdminConfig } from './config.js';
import { AdminDb } from './db.js';
import { AdminUnavailableError } from './errors.js';
import { MailboxMasterAccess } from './mailbox.js';
import {
  MemoryAdminSessionStore,
  RedisAdminSessionStore,
  type AdminSessionStore,
} from './session.js';
import { adminAliasRoutes } from './routes/aliases.js';
import { adminAuditRoutes } from './routes/audit.js';
import { adminAuthRoutes } from './routes/auth.js';
import { adminDomainRoutes } from './routes/domains.js';
import { adminMailboxRoutes } from './routes/mailbox.js';
import { adminOverviewRoutes } from './routes/overview.js';
import { adminUserRoutes } from './routes/users.js';
import { mailboxAccessSelfRoutes } from './routes/self-access.js';
import { aiAdminRoutes } from '../ai/admin.js';
import { AdminJanitor } from './janitor.js';
import { createImportBox } from './import-jobs.js';
import type { AdminContext } from './types.js';

/** Подключает админские маршруты под префиксом /api/admin. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { config, logger } = app.deps;
  const adminConfig = loadAdminConfig();

  if (!adminConfig.databaseUrl) {
    logger.warn(
      'Админка отключена: не задан ADMIN_DATABASE_URL/DATABASE_URL. ' +
        'Маршруты /api/admin/* будут отвечать 503.',
    );
    await app.register(
      async (scope) => {
        scope.all('/*', async () => {
          throw new AdminUnavailableError(
            'Админка не настроена: задайте ADMIN_DATABASE_URL и примените миграцию 0003_admin.sql',
          );
        });
      },
      { prefix: '/api/admin' },
    );
    return;
  }

  const db = new AdminDb({ connectionString: adminConfig.databaseUrl, logger });

  // Postgres в пробу состояния кладёт админка: подключение здесь, и
  // заводить второе ради проверки незачем. База критична не только для
  // админки — по ней Dovecot проверяет пароли, то есть без неё в почту
  // не войдёт никто.
  app.health.register({
    id: 'postgres',
    title: 'Postgres',
    critical: true,
    probe: async () => {
      await db.ping();
      return { ok: true, detail: 'Отвечает; учётные данные и настройки читаются' };
    },
  });

  // Сессии админки живут отдельно от почтовых, но в том же Redis
  let redis: Redis | null = null;
  let sessions: AdminSessionStore;
  if (config.SESSION_STORE === 'redis') {
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis недоступен (админка)'));
    sessions = new RedisAdminSessionStore(redis);
  } else {
    sessions = new MemoryAdminSessionStore();
  }

  const mailbox = new MailboxMasterAccess({
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    secure: config.IMAP_SECURE,
    rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED,
    masterUser: adminConfig.DOVECOT_MASTER_USER,
    masterPassword: adminConfig.DOVECOT_MASTER_PASSWORD,
    separator: adminConfig.DOVECOT_MASTER_SEPARATOR,
    logger,
  });

  if (adminConfig.importSecret === '') {
    logger.warn(
      'Не задан ADMIN_SESSION_SECRET/SESSION_SECRET: сгенерированные при импорте пароли ' +
        'сохранять негде, они будут доступны только в ответе на запрос состояния задания.',
    );
  }

  const ctx: AdminContext = {
    config: adminConfig,
    db,
    sessions,
    mailbox,
    cookieSecure: config.COOKIE_SECURE,
    importBox: createImportBox(adminConfig.importSecret),
  };

  // Уборщик: карантин удалённых ящиков, брошенные сеансы входа в чужой
  // ящик, просроченные задания импорта (см. janitor.ts)
  const janitor = new AdminJanitor({
    db,
    logger,
    mailRoot: adminConfig.ADMIN_MAIL_ROOT,
    intervalSeconds: adminConfig.ADMIN_JANITOR_INTERVAL_SECONDS,
  });

  // Ранняя диагностика: скажем в лог, применена ли миграция
  db.adminSchemaReady()
    .then((ready) => {
      if (!ready) {
        logger.error(
          'Таблиц админки нет. Примените infra/postgres/migrations/0003_admin.sql ' +
            'к работающей базе — до этого админка работать не будет.',
        );
      } else if (!adminConfig.masterConfigured) {
        logger.warn(
          'Служебный доступ Dovecot не настроен: вход администратора в чужой ящик недоступен.',
        );
      }
    })
    .catch((err) => logger.error({ err }, 'Не удалось проверить схему админки'));

  janitor.start();

  app.addHook('onClose', async () => {
    janitor.stop();
    await db.close().catch(() => undefined);
    if (redis) redis.disconnect();
  });

  await app.register(
    async (scope) => {
      scope.decorate('adminCtx', ctx);
      scope.decorateRequest('admin', null);
      await adminAuthRoutes(scope);
      await adminOverviewRoutes(scope);
      await adminUserRoutes(scope);
      await adminAliasRoutes(scope);
      await adminDomainRoutes(scope);
      await adminAuditRoutes(scope);
      await adminMailboxRoutes(scope);
      // Раздел «Помощник ИИ»: настройки по домену, предел расходов, журнал.
      // Живёт в src/ai/, но регистрируется здесь — чтобы получить ту же
      // аутентификацию, те же роли и тот же аудит, что остальная админка.
      await aiAdminRoutes(scope, app.aiService);
    },
    { prefix: '/api/admin' },
  );

  // История административных входов для ВЛАДЕЛЬЦА ящика. Живёт в почтовом
  // API (почтовая сессия, почтовая cookie), а не в админке: спецификация
  // требует показывать эти входы владельцу, а он в админку не вхож.
  await app.register(
    async (scope) => {
      await mailboxAccessSelfRoutes(scope, ctx);
    },
    { prefix: '/api' },
  );
}

export { loadAdminConfig } from './config.js';
export { AdminDb } from './db.js';
export { AdminJanitor } from './janitor.js';
export * from './import-jobs.js';
export * from './mailbox-cleanup.js';
export * from './passwords.js';
export * from './permissions.js';
export * from './audit.js';
export * from './csv.js';
export * from './dns.js';
