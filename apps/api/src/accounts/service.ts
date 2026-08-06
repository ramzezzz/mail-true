/**
 * Сервис внешних и связанных ящиков.
 *
 * Собирает вместе: базу (кто к чему подключён), шифрование паролей,
 * пул соединений с чужими серверами и планировщик сбора почты.
 *
 * Планировщик живёт здесь, а не в отдельном процессе, сознательно:
 * сбор — это редкая и короткая задача (раз в 15 минут на подключение),
 * ради неё отдельный демон с собственным развёртыванием не окупается.
 * Если сборов станет много, вынести планировщик можно, не трогая
 * маршруты: он общается с остальным кодом только через базу.
 */
import type { Logger } from 'pino';
import type { ImapEndpoint } from '@mail-true/migrate';
import { ApiError } from '../errors.js';
import type { AppConfig } from '../config.js';
import type { AccountsConfig } from './config.js';
import type { AccountsDb, ExternalAccountSecret } from './db.js';
import { collectOnce, type CollectResult } from './collector.js';
import { ExternalImapPool } from './direct.js';
import type { ExternalSecretBox } from './secret.js';
import type { ExternalAccount, ExternalAccountInput } from './types.js';
import { errorInfo } from '../log.js';

/**
 * Подключение «как будто уже сохранённое» — нужно, чтобы проверить
 * настройки тем же кодом, что работает с сохранёнными подключениями.
 */
function previewAccount(input: ExternalAccountInput): ExternalAccount {
  return {
    id: 0,
    address: input.address,
    label: input.label,
    mode: input.mode,
    imap: {
      host: input.imapHost,
      port: input.imapPort,
      secure: input.imapSecure,
      user: input.imapUser,
    },
    smtp: null,
    allowInsecureTls: input.allowInsecureTls,
    targetFolder: input.targetFolder,
    collectScope: input.collectScope,
    intervalMinutes: input.intervalMinutes,
    enabled: input.enabled,
    state: {
      lastRunAt: null,
      lastOkAt: null,
      status: 'never',
      error: null,
      lastCopied: 0,
      lastSkipped: 0,
      lastFailed: 0,
      lastDurationMs: 0,
      totalCopied: 0,
      runs: 0,
    },
    createdAt: new Date(0).toISOString(),
  };
}

/** Модуль недоступен: нет базы, миграции или ключа шифрования. */
export class AccountsUnavailableError extends ApiError {
  constructor(message = 'Подключение ящиков недоступно') {
    super(503, 'ACCOUNTS_UNAVAILABLE', message);
  }
}

export const MIGRATION_HINT =
  'Таблиц внешних ящиков нет. Примените ' +
  'infra/postgres/migrations/0005_settings_accounts.sql к работающей базе.';

export interface AccountsServiceOptions {
  config: AccountsConfig;
  appConfig: AppConfig;
  db: AccountsDb | null;
  secretBox: ExternalSecretBox | null;
  secretBoxReason: string | null;
  logger: Logger;
}

export class AccountsService {
  readonly #config: AccountsConfig;
  readonly #appConfig: AppConfig;
  readonly #db: AccountsDb | null;
  readonly #secretBox: ExternalSecretBox | null;
  readonly #secretBoxReason: string | null;
  readonly #logger: Logger;
  readonly #pool: ExternalImapPool;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;

