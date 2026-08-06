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
import { adminBackupRoutes } from './routes/backup.js';
import { adminBrandingRoutes } from './routes/branding.js';
import { adminSenderLogoRoutes } from '../logos/admin.js';
import { BrandingStore } from './branding.js';
import { adminAuthRoutes } from './routes/auth.js';
import { adminDomainRoutes } from './routes/domains.js';
import { adminMailboxRoutes } from './routes/mailbox.js';
import { adminOverviewRoutes } from './routes/overview.js';
import { adminQueueRoutes } from './routes/queue.js';
import { adminLogRoutes } from './routes/logs.js';
import { QueueAgent } from './queue-agent.js';
import { FlowCollector } from './flow-collector.js';
import { FlowStore } from './flow-store.js';
import { MetricsCollector } from './metrics-collector.js';
import { MetricsStore } from './metrics-store.js';
import { adminUserRoutes } from './routes/users.js';
import { adminUserSettingsRoutes } from './routes/user-settings.js';
import { mailboxAccessSelfRoutes } from './routes/self-access.js';
import { aiAdminRoutes } from '../ai/admin.js';
import { AdminJanitor } from './janitor.js';
import { createImportBox } from './import-jobs.js';
import { adminMigrateRoutes } from './routes/migrate.js';
import { MigrationRunner } from './migrate-runner.js';
import type { DestSettings } from './migrate-jobs.js';
import { SecretBox } from '../crypto.js';
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

  // Очередь Postfix — через посредника в его контейнере. Сокет Docker
  // серверу приложения не даётся: он означает права root на всей машине.
  const queueAgent = new QueueAgent({
    baseUrl: adminConfig.MAIL_QUEUE_AGENT_URL,
    token: adminConfig.QUEUE_AGENT_TOKEN,
    logger,
  });
  if (!queueAgent.configured) {
    logger.warn(
      'Посредник к очереди Postfix не настроен (MAIL_QUEUE_AGENT_URL/QUEUE_AGENT_TOKEN): ' +
        'раздел «Очередь» будет отвечать 503 с объяснением.',
    );
  }

  // Своё оформление входа. Каталог создаём сразу: логотип отдаётся
  // неаутентифицированным на странице входа, и «каталога ещё нет» не
  // должно всплывать первым же запросом после установки.
  const branding = new BrandingStore(adminConfig.BRANDING_DIR);
  branding
    .init()
    .catch((err: unknown) =>
      logger.error(
        { err },
        `Каталог оформления ${adminConfig.BRANDING_DIR} недоступен: свой логотип загрузить не выйдет`,
      ),
    );

  // Показатели сервера для дашборда. Снимает по расписанию: загрузку
  // процессора нельзя измерить одним обращением (см. metrics-host.ts),
  // а обход каталогов и опрос очереди слишком дороги, чтобы делать их на
  // каждое открытие панели.
  const metrics = new MetricsCollector({
    db,
    logger,
    queueAgent,
    mailRoot: adminConfig.ADMIN_MAIL_ROOT,
    indexRoot: adminConfig.ADMIN_MAIL_INDEX_ROOT,
    logRoot: adminConfig.MAIL_LOG_DIR,
    intervalSeconds: adminConfig.MAIL_METRICS_INTERVAL_SECONDS,
    retentionDays: adminConfig.MAIL_METRICS_RETENTION_DAYS,
    maxRows: adminConfig.MAIL_METRICS_MAX_ROWS,
  });

  /*
   * Перенос почты с чужого сервера.
   *
   * Приёмник — всегда наш сервер, и входим мы в него служебным доступом
   * Dovecot: тем же, которым панель открывает чужие ящики. Поэтому паролей
   * ящиков-приёмников перенос не спрашивает ни одного — их просто нет
   * в обороте (подробности в admin/migrate-jobs.ts).
   */
  const migrationDest: DestSettings = {
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    secure: config.IMAP_SECURE,
    allowInsecureTls: !config.TLS_REJECT_UNAUTHORIZED,
    masterUser: adminConfig.DOVECOT_MASTER_USER,
    masterPassword: adminConfig.DOVECOT_MASTER_PASSWORD,
    masterSeparator: adminConfig.DOVECOT_MASTER_SEPARATOR,
  };
  // Пароли исходных ящиков шифруются тем же SecretBox, что и пароль
  // в почтовой сессии. Нет секрета — нет и переноса: чужие пароли
  // открытым текстом в базе не лежат ни при каких условиях.
  const migrationBox =
    adminConfig.importSecret === '' ? null : new SecretBox(adminConfig.importSecret);

  const migrationRunner = new MigrationRunner({
    db,
    logger,
    box: migrationBox,
    dest: migrationDest,
    stateConnectionString: adminConfig.databaseUrl,
    concurrency: adminConfig.MIGRATION_CONCURRENCY,
    maxHours: adminConfig.MIGRATION_MAX_HOURS,
  });

  const ctx: AdminContext = {
    config: adminConfig,
    db,
    sessions,
    mailbox,
    queueAgent,
    branding,
    metrics,
    cookieSecure: config.COOKIE_SECURE,
    importBox: createImportBox(adminConfig.importSecret),
    migrationBox,
    migrationDest,
    migrationRunner,
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

  // Сборщик истории доставки: разбирает журнал Postfix и складывает
  // события в базу. Другого источника обработанных писем не существует —
  // сам Postfix историю не хранит (см. flow-collector.ts).
  const flow = new FlowCollector({
    db,
    logger,
    logDir: adminConfig.MAIL_LOG_DIR,
    intervalSeconds: adminConfig.MAIL_FLOW_INTERVAL_SECONDS,
    retentionDays: adminConfig.MAIL_FLOW_RETENTION_DAYS,
    maxRows: adminConfig.MAIL_FLOW_MAX_ROWS,
  });
  new FlowStore(db)
    .schemaReady()
    .then((ready: boolean) => {
      if (!ready) {
        logger.error(
          'Таблиц истории доставки нет. Примените ' +
            'infra/postgres/migrations/0007_mail_flow.sql — до этого раздел ' +
            '«Почтовый поток» покажет только очередь, без обработанных писем.',
        );
        return;
      }
      flow.start();
    })
    .catch((err: unknown) =>
      logger.error({ err }, 'Не удалось проверить схему истории доставки'),
    );

  // Съёмка показателей. Запускается только при применённой миграции 0011_metrics.sql:
  // без таблицы каждый проход писал бы в журнал ошибку раз в минуту, а
  // дашборд всё равно не получил бы истории. Текущее состояние («прямо
  // сейчас») от базы не зависит и работает и без миграции — маршрут
  // ресурсов берёт его прямо у сборщика.
  new MetricsStore(db)
    .schemaReady()
    .then((ready: boolean) => {
      if (!ready) {
        logger.error(
          'Таблицы снимков показателей нет. Примените ' +
            'infra/postgres/migrations/0011_metrics.sql — до этого дашборд покажет ' +
            'состояние «прямо сейчас», но без графиков за прошедшие часы.',
        );
        // Один проход всё же делаем: он наполняет «прямо сейчас».
        void metrics.runOnce().catch(() => undefined);
        return;
      }
      metrics.start();
    })
    .catch((err: unknown) =>
      logger.error({ err }, 'Не удалось проверить схему снимков показателей'),
    );

  /*
   * Работник переноса. Запускается только при применённой миграции 0011:
   * без таблиц он раз в десять секунд писал бы в журнал ошибку, а заданий
   * всё равно бы не было. И главное, ради чего он запускается ЗДЕСЬ, при
   * старте процесса: задания, которые вёл убитый перезапуском контейнер,
   * подхватываются и продолжаются с того места, где их застал перезапуск
   * (см. migrate-runner.ts).
   */
  db.migrationSchemaReady()
    .then((ready: boolean) => {
      if (!ready) {
        logger.warn(
          'Таблиц переноса почты нет. Примените ' +
            'infra/postgres/migrations/0013_migration_jobs.sql — до этого раздел ' +
            '«Перенос почты» будет отвечать 503 с объяснением.',
        );
        return;
      }
      if (migrationBox === null) {
        logger.warn(
          'Не задан ADMIN_SESSION_SECRET/SESSION_SECRET: пароли исходных ящиков хранить ' +
            'зашифрованными нечем, раздел «Перенос почты» работать не будет.',
        );
        return;
      }
      migrationRunner.start();
    })
    .catch((err: unknown) => logger.error({ err }, 'Не удалось проверить схему переноса почты'));

  app.addHook('onClose', async () => {
    janitor.stop();
    flow.stop();
    metrics.stop();
    // Сначала попросить перенос остановиться, потом ДОЖДАТЬСЯ, пока он
    // отпустит свои задания, и только потом закрывать базу: иначе запись
    // «я ничей» не проходит, и задание висит с биением мертвеца, пока не
    // истечёт срок молчания.
    migrationRunner.stop();
    await migrationRunner.drain();
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
      // Настройки чужого ящика (подписи, фильтры, автоответчик) и групповая
      // установка подписей по шаблону. Сервис настроек берётся ленивo:
      // settingsRoutes(app) выполняется ПОСЛЕ админки (см. src/app.ts),
      // и на момент подключения этих маршрутов его ещё не существует.
      await adminUserSettingsRoutes(scope, () => app.settingsService);
      await adminAliasRoutes(scope);
      await adminDomainRoutes(scope);
      await adminAuditRoutes(scope);
      await adminMailboxRoutes(scope);
      // Очередь писем и история обработанных, журналы служб по уровням
      await adminQueueRoutes(scope);
      await adminLogRoutes(scope);
      // Своё оформление входа (OEM). Два его маршрута ОТКРЫТЫЕ: логотип
      // показывается тому, кто ещё не вошёл. Живут здесь, а не в почтовом
      // API, потому что на имени хоста админки nginx пробрасывает только
      // /api/admin/ — см. пояснение в routes/branding.ts.
      await adminBrandingRoutes(scope);
      // Логотипы доменов отправителей: список, ручная картинка, запрет.
      // Сервис берётся ленивo по той же причине, что и настройки выше:
      // senderLogosRoutes(app) выполняется ПОСЛЕ админки (см. src/app.ts).
      await adminSenderLogoRoutes(scope, () => app.senderLogos);
      // Резервная копия НАСТРОЕК (не писем: письма — install/backup.sh)
      await adminBackupRoutes(scope);
      // Перенос почты с чужого сервера (Kerio Connect и прочие). Логика
      // переноса — в packages/migrate, здесь только задания и их показ.
      await adminMigrateRoutes(scope);
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
export * from './mail-log.js';
export * from './log-files.js';
export * from './queue-agent.js';
export * from './flow-store.js';
export * from './metrics-host.js';
export * from './metrics-disk.js';
export * from './metrics-store.js';
export * from './metrics-tls.js';
export { MetricsCollector } from './metrics-collector.js';
export * from './branding.js';
export * from './branding-image.js';
export * from './backup-format.js';
export * from './backup-store.js';
export { FlowCollector } from './flow-collector.js';
export { createLogStreams } from './app-log.js';
