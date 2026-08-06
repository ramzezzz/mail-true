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
import type { DeferredSender } from './mail/deferred-send.js';
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
    /**
     * Работник очереди отложенной отправки (см. routes/compose.ts).
     * Обычно он просыпается сам; наружу выведен, чтобы проверки могли
     * позвать один проход, не дожидаясь таймера.
     */
    deferredSender: DeferredSender;
    /**
     * Наблюдатель за ящиками (см. ws.ts). Нужен написанию писем, чтобы
     * сказать в открытую вкладку об отказе отправки из очереди.
     * Необязателен: в проверках маршруты поднимают без него.
     */
    mailNotifier?: { notify(email: string, payload: unknown): boolean };
  }
  interface FastifyRequest {
    mailSession: MailSession | null;
  }
}
