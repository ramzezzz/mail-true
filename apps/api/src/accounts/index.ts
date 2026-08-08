/**
 * Подключение модуля ящиков к API.
 *
 * Единственная точка соприкосновения с остальным приложением —
 * вызов accountsRoutes(app) в src/app.ts. Модуль самодостаточен: своя
 * конфигурация, своё подключение к Postgres, свой пул соединений
 * с чужими серверами и свой планировщик сбора почты.
 *
 * Модуль устроен так, что его отсутствие незаметно:
 *   - нет базы                     -> маршруты отвечают 503, почта работает;
 *   - нет EXTERNAL_ACCOUNTS_KEY    -> список подключений виден, добавить
 *                                     новое нельзя (и об этом честно сказано);
 *   - нет служебного пользователя  -> сбор доступен только вручную;
 *   - чужой сервер лежит           -> ошибка в состоянии подключения,
 *                                     своя почта читается как обычно.
 */
import type { FastifyInstance } from 'fastify';
import { loadAccountsConfig } from './config.js';
import { collectorRoutes } from './collectorRoutes.js';
import { AccountsDb } from './db.js';
import { accountsUserRoutes } from './routes.js';
import { createSecretBox } from './secret.js';
import { AccountsService, AccountsUnavailableError } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Сервис подключения ящиков. Есть всегда — даже когда база не настроена. */
    accountsService: AccountsService;
  }
}

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  const { config, logger } = app.deps;
  const accountsConfig = loadAccountsConfig();
  const { box: secretBox, reason: secretBoxReason } = createSecretBox(
    accountsConfig.EXTERNAL_ACCOUNTS_KEY,
  );

  let db: AccountsDb | null = null;
  if (accountsConfig.databaseUrl) {
    db = new AccountsDb({ connectionString: accountsConfig.databaseUrl, logger });
  } else {
    logger.warn(
      'Подключение ящиков выключено: не задан ACCOUNTS_DATABASE_URL/ADMIN_DATABASE_URL/DATABASE_URL. ' +
        'Маршруты /api/accounts/* будут отвечать 503, почта работает как обычно.',
    );
  }

  const service = new AccountsService({
    config: accountsConfig,
    appConfig: config,
    db,
    secretBox,
    secretBoxReason,
    logger,
  });
  app.decorate('accountsService', service);

  if (db) {
    db.schemaReady()
      .then((ready) => {
        if (!ready) {
          logger.error(
            'Таблиц внешних ящиков нет. Примените ' +
              'infra/postgres/migrations/0001_baseline.sql к работающей базе.',
          );
          return;
        }
        if (!secretBox) {
          logger.warn({ reason: secretBoxReason }, 'Пароли внешних ящиков хранить нельзя');
        }
        service.startScheduler();
      })
      .catch((err) => logger.error({ err }, 'Не удалось проверить схему внешних ящиков'));
  }

  app.addHook('onClose', async () => {
    await service.close().catch(() => undefined);
  });

  await app.register(
    async (scope) => {
      if (!service.available) {
        scope.all('/*', async () => {
          throw new AccountsUnavailableError(
            'Подключение ящиков недоступно: не настроена база данных или модуль выключен',
          );
        });
        return;
      }
      await accountsUserRoutes(scope, service);
    },
    { prefix: '/api/accounts' },
  );

  // Раздел «Почта с других ящиков» в форме контракта веб-интерфейса
  // (apps/web/src/api/settingsApi.ts). Те же таблицы и тот же сборщик,
  // только форма ответа — та, которую ждёт интерфейс.
  await app.register(
    async (scope) => {
      if (!service.available) {
        scope.all('/*', async () => {
          throw new AccountsUnavailableError(
            'Сбор почты с других ящиков недоступен: не настроена база данных',
          );
        });
        return;
      }
      await collectorRoutes(scope, service);
    },
    { prefix: '/api/settings/collectors' },
  );
}

export { AccountsService } from './service.js';
export * from './autodetect.js';
export * from './secret.js';
export * from './types.js';
