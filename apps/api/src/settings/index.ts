/**
 * Подключение раздела настроек к API.
 *
 * Единственная точка соприкосновения с остальным приложением —
 * вызов settingsRoutes(app) в src/app.ts. Модуль самодостаточен:
 * своя конфигурация, своё подключение к Postgres, своё хранилище
 * файлов Sieve.
 *
 * Отсутствие базы — не авария: маршруты /api/settings/* честно отвечают
 * 503, почта работает как обычно.
 */
import type { FastifyInstance } from 'fastify';
import { loadAccountsConfig } from '../accounts/config.js';
import { errorInfo } from '../log.js';
import { loadSettingsConfig } from './config.js';
import { SettingsDb } from './db.js';
import { folderManagementRoutes } from './folders.js';
import { settingsUserRoutes } from './routes.js';
import { SettingsService, SettingsUnavailableError } from './service.js';
import { SieveIncludeStore } from './sieve-include.js';
import { SieveStore } from './store.js';
import { ExportRunner } from './export-runner.js';
import { OwnerDb } from './owner-db.js';
import { ownerRoutes, type OwnerRoutesContext } from './owner-routes.js';
import { RecoveryService } from './recovery-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Сервис настроек. Есть всегда — даже когда база не настроена. */
    settingsService: SettingsService;
    /**
     * Восстановление после очистки корзины. Есть всегда — выключенным,
     * если базы нет: очистка папок обязана работать и без него.
     */
    recoveryService: RecoveryService;
  }
}

/** Как часто уборщик подчищает историю входов старше срока. */
const ACCESS_JANITOR_MS = 6 * 3600_000;

