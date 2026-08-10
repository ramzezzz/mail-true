/**
 * Подключение шаблонов писем к API.
 *
 * Единственная точка соприкосновения с остальным приложением — вызов
 * `templatesRoutes(app)` в src/app.ts. Модуль самодостаточен: своё
 * подключение к Postgres, своя проба схемы, свои маршруты. Ни одной
 * таблицы почтового стека он не трогает и в отправку писем не вмешивается:
 * вложения шаблона уходят в письмо через ТО ЖЕ временное хранилище
 * загрузок, что и любой прикреплённый файл (см. routes.ts).
 *
 * Отсутствие базы — не авария почты: шаблонов нет, кнопки «Шаблоны» в
 * окне написания нет, раздела в настройках нет. Общее правило продукта —
 * кнопка появляется вместе с поведением; так же устроены метки и
 * отложенные письма.
 *
 * Проба схемы асинхронная и НЕ задерживает сборку маршрутов: почта обязана
 * подниматься и с лежащей базой. До ответа возможность выключена.
 */
import type { FastifyInstance } from 'fastify';
import { loadAccountsConfig } from '../accounts/config.js';
import { errorInfo } from '../log.js';
import { probeSchemaWithRetry } from '../schema-probe.js';
import { TemplatesDb } from './db.js';
import {
  templateRoutes,
  TEMPLATES_MIGRATION_HINT,
  TEMPLATES_NO_DATABASE,
  type TemplatesDeps,
} from './routes.js';

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  const { logger } = app.deps;
  // База берётся оттуда же, откуда её берут метки и настройки: своих
  // переменных окружения шаблоны не заводят — вторая строка подключения
  // означала бы, что раздел можно случайно нацелить на другую базу.
  const connectionString = loadAccountsConfig().databaseUrl;

  const deps: TemplatesDeps = { store: null, unavailableReason: TEMPLATES_NO_DATABASE };

  let db: TemplatesDb | null = null;
  if (connectionString) {
    db = new TemplatesDb({ connectionString, logger });
    const store = db;
    /*
     * Проба повторяется: секундный сбой базы при старте не должен
     * выключать раздел до перезапуска контейнера. Подробный разбор — в
     * disposable/index.ts, откуда взята эта же функция.
     */
    void probeSchemaWithRetry(
      () => store.schemaReady(),
      () => {
        // Причину не трогаем: при живом хранилище её никто не читает.
        deps.store = store;
      },
      () => {
        deps.unavailableReason = TEMPLATES_MIGRATION_HINT;
        logger.error(TEMPLATES_MIGRATION_HINT);
      },
      (err, willRetry) => {
        deps.unavailableReason = willRetry
          ? 'База ещё не отвечает — раздел включится, как только она поднимется'
          : 'Не удалось проверить схему шаблонов писем';
        logger.error(
          errorInfo(err),
          willRetry
            ? 'Схему шаблонов писем проверить не удалось, попробуем ещё раз'
            : 'Не удалось проверить схему шаблонов писем',
        );
      },
    );
  } else {
    logger.warn(TEMPLATES_NO_DATABASE);
  }

  app.addHook('onClose', async () => {
    if (db) await db.shutdown().catch(() => undefined);
  });

  await app.register(
    async (scope) => {
      await templateRoutes(scope, deps);
    },
    { prefix: '/api' },
  );
}

export * from './types.js';
