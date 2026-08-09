/**
 * Служба «восстановления после очистки корзины»: перенос очищенного
 * в служебную папку, возврат по просьбе человека и работник, который
 * удаляет по-настоящему, когда срок вышел.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ УДАЛЯЕТ СЕРВЕР, А НЕ БРАУЗЕР
 * ------------------------------------------------------------------
 * По той же причине, по какой возвращает отложенные письма сервер:
 * возможность имеет смысл ровно тогда, когда человек ушёл. Он очистил
 * корзину и закрыл вкладку — и через семь дней письма обязаны исчезнуть,
 * даже если он не заходил всю неделю. Таймер в браузере этого не умеет,
 * а «удалим, когда зайдёт» означало бы ящик, забитый мусором у того, кто
 * пользуется почтой с телефона.
 *
 * ------------------------------------------------------------------
 * ЧТО БУДЕТ ПРИ ПЕРЕЗАПУСКЕ КОНТЕЙНЕРА
 * ------------------------------------------------------------------
 * Ничего. Срок лежит в Postgres, «зависших» состояний у записи нет: пока
 * письмо не удалено, запись остаётся 'pending'. Работник, поднявшись,
 * первым же проходом заберёт всё, чему срок настал, пока сервер лежал.
 *
 * ------------------------------------------------------------------
 * ЧТО БУДЕТ, ЕСЛИ В СРОК НЕДОСТУПЕН DOVECOT
 * ------------------------------------------------------------------
 * Запись останется живой, число попыток вырастет, причина ляжет в
 * last_error — следующий проход попробует снова. Предела попыток нет:
 * недоступность почтового сервера проходит сама, а «сдались» означало бы
 * письма, которые никогда не освободят место в ящике.
 */
import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import type { Folder } from '@mail-true/shared';
import type { AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { existingUids } from '../imap/service.js';
import { errorInfo } from '../log.js';
import { masterLogin } from '../mail/snooze-service.js';
import type { SettingsConfig } from './config.js';
import type { OwnerStore, RecoveryRow } from './owner-db.js';
import {
  ensureRecoveryFolder,
  locateRecovered,
  moveToRecovery,
  type RecoveryPlacement,
  readRecoverySource,
  resolveRestorePath,
  returnFromRecovery,
} from './recovery-mailbox.js';

/** Сколько записей удаляет один проход работника. */
export const RECOVERY_BATCH = 200;

/**
 * Срок по умолчанию — тот же, что в миграции 0025.
 *
 * Повторяется в коде намеренно и с этой пометкой: строки настроек у ящика
 * может ещё не быть (человек ни разу их не открывал), и «нет строки» не
 * должно означать «не хранить». Поведение до и после первого сохранения
 * обязано совпадать. Семь дней — как у Fastmail.
 */
export const DEFAULT_RECOVERY_DAYS = 7;

/** Возможности нет: не применена миграция или нет базы. */
export class RecoveryUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, 'RECOVERY_UNAVAILABLE', message);
  }
}

export interface RecoveryServiceOptions {
  config: AppConfig;
  settings: SettingsConfig;
  logger: Logger;
  store: OwnerStore | null;
  master: { user: string; password: string; separator: string } | null;
  connect?: ((email: string) => Promise<ImapFlow>) | undefined;
}

/** Итог очистки корзины: что уехало на хранение, а что удалено сразу. */
export interface SweepResult {
  /** Сколько писем можно будет вернуть. */
  kept: number;
  /** Сколько удалено немедленно (срок хранения выключен или не сохранились). */
  removed: number;
  /** До какого момента можно вернуть; null — хранение выключено. */
  restoreUntil: string | null;
}

