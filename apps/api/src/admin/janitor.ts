/**
 * Фоновая уборка админки.
 *
 * Три задачи, у каждой своя причина существовать:
 *
 *  1. Физическое удаление каталогов ящиков, отправленных в карантин при
 *     удалении (см. mailbox-cleanup.ts). В обработчике запроса этого не
 *     делают: `rm -rf` большого ящика — это ожидание на ровном месте
 *     и риск таймаута посреди удаления.
 *
 *  2. Закрытие брошенных сеансов входа администратора в чужой ящик.
 *     Отметка о завершении ставилась только явным выходом, поэтому при
 *     истечении срока, закрытой вкладке или выходе из админки запись
 *     оставалась открытой навсегда — в журнале, который читает ВЛАДЕЛЕЦ
 *     ящика, вход выглядел бесконечным.
 *
 *  3. Удаление просроченных заданий импорта: в них лежат сгенерированные
 *     пароли (шифротекстом), и лежать вечно они не должны.
 *
 * Уборщик умышленно тупой: никаких очередей и блокировок. Единственный
 * узел админки — сам процесс API; если их когда-нибудь станет несколько,
 * повторная уборка того же каталога безвредна (rm -rf с force), а строку
 * закрывает условие `state = 'pending'`.
 */
import type { Logger } from 'pino';
import type { AdminDb } from './db.js';
import { errorInfo } from '../log.js';
import { findOrphanMaildirs, removeTree } from './mailbox-cleanup.js';

export interface JanitorOptions {
  db: AdminDb;
  logger: Logger;
  mailRoot: string;
  intervalSeconds: number;
  /** Сколько карантинов убирать за один проход. */
  batch?: number;
}

export interface JanitorRunResult {
  purgedMaildirs: number;
  bytesFreed: number;
  closedSessions: number;
  removedImportJobs: number;
  orphanMaildirs: number;
}

export class AdminJanitor {
  readonly #opts: JanitorOptions;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(opts: JanitorOptions) {
    this.#opts = opts;
  }

  start(): void {
    const seconds = this.#opts.intervalSeconds;
    if (seconds <= 0 || this.#timer) return;
    this.#timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.#opts.logger.warn(errorInfo(err), 'Проход уборщика админки не удался');
      });
    }, seconds * 1000);
    // Процесс не должен держаться на свете ради уборщика.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Один проход. Возвращает, что именно сделано, — для теста и журнала. */
  async runOnce(): Promise<JanitorRunResult> {
    const result: JanitorRunResult = {
      purgedMaildirs: 0,
      bytesFreed: 0,
      closedSessions: 0,
      removedImportJobs: 0,
      orphanMaildirs: 0,
    };
    // Проходы не должны наезжать друг на друга: удаление большого ящика
    // может не уложиться в интервал.
    if (this.#running) return result;
    this.#running = true;
    try {
      const { db, logger } = this.#opts;

      /* --- 1. карантин -> диск свободен --- */
      const pending = await db.listDeletionsToPurge(this.#opts.batch ?? 20);
      for (const row of pending) {
        if (!row.quarantinePath) {
          // Каталога не было вовсе — убирать нечего, закрываем запись.
          await db.updateMailboxDeletion(row.id, { state: 'purged', purged: true });
          continue;
        }
        try {
          const bytes = await removeTree(row.quarantinePath);
          await db.updateMailboxDeletion(row.id, {
            state: 'purged',
            purged: true,
            bytesFreed: bytes,
            error: null,
          });
          result.purgedMaildirs += 1;
          result.bytesFreed += bytes;
          logger.info(
            { email: row.email, bytes, path: row.quarantinePath },
            'Каталог удалённого ящика убран с диска',
          );
        } catch (err) {
          await db.updateMailboxDeletion(row.id, {
            bumpAttempts: true,
            error: err instanceof Error ? err.message : String(err),
          });
          logger.warn(errorInfo(err, { email: row.email }), 'Не удалось убрать каталог ящика');
        }
      }

      /* --- 2. брошенные сеансы входа в чужой ящик --- */
      result.closedSessions = await db.expireStaleMailboxAccess();
      if (result.closedSessions > 0) {
        logger.info(
          { closed: result.closedSessions },
          'Закрыты записи о входе в чужой ящик с истёкшим сроком',
        );
      }

      /* --- 3. просроченные задания импорта --- */
      result.removedImportJobs = await db.deleteExpiredImportJobs();

      /* --- 4. осиротевшие каталоги: только сообщаем --- */
      const emails = await db.listAllMailboxEmails();
      const orphans = await findOrphanMaildirs(this.#opts.mailRoot, emails);
      result.orphanMaildirs = orphans.length;
      if (orphans.length > 0) {
        logger.warn(
          { count: orphans.length, sample: orphans.slice(0, 10) },
          'В почтовом хранилище есть каталоги, которым не соответствует ни один ящик. ' +
            'Сами не удаляем: каталог мог быть заведён вручную',
        );
      }
      return result;
    } finally {
      this.#running = false;
    }
  }
}
