/**
 * Хранилище сохранённых запросов (таблица mail_saved_searches, миграция 0027).
 *
 * Устроено ровно так же, как справочник меток (labels-db.ts), и это не
 * копирование ради копирования: у обоих одно и то же требование — почта
 * обязана работать без базы. Нет базы — нет сохранённых запросов, и
 * интерфейс узнаёт об этом честно (`available: false`), а не показывает
 * список, который молча ничего не сохраняет.
 *
 * Наружу торчит ИНТЕРФЕЙС, а не класс: маршруты общаются с хранилищем
 * только через него, поэтому проверки подставляют сюда хранилище в памяти
 * и проверяют всё поведение без Postgres.
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { SavedSearch } from './saved-searches.js';

export interface SavedSearchDraft {
  name: string;
  query: string;
  includeJunk: boolean;
}

export interface SavedSearchStore {
  /** Применена ли миграция 0027. */
  schemaReady(): Promise<boolean>;
  list(accountEmail: string): Promise<SavedSearch[]>;
  /** Заводит запрос. `null` — имя уже занято. */
  create(accountEmail: string, draft: SavedSearchDraft): Promise<SavedSearch | null>;
  /** Убирает запрос. `null` — такого не было. */
  remove(accountEmail: string, id: string): Promise<SavedSearch | null>;
}

interface SavedSearchRow extends QueryResultRow {
  id: string;
  name: string;
  query: string;
  include_junk: boolean;
  position: number;
}

function toSaved(row: SavedSearchRow): SavedSearch {
  return {
    id: String(row.id),
    name: row.name,
    query: row.query,
    includeJunk: row.include_junk,
    position: row.position,
  };
}

/** Отсутствующая таблица (42P01) — миграция 0027 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/** Нарушение уникальности (23505) — имя уже занято. */
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

export interface SavedSearchesDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

export class SavedSearchesDb implements SavedSearchStore {
  readonly #pool: Pool;

  constructor(opts: SavedSearchesDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (сохранённые запросы)'),
    );
  }

  async shutdown(): Promise<void> {
    await this.#pool.end();
  }

  async #query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(text, values);
    return result.rows;
  }

  async schemaReady(): Promise<boolean> {
    const rows = await this.#query<{ ok: boolean }>(
      `SELECT to_regclass('public.mail_saved_searches') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async list(accountEmail: string): Promise<SavedSearch[]> {
    const rows = await this.#query<SavedSearchRow>(
      `SELECT id, name, query, include_junk, position FROM mail_saved_searches
        WHERE lower(account_email) = lower($1)
        ORDER BY position, id`,
      [accountEmail],
    );
    return rows.map(toSaved);
  }

  async create(accountEmail: string, draft: SavedSearchDraft): Promise<SavedSearch | null> {
    try {
      const rows = await this.#query<SavedSearchRow>(
        `INSERT INTO mail_saved_searches (account_email, name, query, include_junk, position)
         VALUES (lower($1), $2, $3, $4,
                 coalesce((SELECT max(position) + 1 FROM mail_saved_searches
                            WHERE lower(account_email) = lower($1)), 0))
         RETURNING id, name, query, include_junk, position`,
        [accountEmail, draft.name, draft.query, draft.includeJunk],
      );
      const row = rows[0];
      if (!row) throw new Error('Не удалось сохранить запрос');
      return toSaved(row);
    } catch (err) {
      /*
       * Занятое имя ловится по ответу базы, а не только проверкой перед
       * вставкой. Проверка перед вставкой — это гонка: два нажатия подряд
       * (или повтор запроса при обрыве связи) обе успевают её пройти, и в
       * списке появляется два одинаковых имени.
       */
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async remove(accountEmail: string, id: string): Promise<SavedSearch | null> {
    // Идентификатор приходит строкой из адреса; в базе он BIGSERIAL.
    // Приведение делает сама база ($2::bigint), а не разбор в коде: так
    // мимо не проедет ни «12abc», ни число, не влезающее в bigint.
    if (!/^\d{1,19}$/u.test(id)) return null;
    const rows = await this.#query<SavedSearchRow>(
      `DELETE FROM mail_saved_searches
        WHERE lower(account_email) = lower($1) AND id = $2::bigint
       RETURNING id, name, query, include_junk, position`,
      [accountEmail, id],
    );
    return rows[0] ? toSaved(rows[0]) : null;
  }
}

/**
 * Хранилище в памяти — для проверок.
 *
 * Живёт рядом с настоящим, а не в файле проверок, потому что должно
 * повторять его поведение слово в слово: порядок, отказ на занятое имя и
 * `null` на удаление несуществующего. Разошлись бы — проверки перестали бы
 * что-либо доказывать.
 */
export class MemorySavedSearchStore implements SavedSearchStore {
  readonly #byAccount = new Map<string, SavedSearch[]>();
  #nextId = 1;

  #bucket(accountEmail: string): SavedSearch[] {
    const key = accountEmail.toLowerCase();
    const found = this.#byAccount.get(key);
    if (found) return found;
    const created: SavedSearch[] = [];
    this.#byAccount.set(key, created);
    return created;
  }

  async schemaReady(): Promise<boolean> {
    return true;
  }

  async list(accountEmail: string): Promise<SavedSearch[]> {
    return this.#bucket(accountEmail)
      .slice()
      .sort((a, b) => a.position - b.position);
  }

  async create(accountEmail: string, draft: SavedSearchDraft): Promise<SavedSearch | null> {
    const bucket = this.#bucket(accountEmail);
    if (bucket.some((s) => s.name.toLowerCase() === draft.name.toLowerCase())) return null;
    const position = bucket.reduce((max, s) => Math.max(max, s.position + 1), 0);
    const saved: SavedSearch = {
      id: String(this.#nextId),
      name: draft.name,
      query: draft.query,
      includeJunk: draft.includeJunk,
      position,
    };
    this.#nextId += 1;
    bucket.push(saved);
    return saved;
  }

  async remove(accountEmail: string, id: string): Promise<SavedSearch | null> {
    const bucket = this.#bucket(accountEmail);
    const index = bucket.findIndex((s) => s.id === id);
    const removed = bucket[index];
    if (!removed) return null;
    bucket.splice(index, 1);
    return removed;
  }
}
