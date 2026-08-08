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
import { adminMonitoringRoutes } from './routes/monitoring.js';
import { adminOverviewRoutes } from './routes/overview.js';
import { adminQueueRoutes } from './routes/queue.js';
import { adminSpamRoutes } from './routes/spam.js';
import { adminTlsRoutes } from './routes/tls.js';
import { RspamdClient } from './rspamd.js';
import { SpamCollector } from './spam-collector.js';
import { SpamStore } from './spam-store.js';
import { adminLogRoutes } from './routes/logs.js';
import { QueueAgent } from './queue-agent.js';
import { FlowCollector } from './flow-collector.js';
import { FlowStore } from './flow-store.js';
import { MetricsCollector } from './metrics-collector.js';
import { MetricsStore } from './metrics-store.js';
import { adminServerSettingsRoutes } from './routes/server-settings.js';
import { adminRestartRoutes } from './routes/restart.js';
import { RestartStore } from './restart-store.js';
import { SelfRestart } from './self-restart.js';
import { ServiceAgent } from './service-agent.js';
import { retentionReader, ServerSettings } from './server-settings.js';
import { adminUserRoutes } from './routes/users.js';
import { adminUserSettingsRoutes } from './routes/user-settings.js';
import { mailboxAccessSelfRoutes } from './routes/self-access.js';
import { aiAdminRoutes } from '../ai/admin.js';
import { AdminJanitor } from './janitor.js';
import { createImportBox } from './import-jobs.js';
import { adminMigrateRoutes } from './routes/migrate.js';
import { MigrationRunner } from './migrate-runner.js';
import { adminDomainChangeRoutes } from './routes/domain-change.js';
import { DomainChangeRunner } from './domain-change-runner.js';
import { domainChangeSchemaReady } from './domain-change-jobs.js';
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

  /*
   * Настройки сервера из базы. Живут рядом с админской базой, потому что
   * меняются в панели и правами панели же и защищены.
   *
   * Кэш на пять секунд — плата за то, чтобы «поменял и сразу действует»
   * не превращалось в запрос к Postgres на каждое создание ящика и каждый
   * вход в панель. Своя запись сбрасывает кэш немедленно, поэтому человек
   * никогда не видит собственное изменение с опозданием; пять секунд —
   * это только про ВТОРОЙ процесс api, если однажды их станет несколько.
   */
  const serverSettings = new ServerSettings({ db, env: process.env, logger });

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

  /*
   * Перезапуск служб. Второй посредник и ровно та же причина: сокет
   * Docker означает права root на всей машине, и серверу приложения он не
   * даётся. Пустой секрет — чужие службы из панели не перезапускаются;
   * СЕБЯ сервер приложения перезапускает и без посредника.
   */
  const serviceAgent = new ServiceAgent({
    baseUrl: adminConfig.SERVICE_AGENT_URL,
    token: adminConfig.SERVICE_AGENT_TOKEN,
    logger,
  });
  if (!serviceAgent.configured) {
    logger.warn(
      'Посредник перезапуска не настроен (SERVICE_AGENT_URL/SERVICE_AGENT_TOKEN): ' +
        'из панели можно будет перезапустить только сам сервер приложения, а про ' +
        'остальные службы панель честно скажет, что нужна консоль.',
    );
  }
  const restarts = new RestartStore(db);
  const selfRestart = new SelfRestart({ logger, store: restarts });

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
    // Сроки хранения обещаны «действует сразу», поэтому спрашиваются
    // перед каждой уборкой, а не запоминаются при сборке сборщика.
    limits: retentionReader(serverSettings, 'MAIL_METRICS_RETENTION_DAYS', 'MAIL_METRICS_MAX_ROWS'),
  });

  /*
   * Антиспам. Один клиент на всю админку: к контроллеру rspamd ходят и
   * раздел «Спам», и раздел «Наблюдение», и заводить два клиента с двумя
   * копиями пароля незачем.
   */
  const rspamd = new RspamdClient({
    host: adminConfig.RSPAMD_HOST,
    port: adminConfig.RSPAMD_CONTROLLER_PORT,
    password: adminConfig.RSPAMD_PASSWORD,
  });
  if (!rspamd.configured) {
    logger.warn(
      'Не задан RSPAMD_PASSWORD: раздел «Спам» сможет показать только то, отвечает ли ' +
        'антиспам. Ни статистики, ни списков, ни обучения без пароля контроллера нет.',
    );
  }

  /*
   * Съёмка счётчиков антиспама. Отдельно от MetricsCollector намеренно:
   * тот обязан продолжать снимать нагрузку сервера, даже когда rspamd
   * лежит (подробно — в spam-collector.ts).
   */
  const spamCollector = new SpamCollector({
    db,
    logger,
    rspamd,
    intervalSeconds: adminConfig.MAIL_METRICS_INTERVAL_SECONDS,
    retentionDays: adminConfig.MAIL_METRICS_RETENTION_DAYS,
    maxRows: adminConfig.MAIL_METRICS_MAX_ROWS,
    limits: retentionReader(serverSettings, 'MAIL_METRICS_RETENTION_DAYS', 'MAIL_METRICS_MAX_ROWS'),
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
    rspamd,
    cookieSecure: config.COOKIE_SECURE,
    importBox: createImportBox(adminConfig.importSecret),
    migrationBox,
    migrationDest,
    migrationRunner,
    serverSettings,
    // Приватный ключ DKIM нового домена шифруется тем же секретом, что и
    // пароли заданий переноса: второго секрета ради одной строки заводить
    // незачем, а класть ключ подписи в базу открытым — нельзя.
    domainChangeBox: migrationBox,
    serviceAgent,
    selfRestart,
    // Журнал перезапусков подставляется НИЖЕ, после проверки миграции:
    // без таблицы он должен быть null, а не «есть, но каждый запрос
    // падает» — иначе раздел отвечал бы пятисотой ошибкой вместо
    // объяснения, какую миграцию применить.
    restarts: null,
  };

  /*
   * Работник смены домена. Живёт рядом с контекстом, а не создаётся в
   * маршруте, по той же причине, что и работник переноса: маршрут
   * отвечает за секунды, а операция идёт минутами, и после ответа за неё
   * должен кто-то отвечать.
   */
  const domainChangeRunner = new DomainChangeRunner({
    ctx,
    logger,
    backupDir: adminConfig.DOMAIN_CHANGE_BACKUP_DIR,
  });
  ctx.domainChangeRunner = domainChangeRunner;

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
          'Таблиц админки нет. Примените infra/postgres/migrations/0001_baseline.sql ' +
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
    limits: retentionReader(serverSettings, 'MAIL_FLOW_RETENTION_DAYS', 'MAIL_FLOW_MAX_ROWS'),
  });
  new FlowStore(db)
    .schemaReady()
    .then((ready: boolean) => {
      if (!ready) {
        logger.error(
          'Таблиц истории доставки нет. Примените ' +
            'infra/postgres/migrations/0001_baseline.sql — до этого раздел ' +
            '«Почтовый поток» покажет только очередь, без обработанных писем.',
        );
        return;
      }
      flow.start();
    })
    .catch((err: unknown) => logger.error({ err }, 'Не удалось проверить схему истории доставки'));

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
            'infra/postgres/migrations/0001_baseline.sql — до этого дашборд покажет ' +
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
            'infra/postgres/migrations/0001_baseline.sql — до этого раздел ' +
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

  /*
   * Съёмка счётчиков антиспама. Запускается только при применённой
   * миграции 0022: без таблицы каждый проход писал бы в журнал ошибку раз
   * в минуту, а «за период» всё равно не появилось бы. Всё остальное в
   * разделе «Спам» (состояние, списки, обучение) работает и без неё —
   * оно берётся у rspamd напрямую.
   */
  new SpamStore(db)
    .schemaReady()
    .then((ready: boolean) => {
      if (!ready) {
        logger.warn(
          'Таблицы снимков антиспама нет. Примените ' +
            'infra/postgres/migrations/0001_baseline.sql — до этого раздел «Спам» ' +
            'покажет состояние «прямо сейчас», но без сравнения с прошлыми часами.',
        );
        return;
      }
      spamCollector.start();
    })
    .catch((err: unknown) => logger.error({ err }, 'Не удалось проверить схему снимков антиспама'));

  /*
   * Задание смены домена, брошенное убитым процессом.
   *
   * Продолжить его нельзя — неизвестно, на каком шаге оборвалось, — но и
   * оставить висеть в состоянии «выполняется» тоже нельзя: раздел
   * отказывался бы начинать новую смену вечно. Разбираем при старте,
   * пока никто ничего не нажимал.
   */
  domainChangeSchemaReady(db)
    .then(async (ready: boolean) => {
      if (!ready) return;
      await domainChangeRunner.recoverAbandoned();
    })
    .catch((err: unknown) => logger.error({ err }, 'Не удалось разобрать задание смены домена'));

  /*
   * Журнал перезапусков и отметка о собственном старте.
   *
   * Отметка ставится ЗДЕСЬ, при подъёме процесса, и делает сразу две
   * вещи. Первая: закрывает заявку, по которой этот процесс и был
   * перезапущен, — то есть отвечает панели «сервер поднялся». Ответить
   * иначе нельзя, тот процесс, что заявку завёл, уже не существует.
   * Вторая: это счётчик для защиты от петли. Настройка, из-за которой
   * сервер падает на старте, иначе превращала бы кнопку в бесконечный
   * круг — а так он посчитает свои старты и откажется перезапускаться,
   * объяснив почему (см. self-restart.ts).
   */
  restarts
    .schemaReady()
    .then(async (ready: boolean) => {
      if (!ready) {
        logger.warn(
          'Таблицы журнала перезапусков нет. Примените ' +
            'infra/postgres/migrations/0001_baseline.sql — до этого кнопки ' +
            '«применить настройку» будут отвечать 503 с объяснением.',
        );
        return;
      }
      ctx.restarts = restarts;
      await selfRestart.announceBoot();
    })
    .catch((err: unknown) => logger.error({ err }, 'Не удалось проверить журнал перезапусков'));

  app.addHook('onClose', async () => {
    janitor.stop();
    flow.stop();
    metrics.stop();
    spamCollector.stop();
    // Сначала попросить перенос остановиться, потом ДОЖДАТЬСЯ, пока он
    // отпустит свои задания, и только потом закрывать базу: иначе запись
    // «я ничей» не проходит, и задание висит с биением мертвеца, пока не
    // истечёт срок молчания.
    migrationRunner.stop();
    await migrationRunner.drain();
    /*
     * Смену домена НЕ прерываем — дожидаемся. Прервать её посреди
     * переименования каталогов значит оставить хранилище в состоянии, о
     * котором не знает никто. Операция длится минуты, а не часы, и это
     * ровно тот случай, когда остановка сервера должна подождать.
     */
    await domainChangeRunner.drain();
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
      // Антиспам: статистика, списки, обучение. И исправность сервера —
      // то же, что показывает install/selfcheck.sh, только из панели.
      await adminSpamRoutes(scope);
      await adminMonitoringRoutes(scope);
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
      // Настройки сервера: то, что раньше жило только в infra/.env.
      // Право на них — владельца, самое сильное (см. permissions.ts).
      await adminServerSettingsRoutes(scope);
      // Перезапуск служб: кнопка рядом с настройкой вместо «идите
      // в консоль». Право — владельца (см. permissions.ts).
      await adminRestartRoutes(scope);
      // Раздел «Сертификат»: какой TLS-сертификат стоит и замена его на свой.
      // Право то же, что у настроек сервера, и по той же причине: это
      // действие над всем сервером сразу, а имена в сертификате — карта
      // установки. Правила проверки — общие с мастером первого запуска
      // (packages/shared/src/tls-certificate.ts).
      await adminTlsRoutes(scope);
      // Перенос почты с чужого сервера (Kerio Connect и прочие). Логика
      // переноса — в packages/migrate, здесь только задания и их показ.
      await adminMigrateRoutes(scope);
      await adminDomainChangeRoutes(scope);
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
export * from './rspamd.js';
export * from './spam-lists.js';
export * from './spam-store.js';
export * from './selfcheck.js';
export { SpamCollector } from './spam-collector.js';
export { MetricsCollector } from './metrics-collector.js';
export * from './branding.js';
export * from './branding-image.js';
export * from './backup-format.js';
export * from './backup-store.js';
export { FlowCollector } from './flow-collector.js';
export * from './server-settings.js';
export * from './server-settings-registry.js';
export * from './restart-targets.js';
export * from './restart-store.js';
export * from './self-restart.js';
export * from './service-agent.js';
export { createLogStreams } from './app-log.js';
