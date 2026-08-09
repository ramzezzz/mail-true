/**
 * Хранилище справочника своих меток (таблица mail_labels, миграция 0018).
 *
 * Отдельное подключение к Postgres, как у настроек и отложенных писем:
 * почта обязана читаться и без базы. Нет базы — нет справочника, и
 * интерфейс узнаёт об этом честно (`available: false`), а не показывает
 * раздел, который молча ничего не сохраняет.
 *
 * Наружу торчит ИНТЕРФЕЙС, а не класс: маршруты общаются с хранилищем
 * только через него, поэтому проверки подставляют сюда хранилище в памяти
 * и проверяют всё поведение справочника без Postgres.
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import {
  buildLabelKey,
  DEFAULT_LABEL_COLOR,
  isLabelColor,
  type LabelColor,
  type UserLabel,
} from './labels.js';

export interface LabelDraft {
  name: string;
  color: LabelColor;
}

export interface LabelPatch {
  name?: string | undefined;
  color?: LabelColor | undefined;
}

export interface LabelStore {
  /** Применена ли миграция 0018. */
  schemaReady(): Promise<boolean>;
  list(accountEmail: string): Promise<UserLabel[]>;
  /** Заводит метку и выдаёт ей ключ; ключ дальше не меняется никогда. */
  create(accountEmail: string, draft: LabelDraft): Promise<UserLabel>;
  /** Правит имя и цвет. Ключ не трогается — он лежит в письмах. */
  update(accountEmail: string, key: string, patch: LabelPatch): Promise<UserLabel | null>;
  /**
   * Убирает метку из справочника. Ключевые слова в письмах не трогает.
   *
   * `purged` — сняли ли ключевое слово с писем. Если нет, ключ обязан
   * остаться занятым: иначе следующая метка с тем же именем получит его
   * и окажется на письмах, которых человек ею не помечал.
   */
  remove(accountEmail: string, key: string, purged?: boolean): Promise<UserLabel | null>;
}

interface LabelRow extends QueryResultRow {
  label_key: string;
  name: string;
  color: string;
  position: number;
}

function toLabel(row: LabelRow): UserLabel {
  return {
    key: row.label_key,
    name: row.name,
    // Цвет, которого продукт больше не знает (метку завела прежняя версия),
    // не должен ронять весь справочник — он показывается цветом по умолчанию.
    color: isLabelColor(row.color) ? row.color : DEFAULT_LABEL_COLOR,
    position: row.position,
  };
}

