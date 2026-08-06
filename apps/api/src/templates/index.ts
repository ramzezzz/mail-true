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
    store
      .schemaReady()
      .then((ready) => {
        if (!ready) {
          deps.unavailableReason = TEMPLATES_MIGRATION_HINT;
          logger.error(TEMPLATES_MIGRATION_HINT);
          return;
        }
        deps.store = store;
      })
      .catch((err: unknown) => {
        deps.unavailableReason = 'Не удалось проверить схему шаблонов писем';
        logger.error(errorInfo(err), 'Не удалось проверить схему шаблонов писем');
      });
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
