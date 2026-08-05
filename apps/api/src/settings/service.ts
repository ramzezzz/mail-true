/**
 * Сервис настроек ящика: связывает базу (источник истины) с личным
 * файлом правил Sieve в почтовом хранилище.
 *
 * Главный инвариант: после любого изменения правил или автоответчика
 * файл Sieve переписывается целиком из базы. Частичных правок файла нет
 * вовсе — иначе рано или поздно файл и база разойдутся, и объяснить,
 * почему фильтр «не работает», станет невозможно.
 */
import type { Logger } from 'pino';
import { ApiError } from '../errors.js';
import type { SettingsConfig } from './config.js';
import type { SettingsDb } from './db.js';
import { isUndefinedTable } from './db.js';
import { buildSieveScript } from './sieve.js';
import { SieveStore, SieveStoreError } from './store.js';
import type { FilterRule, MailSettings } from './types.js';
import { errorInfo } from '../log.js';

/** Настройки недоступны: нет базы или не применена миграция. */
export class SettingsUnavailableError extends ApiError {
  constructor(message = 'Настройки ящика недоступны: не настроена база данных') {
    super(503, 'SETTINGS_UNAVAILABLE', message);
  }
}

/** Состояние синхронизации правил с почтовым хранилищем. */
export interface SieveSyncState {
  /** Транспорт до хранилища: local | docker | off. */
  transport: string;
  /** Путь действующего файла правил. */
  path: string;
  /** Правил в файле (включённых). */
  activeRules: number;
  /** Файл записан и скомпилирован. */
  ok: boolean;
  /**
   * Файл правил лежит в ящике и будет применён к почте.
   *
   * Отдельно от `ok`: без компилятора рядом (в контейнере нет sievec)
   * правила ЗАПИСАНЫ и работают, их соберёт сам Dovecot при доставке.
   * Пока признак был один, интерфейс сообщал «правила не работают» и в
   * этом случае — то есть пугал впустую в самом частом из них.
   */
  written: boolean;
  /** Что пошло не так (пусто — всё хорошо). */
  error: string;
}

export interface SettingsServiceOptions {
  config: SettingsConfig;
  db: SettingsDb | null;
  store: SieveStore;
  logger: Logger;
}

export class SettingsService {
  readonly #config: SettingsConfig;
  readonly #db: SettingsDb | null;
  readonly #store: SieveStore;
  readonly #logger: Logger;

  constructor(opts: SettingsServiceOptions) {
    this.#config = opts.config;
    this.#db = opts.db;
    this.#store = opts.store;
    this.#logger = opts.logger;
  }

  get config(): SettingsConfig {
    return this.#config;
  }

  get store(): SieveStore {
    return this.#store;
  }

  /** База настроек или понятный отказ. */
  requireDb(): SettingsDb {
    if (!this.#db) throw new SettingsUnavailableError();
    return this.#db;
  }

  get available(): boolean {
    return this.#db !== null;
  }

  /**
   * Пересобирает личный файл правил из базы.
   *
   * Ошибка записи не откатывает изменение в базе: правило уже сохранено
   * и видно пользователю. Но и молчать нельзя — состояние возвращается
   * наружу и показывается в интерфейсе, чтобы «правило есть, а не
   * работает» было видно сразу, а не через неделю.
   */
  async syncSieve(email: string): Promise<SieveSyncState> {
    const db = this.requireDb();
    let rules: FilterRule[] = [];
    let settings: MailSettings | null = null;
    try {
      rules = await db.listFilters(email);
      settings = await db.getSettings(email);
    } catch (err) {
      if (isUndefinedTable(err)) throw new SettingsUnavailableError(MIGRATION_HINT);
      throw err;
    }

    const active = rules.filter((r) => r.enabled);
    const needsScript = active.length > 0 || settings.autoReply.enabled;
    const state: SieveSyncState = {
      transport: this.#store.transport,
      path: this.#store.activePath(email),
      activeRules: active.length,
      ok: false,
      written: false,
      error: '',
    };

    if (!this.#store.enabled) {
      state.error = 'Транспорт Sieve выключен (SIEVE_TRANSPORT=off): правила лежат только в базе';
      return state;
    }

    try {
      if (!needsScript) {
        await this.#store.remove(email);
        state.ok = true;
        // Правил нет вовсе — и файла быть не должно: это тоже «доехало».
        state.written = true;
        return state;
      }
      const script = buildSieveScript(rules, { accountEmail: email, settings });
      const result = await this.#store.write(email, script);
      state.ok = result.compiled;
      state.written = result.written;
      state.path = result.activePath;
      if (!result.compiled) state.error = result.compilerOutput || 'Скрипт не скомпилирован';
      return state;
    } catch (err) {
      const message =
        err instanceof SieveStoreError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.#logger.error(errorInfo(err, { email }), 'Не удалось записать личный файл правил Sieve');
      state.error = message;
      return state;
    }
  }

  /** Текст действующего файла правил — для раздела «Фильтры» в настройках. */
  async readSieve(email: string): Promise<string | null> {
    return this.#store.read(email);
  }
}

export const MIGRATION_HINT =
  'Таблиц настроек нет. Примените infra/postgres/migrations/0005_settings_accounts.sql ' +
  'к работающей базе — до этого настройки и фильтры недоступны.';

/**
 * Подсказка для случая «таблицы есть, колонок оформления нет».
 *
 * Отдельно от MIGRATION_HINT нарочно: здесь работает всё, кроме
 * запоминания темы, и отправлять человека применять 0005 (которая уже
 * применена) — значит завести его в тупик.
 */
export const APPEARANCE_MIGRATION_HINT =
  'Оформление не запоминается: в таблице настроек нет колонок theme/wallpaper. ' +
  'Примените infra/postgres/migrations/0009_appearance.sql к работающей базе.';
