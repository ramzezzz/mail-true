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
import { loadSettingsConfig } from './config.js';
import { SettingsDb } from './db.js';
import { folderManagementRoutes } from './folders.js';
import { settingsUserRoutes } from './routes.js';
import { SettingsService, SettingsUnavailableError } from './service.js';
import { SieveStore } from './store.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Сервис настроек. Есть всегда — даже когда база не настроена. */
    settingsService: SettingsService;
  }
}

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

  const service = new SettingsService({ config, db, store, logger });
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

  app.addHook('onClose', async () => {
    if (db) await db.close().catch(() => undefined);
  });

  await app.register(
    async (scope) => {
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

export { SettingsService } from './service.js';
export * from './sieve.js';
export * from './types.js';
export { SieveStore } from './store.js';
