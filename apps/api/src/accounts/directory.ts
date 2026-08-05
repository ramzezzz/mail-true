/**
 * Справка о ящике из таблицы почтового стека `virtual_users`.
 *
 * Зачем отдельный крошечный модуль. `GET /api/account` отдавал дату
 * создания `1970-01-01`: она была зашита как `new Date(0)`. По IMAP дату
 * заведения ящика узнать нельзя вовсе — её знает только база, в которой
 * ящик и заводится (`virtual_users.created_at`, миграция 0001_init.sql).
 *
 * Своё подключение — как у админки, помощника ИИ и настроек: почтовый API
 * обязан работать и без базы. Нет базы или нет строки — честный `null`,
 * а не выдуманная дата: «01.01.1970» в профиле хуже, чем пустое поле.
 *
 * Значение кэшируется: дата создания не меняется, а ходить в базу на
 * каждое открытие почты незачем.
 */
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';

export interface AccountDirectoryOptions {
  connectionString: string | null;
  logger: Logger;
}

/** Сколько помним ответ базы (и её отсутствие). */
const CACHE_TTL_MS = 10 * 60 * 1000;

export class AccountDirectory {
  private pool: Pool | null = null;
  private readonly cache = new Map<string, { value: string | null; at: number }>();

  constructor(private readonly options: AccountDirectoryOptions) {}

  /** Есть ли вообще куда ходить. */
  get available(): boolean {
    return Boolean(this.options.connectionString);
  }

  private getPool(): Pool | null {
    if (!this.options.connectionString) return null;
    this.pool ??= new Pool({
      connectionString: this.options.connectionString,
      max: 2,
      // Профиль — не тот запрос, ради которого стоит держать соединение
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3000,
    });
    return this.pool;
  }

  /** Дата заведения ящика в ISO или null, если узнать неоткуда. */
  async createdAt(email: string): Promise<string | null> {
    const key = email.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    let value: string | null = null;
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query<{ created_at: Date }>(
          'SELECT created_at FROM virtual_users WHERE lower(email) = $1 LIMIT 1',
          [key]
        );
        const row = res.rows[0];
        if (row?.created_at) value = new Date(row.created_at).toISOString();
      } catch (err) {
        // Профиль должен открываться и при недоступной базе
        this.options.logger.warn(errorInfo(err), 'Не удалось прочитать дату создания ящика');
      }
    }
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  async close(): Promise<void> {
    if (this.pool) {
      const pool = this.pool;
      this.pool = null;
      await pool.end().catch(() => undefined);
    }
  }
}
