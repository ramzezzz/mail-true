/**
 * Расширение типов Fastify для админки: контекст и текущая админская сессия
 * на объекте запроса.
 */
import type { AdminConfig } from './config.js';
import type { AdminDb } from './db.js';
import type { ImportSecretBox } from './import-jobs.js';
import type { AdminSessionStore, AdminSessionData } from './session.js';
import type { MailboxMasterAccess } from './mailbox.js';
import type { QueueAgent } from './queue-agent.js';

/** Всё, что нужно админским маршрутам. Собирается один раз при регистрации. */
export interface AdminContext {
  config: AdminConfig;
  db: AdminDb;
  sessions: AdminSessionStore;
  mailbox: MailboxMasterAccess;
  /**
   * Доступ к очереди Postfix через посредника в его контейнере.
   * Может быть не настроен — тогда раздел очереди честно отвечает 503
   * с объяснением, а не показывает пустую таблицу (см. queue-agent.ts).
   */
  queueAgent: QueueAgent;
  /** Куки подписываются тем же секретом, что и почтовые, но имя — своё. */
  cookieSecure: boolean;
  /**
   * Чем шифруется результат импорта (сгенерированные пароли).
   * null — секрета нет, пароли не сохраняются вовсе.
   */
  importBox: ImportSecretBox | null;
}

/** Админская сессия текущего запроса. */
export interface CurrentAdmin extends AdminSessionData {
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    adminCtx: AdminContext;
  }
  interface FastifyRequest {
    admin: CurrentAdmin | null;
  }
}