  constructor(opts: AccountsServiceOptions) {
    this.#config = opts.config;
    this.#appConfig = opts.appConfig;
    this.#db = opts.db;
    this.#secretBox = opts.secretBox;
    this.#secretBoxReason = opts.secretBoxReason;
    this.#logger = opts.logger;
    this.#pool = new ExternalImapPool({
      idleMs: opts.appConfig.IMAP_POOL_IDLE_MS,
      rejectUnauthorized: opts.appConfig.TLS_REJECT_UNAUTHORIZED,
      logger: opts.logger,
    });
  }

  get config(): AccountsConfig {
    return this.#config;
  }

  get externalPool(): ExternalImapPool {
    return this.#pool;
  }

  get available(): boolean {
    return this.#db !== null && this.#config.EXTERNAL_ACCOUNTS_ENABLED;
  }

  /** База или понятный отказ. */
  requireDb(): AccountsDb {
    if (!this.#db) {
      throw new AccountsUnavailableError('Подключение ящиков недоступно: не настроена база данных');
    }
    if (!this.#config.EXTERNAL_ACCOUNTS_ENABLED) {
      throw new AccountsUnavailableError(
        'Подключение ящиков выключено на сервере (EXTERNAL_ACCOUNTS_ENABLED=false)',
      );
    }
    return this.#db;
  }

  /**
   * Шифровальщик паролей или отказ.
   *
   * Без ключа шифрования подключить чужой ящик нельзя — не «можно, но
   * небезопасно», а именно нельзя: класть чужой пароль в базу открытым
   * текстом мы не станем.
   */
  requireSecretBox(): ExternalSecretBox {
    if (!this.#secretBox) {
      throw new AccountsUnavailableError(
        this.#secretBoxReason ?? 'Не задан ключ шифрования паролей внешних ящиков',
      );
    }
    return this.#secretBox;
  }

  get secretsAvailable(): boolean {
    return this.#secretBox !== null;
  }

  get secretsReason(): string | null {
    return this.#secretBoxReason;
  }

  /**
   * Значение allowInsecureTls по умолчанию.
   *
   * Перенос писем выполняет @mail-true/migrate, и он смотрит только на этот
   * флаг: общей настройки сервера он не знает. Поэтому значение по умолчанию
   * берём из неё — иначе в dev-стеке с самоподписанным сертификатом сборщик
   * молча не сможет подключиться, а в production проверка останется строгой.
   */
  get defaultAllowInsecureTls(): boolean {
    return !this.#appConfig.TLS_REJECT_UNAUTHORIZED;
  }

  /** Расшифрованный пароль подключения — только внутри процесса. */
  passwordOf(secret: ExternalAccountSecret): string {
    return this.requireSecretBox().decrypt(secret.passwordEnc);
  }

  /**
   * Проверяет настройки чужого сервера настоящим IMAP-логином ДО
   * сохранения. Мастер подключения обязан сказать «работает» или
   * «не работает» сразу, а не «сохранено, посмотрим завтра».
   */
  async verifySettings(input: ExternalAccountInput, password: string): Promise<void> {
    await this.#pool.verify(previewAccount(input), password);
  }

  /**
   * Подключение к НАШЕМУ Dovecot для сбора почты.
   *
   * Служебный пользователь, а не пароль владельца: сбор идёт по
   * расписанию, когда владелец не в сети. Если служебный доступ не
   * настроен, сбор возможен только из активной сессии — тогда пароль
   * передаётся вторым аргументом.
   */
  destEndpoint(ownerEmail: string, ownerPassword?: string): ImapEndpoint {
    const cfg = this.#appConfig;
    const base = {
      host: cfg.IMAP_HOST,
      port: cfg.IMAP_PORT,
      secure: cfg.IMAP_SECURE,
      ...(cfg.TLS_REJECT_UNAUTHORIZED ? {} : { allowInsecureTls: true }),
    };
    if (this.#config.masterConfigured) {
      return {
        ...base,
        user: `${ownerEmail}${this.#config.DOVECOT_MASTER_SEPARATOR}${this.#config.DOVECOT_MASTER_USER}`,
        pass: this.#config.DOVECOT_MASTER_PASSWORD,
      };
    }
    if (ownerPassword === undefined) {
      throw new AccountsUnavailableError(
        'Служебный пользователь Dovecot не настроен: сбор почты по расписанию невозможен. ' +
          'Задайте DOVECOT_MASTER_USER и DOVECOT_MASTER_PASSWORD.',
      );
    }
    return { ...base, user: ownerEmail, pass: ownerPassword };
  }

  /** Где хранить состояние переноса (докачка и ключи дедупликации). */
  get stateSpec(): string | null {
    return this.#config.databaseUrl ? `pg:${this.#config.databaseUrl}` : null;
  }

  /**
   * Выполняет сбор с одного подключения и записывает состояние.
   * Возвращает null, если сбор этого подключения уже идёт.
   *
   * Ни один путь отсюда не имеет права уйти, не записав итог: пометка
   * 'running' ставится ДО работы, а снимается только {@link AccountsDb.markCollectorDone}.
   * Раньше подготовка параметров (расшифровка пароля, проверка служебного
   * доступа) выполнялась ВНУТРИ вызова `collectOnce(...)`, но за пределами
   * его перехвата ошибок, и любой сбой там уводил исключение наружу мимо
   * `markCollectorDone`. Подключение навсегда застревало в состоянии
   * «идёт сбор»: `listDueCollectors` такие записи не выбирает, а
   * `resetRunning` работает только при старте сервера. В интерфейсе это
   * выглядело как вечное «Идёт первая синхронизация…» — молчание вместо
   * причины. Наблюдалось на живом стенде: подключение с паролем,
   * зашифрованным другим EXTERNAL_ACCOUNTS_KEY, висело так часами.
   */
  async collect(
    ownerEmail: string,
    account: ExternalAccount,
    passwordEnc: string,
    ownerPassword?: string,
  ): Promise<CollectResult | null> {
    const db = this.requireDb();
    const started = await db.markCollectorStart(account.id, this.#config.COLLECTOR_STALE_MINUTES);
    if (!started) return null;

    const startedAt = Date.now();
    const failure = (err: unknown): CollectResult => ({
      status: 'error',
      copied: 0,
      skipped: 0,
      failed: 0,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
      report: null,
    });

    let result: CollectResult;
    try {
      // Подготовка параметров тоже может отказать (чужой ключ шифрования,
      // не настроен служебный доступ) — и это ровно тот отказ, который
      // обязан доехать до пользователя строкой, а не потеряться.
      const password = this.requireSecretBox().decrypt(passwordEnc);
      const dest = this.destEndpoint(ownerEmail, ownerPassword);
      result = await collectOnce({
        account,
        password,
        dest,
        stateSpec: this.stateSpec,
        batchSize: this.#config.COLLECTOR_BATCH_SIZE,
        timeoutMs: this.#config.COLLECTOR_TIMEOUT_MS,
        logger: this.#logger,
      });
    } catch (err) {
      result = failure(err);
    }

    // Запись итога — тоже под защитой: если база отвалилась именно сейчас,
    // подключение останется 'running' до перезапуска, и об этом надо знать.
    await db
      .markCollectorDone(account.id, {
        status: result.status,
        copied: result.copied,
        skipped: result.skipped,
        failed: result.failed,
        durationMs: result.durationMs,
        error: result.error,
      })
      .catch((err: unknown) => {
        this.#logger.error(
          errorInfo(err, { account: account.address }),
          'Не удалось записать итог сбора почты: подключение останется в состоянии «идёт сбор»',
        );
      });
    return result;
  }

  /* ---------------------------------------------------------------- */
  /* Планировщик                                                        */
  /* ---------------------------------------------------------------- */

  /** Запускает периодический сбор. Без служебного доступа не запускается. */
  startScheduler(): void {
    if (!this.#db || !this.#config.COLLECTOR_SCHEDULER) return;
    if (!this.#config.masterConfigured) {
      this.#logger.warn(
        'Планировщик сбора почты не запущен: не настроен служебный пользователь Dovecot ' +
          '(DOVECOT_MASTER_USER/DOVECOT_MASTER_PASSWORD). Сбор доступен только вручную.',
      );
      return;
    }
    if (!this.#secretBox) {
      this.#logger.warn(
        { reason: this.#secretBoxReason },
        'Планировщик сбора почты не запущен: нет ключа шифрования паролей',
      );
      return;
    }
    // Состояние 'running' могло остаться от прерванного перезапуском сбора.
    this.#db
      .resetRunning()
      .then((n) => {
        if (n > 0) this.#logger.warn({ count: n }, 'Сброшены зависшие состояния сборщика');
      })
      .catch(() => undefined);

    this.#timer = setInterval(() => void this.tick(), this.#config.COLLECTOR_TICK_MS);
    this.#timer.unref?.();
    this.#logger.info(
      { everyMs: this.#config.COLLECTOR_TICK_MS },
      'Планировщик сбора почты с внешних ящиков запущен',
    );
  }

  stopScheduler(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Один проход планировщика: собрать с тех, кому пора.
   *
   * Каждое подключение обрабатывается отдельно от соседей. Раньше весь
   * проход был под одним `try`, и первое же неисправное подключение
   * обрывало цикл: остальные ящики в этот проход не собирались, а в
   * следующий проход история повторялась. Одна чужая опечатка в настройках
   * останавливала сбор у всех.
   */
  async tick(): Promise<number> {
    if (this.#ticking || !this.#db) return 0;
    this.#ticking = true;
    try {
      const due = await this.#db.listDueCollectors(
        this.#config.COLLECTOR_CONCURRENCY,
        this.#config.COLLECTOR_STALE_MINUTES,
      );
      let done = 0;
      for (const item of due) {
        try {
          const result = await this.collect(item.ownerEmail, item.account, item.passwordEnc);
          if (result) {
            done += 1;
            this.#logger.info(
              {
                account: item.account.address,
                owner: item.ownerEmail,
                copied: result.copied,
                skipped: result.skipped,
                status: result.status,
              },
              'Сбор почты с внешнего ящика завершён',
            );
          }
        } catch (err) {
          this.#logger.warn(
            errorInfo(err, { account: item.account.address, owner: item.ownerEmail }),
            'Сбор почты с внешнего ящика не удался, остальные подключения продолжаем',
          );
        }
      }
      return done;
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Проход планировщика сбора почты не удался');
      return 0;
    } finally {
      this.#ticking = false;
    }
  }

  async close(): Promise<void> {
    this.stopScheduler();
    await this.#pool.closeAll().catch(() => undefined);
    if (this.#db) await this.#db.close().catch(() => undefined);
  }
}
