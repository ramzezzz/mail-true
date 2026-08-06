/**
 * Расширение типов Fastify для админки: контекст и текущая админская сессия
 * на объекте запроса.
 */
import type { AdminConfig } from './config.js';
import type { BrandingStore } from './branding.js';
import type { AdminDb } from './db.js';
import type { ImportSecretBox } from './import-jobs.js';
import type { DestSettings } from './migrate-jobs.js';
import type { SecretBox } from '../crypto.js';
import type { AdminSessionStore, AdminSessionData } from './session.js';
import type { MailboxMasterAccess } from './mailbox.js';
import type { MetricsCollector } from './metrics-collector.js';
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
  /**
   * Своё оформление входа (логотип OEM и подписи). Файлы, а не база:
   * логотип отдаётся на каждый показ страницы входа, и запрос к Postgres
   * ради картинки здесь ни к чему (см. admin/branding.ts).
   */
  branding: BrandingStore;
  /**
   * Сборщик показателей сервера для дашборда.
   *
   * Живёт в контексте, а не создаётся в маршруте, по той же причине, по
   * которой существует сам сборщик: загрузка процессора вычисляется только
   * РАЗНОСТЬЮ двух замеров, то есть требует состояния между запросами
   * (см. metrics-collector.ts). Маршрут берёт у него уже снятый снимок и
   * ничего не измеряет сам.
   *
   * Поле НЕОБЯЗАТЕЛЬНОЕ: контекст собирают и проверки маршрутов, которым
   * до показателей сервера дела нет, а требовать от них поднимать сборщик
   * значит заводить в каждой проверке чтение /proc и обход каталогов.
   * Отсутствие сборщика означает ровно «раздел ресурсов недоступен», и
   * маршрут говорит это словами вместо выдуманных чисел.
   */
  metrics?: MetricsCollector;
  /** Куки подписываются тем же секретом, что и почтовые, но имя — своё. */
  cookieSecure: boolean;
  /**
   * Чем шифруется результат импорта (сгенерированные пароли).
   * null — секрета нет, пароли не сохраняются вовсе.
   */
  importBox: ImportSecretBox | null;
  /**
   * Чем шифруются пароли исходных ящиков в заданиях переноса.
   *
   * Тот же SecretBox, под которым лежит пароль в почтовой сессии и в
   * очереди отложенной отправки, — своего шифрования раздел переноса не
   * заводит. null означает «переносить нечем»: класть чужие пароли в базу
   * открытыми ради работающей кнопки недопустимо, и раздел честно
   * отвечает 503 с объяснением.
   *
   * Поле НЕОБЯЗАТЕЛЬНОЕ по той же причине, что и metrics: контекст
   * собирают и проверки маршрутов, которым до переноса дела нет.
   * Отсутствие означает ровно «перенос не настроен».
   */
  migrationBox?: SecretBox | null;
  /**
   * Куда переносим и чем туда входим. Пароль здесь — СЛУЖЕБНОГО
   * пользователя нашего Dovecot, а не владельцев ящиков: паролей
   * ящиков-приёмников перенос не требует вовсе (см. admin/migrate-jobs.ts).
   */
  migrationDest?: DestSettings;
  /**
   * Работник переноса. Может отсутствовать в проверках маршрутов, которым
   * до фоновой работы дела нет; тогда задание просто дождётся ближайшего
   * прохода работника вместо немедленного.
   */
  migrationRunner?: { nudge(): void };
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
