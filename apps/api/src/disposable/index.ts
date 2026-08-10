/**
 * Подключение одноразовых адресов к API.
 *
 * Единственная точка соприкосновения с остальным приложением — вызов
 * `disposableRoutes(app)` в src/app.ts. Модуль самодостаточен: своё
 * подключение к Postgres, своя проба схемы, свои маршруты.
 *
 * Своих переменных окружения для базы и журнала он не заводит: и то, и
 * другое берётся оттуда же, откуда берут разделы владельца ящика
 * (accounts/config.ts и settings/config.ts). Второй набор переменных для
 * того же самого — прямая дорога к «настроил, а не работает».
 *
 * Отсутствие базы или непринятая миграция — не авария почты: раздела
 * просто нет, и интерфейс говорит словами, чего не хватает. Общее правило
 * продукта: кнопка появляется вместе с поведением.
 */
import type { FastifyInstance } from 'fastify';
import { loadAccountsConfig } from '../accounts/config.js';
import { errorInfo } from '../log.js';
import { probeSchemaWithRetry } from '../schema-probe.js';
import { loadSettingsConfig } from '../settings/config.js';
import { DisposableDb } from './db.js';
import {
  disposableRoutes as routes,
  DISPOSABLE_MIGRATION_HINT,
  DISPOSABLE_NO_DATABASE,
  type DisposableDeps,
} from './routes.js';

export async function disposableRoutes(app: FastifyInstance): Promise<void> {
  const { logger } = app.deps;
  const settings = loadSettingsConfig();
  const connectionString = loadAccountsConfig().databaseUrl;

  const deps: DisposableDeps = {
    store: null,
    unavailableReason: DISPOSABLE_NO_DATABASE,
    limit: settings.DISPOSABLE_ALIAS_LIMIT,
    logDir: settings.MAIL_LOG_DIR,
  };

  let db: DisposableDb | null = null;
  if (connectionString) {
    db = new DisposableDb({ connectionString, logger });
    const store = db;
    // Проба схемы асинхронная и НЕ задерживает сборку маршрутов: почта
    // обязана подниматься и с лежащей базой. До ответа раздела нет.
    void probeSchemaWithRetry(
      () => store.schemaReady(),
      () => {
        // Причину не трогаем: при живом хранилище её никто не читает.
        deps.store = store;
      },
      () => {
        deps.unavailableReason = DISPOSABLE_MIGRATION_HINT;
        logger.error(DISPOSABLE_MIGRATION_HINT);
      },
      (err, willRetry) => {
        deps.unavailableReason = willRetry
          ? 'База ещё не отвечает — раздел включится, как только она поднимется'
          : 'Не удалось проверить схему одноразовых адресов';
        logger.error(
          errorInfo(err),
          willRetry
            ? 'Схему одноразовых адресов проверить не удалось, попробуем ещё раз'
            : 'Не удалось проверить схему одноразовых адресов',
        );
      },
    );
  } else {
    logger.warn(DISPOSABLE_NO_DATABASE);
  }

  app.addHook('onClose', async () => {
    if (db) await db.shutdown().catch(() => undefined);
  });

  await app.register(
    async (scope) => {
      await routes(scope, deps);
    },
    { prefix: '/api/settings' },
  );
}

export * from './types.js';
