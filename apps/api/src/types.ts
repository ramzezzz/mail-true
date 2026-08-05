/**
 * Расширение типов Fastify: данные сессии на запросе и общие зависимости.
 */
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { SecretBox } from './crypto.js';
import type { HealthMonitor } from './health.js';
import type { SessionStore } from './session.js';
import type { ImapPool } from './imap/pool.js';
import type { UploadStore } from './uploads.js';

/** Аутентифицированная сессия текущего запроса. */
export interface MailSession {
  id: string;
  email: string;
  /** Пароль в открытом виде (расшифрован из сессии) — только в памяти запроса. */
  password: string;
}

/** Общие зависимости приложения. */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  sessions: SessionStore;
  secretBox: SecretBox;
  pool: ImapPool;
  uploads: UploadStore;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    /** Проба состояния: части регистрируют её владельцы (см. health.ts). */
    health: HealthMonitor;
    /** preHandler: требует валидную сессию, кладёт её в request.mailSession. */
    requireSession: preHandlerAsyncHookHandler;
  }
  interface FastifyRequest {
    mailSession: MailSession | null;
  }
}