/** Отсутствующая таблица (42P01) — миграция 0018 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

export interface LabelsDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

export class LabelsDb implements LabelStore {
  readonly #pool: Pool;

  constructor(opts: LabelsDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (метки)'),
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
      `SELECT to_regclass('public.mail_labels') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async list(accountEmail: string): Promise<UserLabel[]> {
    const rows = await this.#query<LabelRow>(
      `SELECT label_key, name, color, position FROM mail_labels
        WHERE lower(account_email) = lower($1) AND deleted_at IS NULL
        ORDER BY position, id`,
      [accountEmail],
    );
    return rows.map(toLabel);
  }

  async create(accountEmail: string, draft: LabelDraft): Promise<UserLabel> {
    /*
     * Ключ подбирается по УЖЕ занятым: две метки «Счета» получат
     * `mt-scheta` и `mt-scheta-2`, а не откажут человеку в имени.
     *
     * Занятыми считаются и ключи УДАЛЁННЫХ меток. Удаление без снятия с
     * писем (purge=0) оставляет ключевое слово на письмах — обещание
     * ровно такое, — и выдать этот ключ заново значит нацепить новую
     * метку на чужие письма: человек их так не помечал. Ловится это не
     * только на точном совпадении имени: «Счета» и «Счёта» дают один
     * ключ (ё → e в транслитерации).
     */
    const key = buildLabelKey(draft.name, await this.#takenKeys(accountEmail));
    const rows = await this.#query<LabelRow>(
      `INSERT INTO mail_labels (account_email, label_key, name, color, position)
       VALUES (lower($1), $2, $3, $4,
               coalesce((SELECT max(position) + 1 FROM mail_labels
                          WHERE lower(account_email) = lower($1)), 0))
       RETURNING label_key, name, color, position`,
      [accountEmail, key, draft.name, draft.color],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось создать метку');
    return toLabel(row);
  }

  async update(accountEmail: string, key: string, patch: LabelPatch): Promise<UserLabel | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}`);
    };
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.color !== undefined) put('color', patch.color);
    if (sets.length === 0) {
      const rows = await this.#query<LabelRow>(
        `SELECT label_key, name, color, position FROM mail_labels
          WHERE lower(account_email) = lower($1) AND label_key = $2`,
        [accountEmail, key],
      );
      return rows[0] ? toLabel(rows[0]) : null;
    }
    values.push(accountEmail, key);
    const rows = await this.#query<LabelRow>(
      `UPDATE mail_labels SET ${sets.join(', ')}, updated_at = now()
        WHERE lower(account_email) = lower($${String(values.length - 1)})
          AND label_key = $${String(values.length)}
       RETURNING label_key, name, color, position`,
      values,
    );
    return rows[0] ? toLabel(rows[0]) : null;
  }

  /** Все ключи ящика, включая удалённые метки: их слова ещё на письмах. */
  async #takenKeys(accountEmail: string): Promise<string[]> {
    const rows = await this.#query<{ label_key: string }>(
      `SELECT label_key FROM mail_labels WHERE lower(account_email) = lower($1)`,
      [accountEmail],
    );
    return rows.map((row) => row.label_key);
  }

  /**
   * Убирает метку из справочника.
   *
   * `purged` — сняли ли ключевое слово с самих писем. От этого зависит
   * судьба строки: если слова на письмах остались, строка помечается
   * удалённой и ключ остаётся занятым навсегда (иначе следующая метка с
   * тем же именем получила бы его и оказалась на чужих письмах). Если
   * снятие прошло полностью, слова нет нигде — строку можно стереть, а
   * ключ выдавать заново.
   */
  async remove(accountEmail: string, key: string, purged = false): Promise<UserLabel | null> {
    const rows = purged
      ? await this.#query<LabelRow>(
          `DELETE FROM mail_labels
            WHERE lower(account_email) = lower($1) AND label_key = $2
           RETURNING label_key, name, color, position`,
          [accountEmail, key],
        )
      : await this.#query<LabelRow>(
          `UPDATE mail_labels SET deleted_at = now()
            WHERE lower(account_email) = lower($1) AND label_key = $2 AND deleted_at IS NULL
           RETURNING label_key, name, color, position`,
          [accountEmail, key],
        );
    return rows[0] ? toLabel(rows[0]) : null;
  }
}

/**
 * Справочник в памяти — для проверок.
 *
 * Живёт рядом с настоящим, а не в файле проверок, потому что должен
 * повторять его поведение слово в слово: выдачу ключей, порядок и ответ
 * `null` на правку несуществующей метки. Разошлись бы — проверки перестали
 * бы что-либо доказывать.
 */
export class MemoryLabelStore implements LabelStore {
  readonly #byAccount = new Map<string, UserLabel[]>();

  #bucket(accountEmail: string): UserLabel[] {
    const key = accountEmail.toLowerCase();
    const found = this.#byAccount.get(key);
    if (found) return found;
    const created: UserLabel[] = [];
    this.#byAccount.set(key, created);
    return created;
  }

  async schemaReady(): Promise<boolean> {
    return true;
  }

  async list(accountEmail: string): Promise<UserLabel[]> {
    return this.#bucket(accountEmail)
      .slice()
      .sort((a, b) => a.position - b.position);
  }

  async create(accountEmail: string, draft: LabelDraft): Promise<UserLabel> {
    const bucket = this.#bucket(accountEmail);
    const key = buildLabelKey(
      draft.name,
      // Ключи удалённых меток тоже заняты: их слова ещё на письмах.
      [...bucket.map((l) => l.key), ...(this.#retired.get(accountEmail.toLowerCase()) ?? [])],
    );
    const position = bucket.reduce((max, l) => Math.max(max, l.position + 1), 0);
    const label: UserLabel = { key, name: draft.name, color: draft.color, position };
    bucket.push(label);
    return label;
  }

  async update(accountEmail: string, key: string, patch: LabelPatch): Promise<UserLabel | null> {
    const bucket = this.#bucket(accountEmail);
    const index = bucket.findIndex((l) => l.key === key);
    const current = bucket[index];
    if (!current) return null;
    const next: UserLabel = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    };
    bucket[index] = next;
    return next;
  }

  /** Ключи удалённых меток: в памяти держим отдельным списком. */
  readonly #retired = new Map<string, string[]>();

  async remove(accountEmail: string, key: string, purged = false): Promise<UserLabel | null> {
    const bucket = this.#bucket(accountEmail);
    const index = bucket.findIndex((l) => l.key === key);
    const removed = bucket[index];
    if (!removed) return null;
    bucket.splice(index, 1);
    if (!purged) {
      // Слово осталось на письмах — ключ занят навсегда.
      const email = accountEmail.toLowerCase();
      this.#retired.set(email, [...(this.#retired.get(email) ?? []), key]);
    }
    return removed;
  }
}
