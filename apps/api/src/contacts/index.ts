/**
 * Подключение подсказки адреса к API.
 *
 * Единственная точка соприкосновения с остальным приложением — вызов
 * contactsRoutes(app) в src/app.ts. Модуль самодостаточен: своё
 * подключение к Postgres, свой сборщик, свои маршруты. Ни одна таблица
 * почтового стека им не изменяется.
 *
 * Отсутствие любой части — не авария почты:
 *   - нет базы или не применена миграция -> подсказки нет, поле «Кому»
 *     работает ровно так же, как работало до неё;
 *   - настройки ящика недоступны -> собираются только отправленные письма
 *     (на них разрешения не нужно, см. HarvestRequest.collectReceived).
 *
 * Регистрируется ПОСЛЕ settingsRoutes: переключатель «автоматически
 * пополнять контакты» живёт в общих настройках ящика, и заводить второй
 * такой же значило бы «включил в одном месте, а работает по другому».
 */
import type { FastifyInstance } from 'fastify';
import { errorInfo } from '../log.js';
import { ContactsDb } from './db.js';
import { ContactHarvester } from './harvester.js';
import { contactsRoutes as registerRoutes } from './routes.js';
import { ContactsService, type ContactsEnvironment } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Подсказка адреса. Есть всегда — даже когда база не настроена. */
    contactsService: ContactsService;
  }
}

/** Откуда брать строку подключения. Тот же порядок, что у остальных разделов. */
function databaseUrl(env: NodeJS.ProcessEnv): string | null {
  return (
    env.CONTACTS_DATABASE_URL ||
    env.SETTINGS_DATABASE_URL ||
    env.ADMIN_DATABASE_URL ||
    env.DATABASE_URL ||
    null
  );
}

export async function contactsRoutes(app: FastifyInstance): Promise<void> {
  const { logger, pool } = app.deps;
  const connectionString = databaseUrl(process.env);

  let db: ContactsDb | null = null;
  if (connectionString) {
    db = new ContactsDb({ connectionString, logger });
  } else {
    logger.warn(
      'Подсказка адреса выключена: не задан ' +
        'CONTACTS_DATABASE_URL/SETTINGS_DATABASE_URL/ADMIN_DATABASE_URL/DATABASE_URL. ' +
        'Поле «Кому» работает как обычно, но адреса не подсказываются.',
    );
  }

  const env: ContactsEnvironment = {
    /*
     * Переключатель «автоматически пополнять контакты» из общих настроек.
     *
     * Недоступные настройки означают «не разрешал»: указатель, собранный
     * из входящих без спроса, — это список тех, кто пишет человеку, и
     * заводить его по умолчанию, когда спросить не у кого, нельзя.
     * Отправленные письма собираются в любом случае и сюда не заглядывают.
     */
    collectReceived: async (email: string): Promise<boolean> => {
      const settings = app.settingsService;
      if (!settings.available) return false;
      try {
        return (await settings.requireDb().getSettings(email)).collectContacts;
      } catch {
        return false;
      }
    },
  };

  let harvester: ContactHarvester | null = null;
  const service = new ContactsService({ db, harvester: null, env, logger });

  if (db) {
    harvester = new ContactHarvester({
      db,
      pool,
      logger,
      onProgress: (email, complete) => service.markComplete(email, complete),
    });
  }
  // Сборщик знает о службе (через onProgress), а служба — о сборщике.
  // Связь замыкается здесь, а не в конструкторе, чтобы ни один из двух не
  // требовал второго для своего существования: без базы сборщика нет
  // вовсе, а служба обязана работать и в этом случае.
  service.attachHarvester(harvester);
  app.decorate('contactsService', service);

  /*
   * Ранняя диагностика. Молчать нельзя: «подсказка не работает» иначе
   * выяснится жалобой, а причина (не применена миграция) видна сейчас.
   */
  if (db) {
    try {
      if (!(await db.schemaReady())) {
        logger.error(
          'Таблиц адресной книги нет. Примените infra/postgres/migrations/0001_baseline.sql ' +
            'к работающей базе — до этого адреса в поле «Кому» не подсказываются.',
        );
      }
    } catch (err) {
      logger.warn(errorInfo(err), 'Не удалось проверить схему адресной книги');
    }
  }

  app.addHook('onClose', async () => {
    harvester?.close();
    if (db) await db.close().catch(() => undefined);
  });

  await app.register(
    async (scope) => {
      await registerRoutes(scope, service);
    },
    { prefix: '/api/contacts' },
  );
}

export { ContactsService } from './service.js';
export * from './types.js';