export class RecoveryService {
  readonly #opts: RecoveryServiceOptions;
  #store: OwnerStore | null;
  #reason: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(opts: RecoveryServiceOptions) {
    this.#opts = opts;
    this.#store = opts.store;
  }

  attachStore(store: OwnerStore): void {
    this.#store = store;
    this.#reason = null;
  }

  disable(reason: string): void {
    this.#store = null;
    this.#reason = reason;
  }

  get available(): boolean {
    return this.#store !== null;
  }

  /**
   * Удаление по сроку возможно: вдобавок настроен служебный вход.
   *
   * Разделено намеренно, как у отложенных писем. Без базы возможности нет
   * вовсе. Без служебного входа письма СОХРАНЯТЬ можно, а удалить их в
   * срок будет некому — то есть ящик тихо забьётся. Предупреждать об этом
   * надо ДО того, как человек на возможность понадеется, поэтому раздел
   * настроек показывает это отдельной строкой.
   */
  get scheduledPurgeAvailable(): boolean {
    return this.available && this.#opts.master !== null;
  }

  get unavailableReason(): string | null {
    return this.#reason;
  }

  #requireStore(): OwnerStore {
    const store = this.#store;
    if (!store) {
      throw new RecoveryUnavailableError(
        this.#reason ?? 'Восстановление писем недоступно: не настроена база данных',
      );
    }
    return store;
  }

  /** Потолок срока, заданный сервером. */
  get maxDays(): number {
    return this.#opts.settings.TRASH_RECOVERY_MAX_DAYS;
  }

  /**
   * Сколько дней этот ящик хранит очищенное.
   *
   * Строки настроек может ещё не быть — человек ни разу их не открывал.
   * Это НЕ «ноль дней»: умолчание задаёт миграция, и поведение до и после
   * первого сохранения обязано совпадать. Потолок применяется здесь же:
   * администратор мог уменьшить TRASH_RECOVERY_MAX_DAYS уже после того,
   * как человек выбрал себе срок побольше.
   */
  async daysFor(accountEmail: string): Promise<number> {
    const store = this.#requireStore();
    const saved = await store.getRecoveryDays(accountEmail);
    const days = saved ?? DEFAULT_RECOVERY_DAYS;
    return Math.min(Math.max(days, 0), this.maxDays);
  }

  /* ---------------------------------------------------------------- */
  /* Очистка корзины                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Переносит письма очищаемой папки на хранение.
   *
   * Порядок и разбор обрывов — в recovery-mailbox.ts, в заголовке файла.
   * Здесь он собран воедино и намеренно не разнесён по слоям: «перенос,
   * запись» должно читаться одним куском.
   *
   * `days === 0` означает «не хранить»: вызывающий в этом случае сюда не
   * заходит вовсе и удаляет как раньше. Проверка всё равно есть — чтобы
   * ошибка вызова не превращалась в молчаливое хранение того, что человек
   * просил стереть.
   */
  async sweep(
    client: ImapFlow,
    accountEmail: string,
    source: Folder,
    uids: number[],
    days: number,
    now: Date = new Date(),
  ): Promise<SweepResult> {
    const store = this.#requireStore();
    if (days <= 0 || uids.length === 0) {
      return { kept: 0, removed: 0, restoreUntil: null };
    }

    const target = await ensureRecoveryFolder(client);
    const purgeAt = new Date(now.getTime() + days * 24 * 3600_000);

    /* Шаг 1: перенос. Под блокировкой очищаемой папки — и только она. */
    let placements: RecoveryPlacement[] = [];
    /** Перенос оборвался посреди нарезки — сказать об этом после записи. */
    let moveFailure: Error | null = null;
    let present: number[] = [];
    const lock = await client.getMailboxLock(source.path);
    try {
      present = await existingUids(client, uids);
      if (present.length === 0) return { kept: 0, removed: 0, restoreUntil: null };
      const info = await readRecoverySource(client, present);
      /*
       * Перенос может уехать наполовину: список номеров режется на
       * команды, и вторая порция способна упереться в обрыв связи. То,
       * что уже переехало, обязано попасть в базу — иначе письма
       * останутся в скрытой служебной папке навсегда, не видимые ни в
       * почте, ни в разделе возврата, и работник удаления по сроку их не
       * найдёт (он читает базу). Поэтому сначала записываем перенесённое,
       * и только потом сообщаем об отказе.
       */
      const outcome = await moveToRecovery(client, target, present, info);
      if (Array.isArray(outcome)) {
        placements = outcome;
      } else {
        placements = outcome.placements;
        moveFailure = outcome.failure;
      }
    } finally {
      lock.release();
    }

    /*
     * Сервер не подтвердил перенос номерами (нет расширения UIDPLUS).
     * Письма перенесены, но записать о них нечего — значит, вернуть их
     * через интерфейс мы не сможем и обещать этого не будем. Считаем их
     * удалёнными: в списке «что можно вернуть» их не будет, а сироты
     * в служебной папке видны отдельной строкой (см. summary).
     */
    if (placements.length === 0) {
      if (moveFailure) throw moveFailure;
      return { kept: 0, removed: present.length, restoreUntil: null };
    }

    /*
     * Шаг 2: запись сроков. И ОТКАТ ПЕРЕНОСА, ЕСЛИ ЗАПИСАТЬ НЕ ВЫШЛО.
     *
     * Письма к этому моменту уже в служебной папке «Recovery», а она
     * скрыта из дерева папок. Пока о письме нет записи в базе, оно не
     * видно НИГДЕ: ни в почте, ни в разделе «Восстановление писем» (тот
     * строится по базе), и работник удаления по сроку его тоже не найдёт
     * — он читает ту же базу. То есть письмо остаётся на диске навсегда,
     * ест квоту и при этом считается удалённым.
     *
     * Достижимо это было буднично: записи создавались по одной в цикле,
     * на корзине в тысячи писем — тысячи запросов подряд. Любой сбой или
     * таймаут посреди цикла (пул на три соединения) оставлял остаток
     * перенесённым и незаписанным, а маршрут отвечал 500.
     *
     * Поэтому: пишем всё одним запросом, а если он не удался — возвращаем
     * письма обратно в ту папку, откуда взяли. Тогда «очистить» либо
     * сработало целиком, либо не изменило ничего, и человеку есть что
     * повторить.
     */
    try {
      await store.addRecoveryBatch(
        placements.map((placement) => ({
          accountEmail,
          recoveryPath: target.path,
          recoveryUid: placement.recoveryUid,
          recoveryUidValidity: placement.recoveryUidValidity,
          originPath: source.path,
          messageId: placement.info.messageId,
          subject: placement.info.subject,
          fromAddress: placement.info.fromAddress,
          sentAt: placement.info.sentAt,
          sizeBytes: placement.info.sizeBytes,
          purgeAt,
        })),
      );
    } catch (err) {
      await returnFromRecovery(
        client,
        target,
        source.path,
        placements.map((p) => p.recoveryUid),
      ).catch(() => undefined);
      throw err;
    }

    /*
     * Записали то, что успело переехать, — теперь можно честно сказать,
     * что дальше не пошло. Человек увидит отказ и повторит очистку;
     * уже перенесённые письма к тому моменту видны в разделе возврата и
     * никуда не денутся.
     */
    if (moveFailure) throw moveFailure;

    return {
      kept: placements.length,
      removed: present.length - placements.length,
      restoreUntil: purgeAt.toISOString(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Список, возврат, немедленное удаление                             */
  /* ---------------------------------------------------------------- */

  async list(accountEmail: string, limit: number): Promise<RecoveryRow[]> {
    return this.#requireStore().listRecovery(accountEmail, limit);
  }

  async totals(accountEmail: string): Promise<{ count: number; bytes: number }> {
    return this.#requireStore().recoveryTotals(accountEmail);
  }

  /**
   * Возвращает письма обратно в корзину.
   *
   * Ровно в корзину, а не в исходную папку письма: человек нажал
   * «восстановить» на том, что сам же выбросил, — он ждёт письмо там,
   * откуда оно исчезло, и уже оттуда решает, куда его положить.
   */
  async restore(
    client: ImapFlow,
    accountEmail: string,
    ids: number[],
  ): Promise<{ restored: number; missing: number }> {
    const store = this.#requireStore();
    const rows = await store.findRecovery(accountEmail, ids);
    if (rows.length === 0) return { restored: 0, missing: ids.length };

    const folder = await ensureRecoveryFolder(client);
    let restored = 0;
    let missing = 0;

    const lock = await client.getMailboxLock(folder.path);
    try {
      for (const row of rows) {
        const uid = await locateRecovered(client, folder, row);
        if (uid === null) {
          // Письма в служебной папке больше нет: человек убрал его
          // почтовой программой. Закрываем запись молча — падать из-за
          // письма, которое он сам и убрал, значит остановить возврат
          // всех остальных.
          await store.closeRecovery(row.id, 'gone');
          missing += 1;
          continue;
        }
        const target = await resolveRestorePath(client, row.originPath);
        await client.messageMove([uid], target, { uid: true });
        await store.closeRecovery(row.id, 'restored');
        restored += 1;
      }
    } finally {
      lock.release();
    }
    return { restored, missing };
  }

  /**
   * Удаляет по-настоящему, не дожидаясь срока.
   *
   * Кнопка не для красоты: письма на хранении едят настоящую квоту
   * ящика, и человеку, у которого кончается место, нужен способ вернуть
   * его немедленно.
   */
  async purgeNow(
    client: ImapFlow,
    accountEmail: string,
    ids: number[] | 'all',
  ): Promise<{ purged: number }> {
    const store = this.#requireStore();
    const rows =
      ids === 'all'
        ? await store.listRecovery(accountEmail, 100_000)
        : await store.findRecovery(accountEmail, ids);
    if (rows.length === 0) return { purged: 0 };
    const folder = await ensureRecoveryFolder(client);
    const purged = await this.#purgeRows(client, folder, store, rows);
    return { purged };
  }

  /** Общая часть немедленного удаления и удаления по сроку. */
  async #purgeRows(
    client: ImapFlow,
    folder: Folder,
    store: OwnerStore,
    rows: readonly RecoveryRow[],
  ): Promise<number> {
    let purged = 0;
    const lock = await client.getMailboxLock(folder.path);
    try {
      for (const row of rows) {
        try {
          const uid = await locateRecovered(client, folder, row);
          if (uid === null) {
            await store.closeRecovery(row.id, 'gone');
            continue;
          }
          await client.messageDelete([uid], { uid: true });
          await store.closeRecovery(row.id, 'purged');
          purged += 1;
        } catch (err) {
          // Одно неудавшееся письмо не должно останавливать остальные:
          // запись остаётся живой и попадёт в следующий проход.
          await store.markRecoveryAttempt(row.id, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      lock.release();
    }
    return purged;
  }

  /* ---------------------------------------------------------------- */
  /* Работник                                                          */
  /* ---------------------------------------------------------------- */

  start(intervalMs = this.#opts.settings.TRASH_RECOVERY_TICK_MS): void {
    if (this.#timer || !this.available) return;
    if (!this.#opts.master) {
      this.#opts.logger.warn(
        'Удаление по сроку выключено: не настроен служебный пользователь Dovecot ' +
          '(DOVECOT_MASTER_USER/DOVECOT_MASTER_PASSWORD). Очищенные письма будут ' +
          'храниться, пока человек не удалит их сам.',
      );
      return;
    }
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
    this.#opts.logger.info({ everyMs: intervalMs }, 'Удаление очищенного по сроку запущено');
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #connect(email: string): Promise<ImapFlow> {
    if (this.#opts.connect) return this.#opts.connect(email);
    const master = this.#opts.master;
    if (!master) throw new Error('Служебный пользователь Dovecot не настроен');
    const config = this.#opts.config;
    const client = new ImapFlow({
      host: config.IMAP_HOST,
      port: config.IMAP_PORT,
      secure: config.IMAP_SECURE,
      auth: { user: masterLogin(email, master.user, master.separator), pass: master.password },
      tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
      logger: false,
      disableAutoIdle: true,
      clientInfo: { name: 'Mail.True Recovery', version: '0.1.0' },
    });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  /**
   * Один проход: удалить всё, чему вышел срок.
   *
   * Наружу не бросает ничего: это фоновая задача, и её отказ обязан
   * оказаться в журнале, а не уронить процесс.
   */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.#running || !this.available) return 0;
    this.#running = true;
    let purged = 0;
    try {
      const store = this.#requireStore();
      const due = await store.listRecoveryDue(now, RECOVERY_BATCH);
      if (due.length === 0) return 0;

      // Записи группируются по ящикам: одно соединение на ящик, а не на
      // письмо. На тысяче просроченных писем одного человека разница
      // между этим и «соединение на запись» — тысяча входов в Dovecot.
      const byAccount = new Map<string, RecoveryRow[]>();
      for (const row of due) {
        const list = byAccount.get(row.accountEmail) ?? [];
        list.push(row);
        byAccount.set(row.accountEmail, list);
      }

      for (const [email, rows] of byAccount) {
        let client: ImapFlow | null = null;
        try {
          client = await this.#connect(email);
          const folder = await ensureRecoveryFolder(client);
          purged += await this.#purgeRows(client, folder, store, rows);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          for (const row of rows) {
            await store.markRecoveryAttempt(row.id, reason).catch(() => undefined);
          }
          this.#opts.logger.warn(
            { ...errorInfo(err), account: email },
            'Не удалось удалить очищенные письма по сроку',
          );
        } finally {
          await client?.logout().catch(() => undefined);
        }
      }
    } catch (err) {
      this.#opts.logger.warn(errorInfo(err), 'Проход удаления очищенного не удался');
    } finally {
      this.#running = false;
    }
    return purged;
  }
}
