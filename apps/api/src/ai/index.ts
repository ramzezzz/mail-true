/**
 * Подключение помощника на основе ИИ к API.
 *
 * Единственная точка соприкосновения с остальным приложением —
 * вызов aiRoutes(app) в src/app.ts. Модуль самодостаточен: своя
 * конфигурация, своё подключение к Postgres, свой клиент Redis.
 *
 * Помощник намеренно устроен так, что его отсутствие незаметно:
 *   - нет базы           -> маршруты отвечают «выключено», почта работает;
 *   - нет AI_ENCRYPTION_KEY -> локальная модель работает, внешний ключ
 *                              сохранить нельзя (и об этом честно сказано);
 *   - сервис ИИ лежит    -> кнопка отвечает ошибкой, письма читаются.
 *
 * Порядок регистрации в app.ts важен: aiRoutes(app) должен идти ДО
 * adminRoutes(app), потому что админский раздел ИИ забирает готовый
 * сервис из декорации `aiService`.
 */
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { LoggerAuditLog, type AiAuditLog } from '@mail-true/ai';
import { loadAiConfig } from './config.js';
import { AiDb, PgAiAuditLog } from './db.js';
import { aiUserRoutes } from './routes.js';
import { createKeyBox } from './secret.js';
import { AiService } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Сервис помощника. Есть всегда — даже когда ИИ выключен. */
    aiService: AiService;
  }
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const { config, logger } = app.deps;
  const aiConfig = loadAiConfig();
  const { box: keyBox, reason: keyBoxReason } = createKeyBox(aiConfig.AI_ENCRYPTION_KEY);

  let db: AiDb | null = null;
  if (aiConfig.databaseUrl) {
    db = new AiDb({ connectionString: aiConfig.databaseUrl, logger });
  } else {
    logger.warn(
      'Помощник ИИ выключен: не задан AI_DATABASE_URL/ADMIN_DATABASE_URL/DATABASE_URL. ' +
        'Маршруты /api/ai/* будут отвечать «выключено», почта работает как обычно.',
    );
  }

  // Кэш результатов и учёт расходов живут в том же Redis, что и сессии,
  // но под своим префиксом (AI_REDIS_PREFIX).
  let redis: Redis | null = null;
  if (config.SESSION_STORE === 'redis') {
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis недоступен (ИИ)'));
  } else {
    /*
     * Раньше здесь было сказано «расход считается без Redis», а на деле
     * без Redis учёт подменялся безлимитным: предел не действовал вовсе,
     * при этом /state и /usage показывали нулевой расход и полный
     * остаток. Теперь расход действительно считается — в памяти этого
     * процесса, — и ограничение сказано ровно то, которое есть.
     */
    logger.warn(
      'SESSION_STORE=memory: результаты помощника не кэшируются, а расход на ИИ считается ' +
        'в памяти процесса. Предел работает, но счёт обнуляется при перезапуске и у каждого ' +
        'узла свой. Для общего учёта нужен SESSION_STORE=redis.',
    );
  }

  // Журнал: в лог сервера всегда, плюс в Postgres — оттуда его читает
  // админка. Без базы журнал остаётся только в логе, и это честно видно.
  const audit: AiAuditLog = db
    ? new LoggerAuditLog(logger, new PgAiAuditLog(db, logger))
    : new LoggerAuditLog(logger);

  const service = new AiService({
    config: aiConfig,
    db,
    redis,
    keyBox,
    keyBoxReason,
    logger,
    audit,
  });
  app.decorate('aiService', service);

  if (!aiConfig.AI_ENABLED) {
    logger.warn('AI_ENABLED=false: помощник выключен на всём сервере');
  }

  // Ранняя диагностика: скажем в лог, применена ли миграция.
  if (db) {
    db.schemaReady()
      .then((ready) => {
        if (!ready) {
          logger.error(
            'Таблиц помощника ИИ нет. Примените infra/postgres/migrations/0001_baseline.sql ' +
              'к работающей базе — до этого помощник будет отвечать «выключено».',
          );
        } else if (!keyBox) {
          logger.info(
            { reason: keyBoxReason },
            'Ключи доступа к внешним сервисам ИИ хранить нельзя',
          );
        }
      })
      .catch((err) => logger.error({ err }, 'Не удалось проверить схему помощника ИИ'));
  }

  app.addHook('onClose', async () => {
    if (db) await db.close().catch(() => undefined);
    if (redis) redis.disconnect();
  });

  await app.register(
    async (scope) => {
      await aiUserRoutes(scope, service);
    },
    { prefix: '/api/ai' },
  );
}

export { aiAdminRoutes } from './admin.js';
export { AiService } from './service.js';
export * from './features.js';
export * from './secret.js';