/** Одна причина на три раздела: без базы нет ни одного из них. */
const NO_DATABASE =
  'Раздел недоступен: не настроена база данных (DATABASE_URL). Почта работает как обычно.';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const { logger } = app.deps;
  const config = loadSettingsConfig();

  let db: SettingsDb | null = null;
  if (config.databaseUrl) {
    db = new SettingsDb({ connectionString: config.databaseUrl, logger });
  } else {
    logger.warn(
      'Настройки ящика выключены: не задан SETTINGS_DATABASE_URL/ADMIN_DATABASE_URL/DATABASE_URL. ' +
        'Маршруты /api/settings/* будут отвечать 503, почта работает как обычно.',
    );
  }

  const store = new SieveStore({
    transport: config.transport,
    root: config.SIEVE_ROOT,
    container: config.SIEVE_DOCKER_CONTAINER,
    scriptName: config.SIEVE_SCRIPT_NAME,
    owner: config.SIEVE_OWNER,
    logger,
  });

  /*
   * Хранилище включаемых файлов Sieve — то же почтовое хранилище, те же
   * настройки транспорта. Второй набор переменных окружения для того же
   * каталога — прямая дорога к «настроил, а не работает».
   */
  const includes = new SieveIncludeStore({
    transport: config.transport,
    root: config.SIEVE_ROOT,
    container: config.SIEVE_DOCKER_CONTAINER,
    scriptName: config.SIEVE_SCRIPT_NAME,
    owner: config.SIEVE_OWNER,
    logger,
  });

  const service = new SettingsService({ config, db, store, includes, logger });
  app.decorate('settingsService', service);

  // Ранняя диагностика: скажем в лог, применена ли миграция и виден ли
  // Dovecot. Молчать здесь нельзя — иначе «правило не работает»
  // выяснится только на живом письме.
  if (db) {
    db.schemaReady()
      .then((ready) => {
        if (!ready) {
          logger.error(
            'Таблиц настроек нет. Примените infra/postgres/migrations/0005_settings_accounts.sql ' +
              'к работающей базе — до этого настройки и фильтры недоступны.',
          );
        }
      })
      .catch((err) => logger.error({ err }, 'Не удалось проверить схему настроек'));
  }
  store
    .check()
    .then(({ ok, reason }) => {
      if (!ok) {
        logger.warn(
          { reason },
          'Почтовое хранилище недоступно: правила фильтрации не попадут в Dovecot',
        );
      }
    })
    .catch(() => undefined);

  /*
   * Три раздела владельца ящика: история входов, выгрузка ящика целиком
   * и восстановление после очистки корзины.
   *
   * Своих переменных окружения для подключения к базе они не заводят и
   * своего служебного входа в Dovecot тоже: и то, и другое берётся оттуда
   * же, откуда берут возврат отложенных писем и сборщик чужой почты
   * (accounts/config.ts). Второй набор переменных для того же самого —
   * прямая дорога к «настроил, а не работает».
   */
  const accountsConfig = loadAccountsConfig();
  const master = accountsConfig.masterConfigured
    ? {
        user: accountsConfig.DOVECOT_MASTER_USER,
        password: accountsConfig.DOVECOT_MASTER_PASSWORD,
        separator: accountsConfig.DOVECOT_MASTER_SEPARATOR,
      }
    : null;

  const ownerDb = config.databaseUrl
    ? new OwnerDb({ connectionString: config.databaseUrl, logger })
    : null;

  const recovery = new RecoveryService({
    config: app.deps.config,
    settings: config,
    logger,
    store: null,
    master,
  });
  app.decorate('recoveryService', recovery);

  const ownerCtx: OwnerRoutesContext = {
    settings: config,
    store: ownerDb,
    ready: { access: false, export: false, recovery: false },
    reasons: {
      access: ownerDb ? null : NO_DATABASE,
      export: ownerDb ? null : NO_DATABASE,
      recovery: ownerDb ? null : NO_DATABASE,
    },
    exportRunner: null,
    recovery,
  };

  let accessJanitor: NodeJS.Timeout | null = null;

  if (ownerDb) {
    /*
     * Проверка схемы асинхронная и НЕ задерживает сборку маршрутов: почта
     * обязана подняться и с лежащей базой. До ответа все три возможности
     * выключены, и интерфейс их честно не показывает.
     */
    void (async () => {
      try {
        const [access, exportReady, recoveryReady] = await Promise.all([
          ownerDb.accessReady(),
          ownerDb.exportReady(),
          ownerDb.recoveryReady(),
        ]);
        ownerCtx.ready = { access, export: exportReady, recovery: recoveryReady };

        if (access) {
          /*
           * Запись в историю появляется ровно вместе с таблицей. Отказ
           * записи НИКОГДА не мешает действию: лежащий Postgres обязан
           * стоить строки в журнале сервера, а не отказа во входе.
           */
          app.deps.accessLog = {
            record: (input) => {
              void ownerDb
                .addAccess({
                  accountEmail: input.accountEmail,
                  kind: input.kind,
                  channel: input.channel ?? 'web',
                  success: input.success ?? true,
                  ip: input.ip,
                  userAgent: input.userAgent,
                  detail: input.detail,
                })
                .catch((err: unknown) =>
                  logger.warn(errorInfo(err), 'Не удалось записать событие в историю ящика'),
                );
            },
          };
          const sweep = () => {
            const edge = new Date(Date.now() - config.MAILBOX_ACCESS_LOG_DAYS * 24 * 3600_000);
            void ownerDb
              .purgeAccess(edge)
              .catch((err: unknown) => logger.warn(errorInfo(err), 'Уборка истории входов не удалась'));
          };
          accessJanitor = setInterval(sweep, ACCESS_JANITOR_MS);
          accessJanitor.unref?.();
          sweep();
        } else {
          logger.warn(
            'Истории входов нет: примените infra/postgres/migrations/' +
              '0023_mailbox_access_log.sql. Почта работает как обычно.',
          );
        }

        if (exportReady && config.MAILBOX_EXPORT_ENABLED && master) {
          const runner = new ExportRunner({
            config: app.deps.config,
            settings: config,
            logger,
            store: ownerDb,
            master,
          });
          ownerCtx.exportRunner = runner;
          runner.start();
        } else if (!exportReady) {
          logger.warn(
            'Выгрузка ящика недоступна: примените infra/postgres/migrations/' +
              '0024_mailbox_exports.sql.',
          );
        }

        if (recoveryReady) {
          recovery.attachStore(ownerDb);
          recovery.start();
        } else {
          recovery.disable(
            'Восстановление после очистки корзины недоступно: не применена миграция ' +
              'infra/postgres/migrations/0025_trash_recovery.sql. Очистка корзины ' +
              'удаляет письма сразу, как и раньше.',
          );
          logger.warn(recovery.unavailableReason);
        }
      } catch (err) {
        logger.error(errorInfo(err), 'Не удалось проверить схему разделов владельца ящика');
      }
    })();
  } else {
    recovery.disable(NO_DATABASE);
  }

  app.addHook('onClose', async () => {
    if (accessJanitor) clearInterval(accessJanitor);
    ownerCtx.exportRunner?.stop();
    recovery.stop();
    if (db) await db.close().catch(() => undefined);
    if (ownerDb) await ownerDb.shutdown().catch(() => undefined);
  });

  await app.register(
    async (scope) => {
      /*
       * Три раздела владельца регистрируются ДО общей заглушки «настроек
       * нет»: у них своя база, своя проверка схемы и свои причины, и
       * отвечать на «покажи историю входов» отказом «не настроены
       * фильтры» было бы неправдой.
       */
      await ownerRoutes(scope, ownerCtx);

      if (!service.available) {
        scope.all('/*', async () => {
          throw new SettingsUnavailableError();
        });
        return;
      }
      await settingsUserRoutes(scope, service);
    },
    { prefix: '/api/settings' },
  );

  // Раздел «Папки»: создание, переименование, удаление, очистка.
  // Регистрируется под /api/ рядом с существующим GET /api/folders —
  // методы разные, пересечения нет. Базы не требует: всё идёт в IMAP.
  await app.register(
    async (scope) => {
      await folderManagementRoutes(scope);
    },
    { prefix: '/api' },
  );
}

export { RecoveryService } from './recovery-service.js';
export { SettingsService } from './service.js';
export * from './sieve.js';
export * from './sieve-muted.js';
export * from './types.js';
export { SieveIncludeStore } from './sieve-include.js';
export { SieveStore } from './store.js';
