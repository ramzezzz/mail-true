/**
 * Расширение типов Fastify: данные сессии на запросе и общие зависимости.
 */
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { SecretBox } from './crypto.js';
import type { GeoIpDatabase } from './geoip/index.js';
import type { HealthMonitor } from './health.js';
import type { SessionStore } from './session.js';
import type { ImapPool } from './imap/pool.js';
import type { DeferredSender } from './mail/deferred-send.js';
import type { AccessRecorder } from './settings/access-record.js';
import type { UploadStore } from './uploads.js';

/** Аутентифицированная сессия текущего запроса. */
export interface MailSession {
  id: string;
  email: string;
  /** Пароль в открытом виде (расшифрован из сессии) — только в памяти запроса. */
  password: string;
  /**
   * Ящик, из которого сюда переключились, и чем вернуться (зашифрованно).
   * Право вернуться принадлежит СЕАНСУ, а не учётной записи — разбор в
   * SessionData.returnTo (session.ts).
   */
  returnTo?: { email: string; passwordEnc: string };
}

/** Общие зависимости приложения. */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  sessions: SessionStore;
  secretBox: SecretBox;
  pool: ImapPool;
  uploads: UploadStore;
  /**
   * Запись в историю входов и действий владельца ящика.
   *
   * Живёт ЗДЕСЬ, а не декорацией Fastify, из-за порядка сборки: вход и
   * выход из почты (routes/auth.ts) регистрируются раньше раздела
   * настроек, который эту запись и заводит, а декорация, добавленная
   * к корню после создания вложенной области, в ней уже не видна —
   * запись о входе молча не делалась бы. Объект `deps` один на всё
   * приложение и передаётся по ссылке, поэтому поле, проставленное
   * позже, видят все.
   *
   * Необязательное: без базы или без применённой миграции истории нет,
   * и почта обязана работать как обычно.
   */
  accessLog?: AccessRecorder;
  /**
   * Страна входа. Необязательная: без базы стран вход работает как
   * раньше, и это не «выключенная защита», а штатное состояние сервера,
   * на котором базу не скачивали.
   */
  geoip?: GeoIpDatabase;
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
