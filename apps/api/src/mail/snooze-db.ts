/**
 * Доступ к базе для отложенных писем (таблица snoozed_messages,
 * миграция 0015).
 *
 * Отдельное подключение к Postgres, как у настроек и внешних ящиков: почта
 * обязана читаться и без базы. Нет базы — нет возможности отложить письмо,
 * и интерфейс об этом узнаёт честно (`available: false`), а не показывает
 * кнопку, которая молча ничего не делает.
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { SnoozePreset } from './snooze-schedule.js';

/** Состояние записи. Живое только одно — 'pending'. */
export type SnoozeState = 'pending' | 'returned' | 'cancelled' | 'gone';

/** Отложенное письмо, каким его видит и работник, и список «Отложенных». */
export interface SnoozedRow {
  id: number;
  accountEmail: string;
  snoozePath: string;
  snoozeUid: number;
  snoozeUidValidity: number;
  originPath: string;
  messageId: string | null;
  subject: string;
  fromAddress: string;
  /** Момент возврата (ISO). */
  wakeAt: string;
  timeZone: string | null;
  preset: SnoozePreset;
  state: SnoozeState;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

/** Что кладём в базу, отложив письмо. */
export interface SnoozeInsert {
  accountEmail: string;
  snoozePath: string;
  snoozeUid: number;
  snoozeUidValidity: number;
  originPath: string;
  messageId: string | null;
  subject: string;
  fromAddress: string;
  wakeAt: Date;
  timeZone: string | null;
  preset: SnoozePreset;
}

interface SnoozeRowRaw extends QueryResultRow {
  id: string;
  account_email: string;
  snooze_path: string;
  snooze_uid: string;
  snooze_uidvalidity: string;
  origin_path: string;
  message_id: string | null;
  subject: string;
  from_address: string;
  wake_at: Date;
  time_zone: string | null;
  preset: string;
  state: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

const COLUMNS = `id, account_email, snooze_path, snooze_uid::text AS snooze_uid,
       snooze_uidvalidity::text AS snooze_uidvalidity, origin_path, message_id,
       subject, from_address, wake_at, time_zone, preset, state, attempts,
       last_error, created_at`;

function toRow(raw: SnoozeRowRaw): SnoozedRow {
  return {
    id: Number(raw.id),
    accountEmail: raw.account_email,
    snoozePath: raw.snooze_path,
    snoozeUid: Number(raw.snooze_uid),
    snoozeUidValidity: Number(raw.snooze_uidvalidity),
    originPath: raw.origin_path,
    messageId: raw.message_id,
    subject: raw.subject,
    fromAddress: raw.from_address,
    wakeAt: raw.wake_at.toISOString(),
    timeZone: raw.time_zone,
    preset: raw.preset as SnoozePreset,
    state: raw.state as SnoozeState,
    attempts: raw.attempts,
    lastError: raw.last_error,
    createdAt: raw.created_at.toISOString(),
  };
}

/** Отсутствующая таблица (42P01) — миграция 0015 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/**
 * Хранилище отложенных писем.
 *
 * Интерфейс, а не только класс: работник и маршруты общаются с базой
 * только через него, поэтому проверки подставляют сюда хранилище в памяти
 * и проверяют ПОРЯДОК действий (копия, запись, удаление) без Postgres.
 */
export interface SnoozeStore {
  /** Применена ли миграция 0015. */
  schemaReady(): Promise<boolean>;
  add(entry: SnoozeInsert): Promise<SnoozedRow>;
  /** Живые записи ящика, ближайший срок первым. */
  listPending(accountEmail: string): Promise<SnoozedRow[]>;
  /** Записи, которым пора возвращаться (по всем ящикам). */
  listDue(now: Date, limit: number): Promise<SnoozedRow[]>;
  /** Живые записи ящика по идентификаторам письма в «Отложенных». */
  findPendingByUids(
    accountEmail: string,
    snoozePath: string,
    uids: number[],
  ): Promise<SnoozedRow[]>;
  /** Закрывает запись: письмо вернулось, отменено или пропало. */
  close(id: number, state: Exclude<SnoozeState, 'pending'>, note?: string | null): Promise<void>;
  /** Отмечает неудачную попытку возврата. Запись остаётся живой. */
  markAttempt(id: number, error: string): Promise<number>;
}

export interface SnoozeDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

export class SnoozeDb implements SnoozeStore {
  readonly #pool: Pool;

  constructor(opts: SnoozeDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (отложенные письма)'),
    );
  }

  /** Закрывает пул. Называется не `close`, чтобы не спорить с close(id, …). */
  async shutdown(): Promise<void> {
    await this.#pool.end();
  }

  async #query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(text, values);
    return result.rows;
  }

  async schemaReady(): Promise<boolean> {
    const rows = await this.#query<{ ok: boolean }>(
      `SELECT to_regclass('public.snoozed_messages') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async add(entry: SnoozeInsert): Promise<SnoozedRow> {
    const rows = await this.#query<SnoozeRowRaw>(
      `INSERT INTO snoozed_messages
         (account_email, snooze_path, snooze_uid, snooze_uidvalidity, origin_path,
          message_id, subject, from_address, wake_at, time_zone, preset)
       VALUES (lower($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${COLUMNS}`,
      [
        entry.accountEmail,
        entry.snoozePath,
        entry.snoozeUid,
        entry.snoozeUidValidity,
        entry.originPath,
        entry.messageId,
        entry.subject,
        entry.fromAddress,
        entry.wakeAt.toISOString(),
        entry.timeZone,
        entry.preset,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось записать отложенное письмо');
    return toRow(row);
  }

  async listPending(accountEmail: string): Promise<SnoozedRow[]> {
    const rows = await this.#query<SnoozeRowRaw>(
      `SELECT ${COLUMNS} FROM snoozed_messages
        WHERE lower(account_email) = lower($1) AND state = 'pending'
        ORDER BY wake_at`,
      [accountEmail],
    );
    return rows.map(toRow);
  }

  async listDue(now: Date, limit: number): Promise<SnoozedRow[]> {
    /*
     * ОТСТУП ПОСЛЕ НЕУДАЧНОЙ ПОПЫТКИ — ЗАЩИТА ВСЕЙ ОЧЕРЕДИ.
     *
     * Отбор идёт по сроку и с пределом на проход, поэтому записи,
     * которые падают КАЖДЫЙ раз (удалили или переименовали служебную
     * папку, повредился индекс поиска), всегда оказываются первыми: они
     * самые старые по сроку. Сотни таких записей — а это один ящик с
     * сотней отложенных писем — занимали весь проход целиком, и до
     * остальных ящиков работник не доходил НИКОГДА. В журнале при этом
     * не было ни слова о том, что очередь встала.
     *
     * Предела попыток здесь нет намеренно (см. шапку службы): письмо не
     * должно пропасть из-за временной поломки. Но и держать им очередь
     * нельзя, поэтому после каждой неудачи запись отходит в сторону —
     * на минуту за попытку, но не больше часа. Временная поломка
     * задержит возврат на минуту, постоянная перестанет мешать соседям.
     */
    const rows = await this.#query<SnoozeRowRaw>(
      `SELECT ${COLUMNS} FROM snoozed_messages
        WHERE state = 'pending' AND wake_at <= $1
          AND (last_attempt_at IS NULL
               OR last_attempt_at <= $1::timestamptz - make_interval(mins => least(attempts, 60)))
        ORDER BY wake_at
        LIMIT $2`,
      [now.toISOString(), limit],
    );
    return rows.map(toRow);
  }

  async findPendingByUids(
    accountEmail: string,
    snoozePath: string,
    uids: number[],
  ): Promise<SnoozedRow[]> {
    if (uids.length === 0) return [];
    const rows = await this.#query<SnoozeRowRaw>(
      `SELECT ${COLUMNS} FROM snoozed_messages
        WHERE lower(account_email) = lower($1) AND snooze_path = $2
          AND state = 'pending' AND snooze_uid = ANY($3::bigint[])
        ORDER BY wake_at`,
      [accountEmail, snoozePath, uids],
    );
    return rows.map(toRow);
  }

  async close(
    id: number,
    state: Exclude<SnoozeState, 'pending'>,
    note: string | null = null,
  ): Promise<void> {
    await this.#query(
      `UPDATE snoozed_messages
          SET state = $2::varchar, last_error = $3::text,
              closed_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'pending'`,
      [id, state, note],
    );
  }

  async markAttempt(id: number, error: string): Promise<number> {
    const rows = await this.#query<{ attempts: number }>(
      `UPDATE snoozed_messages
          SET attempts = attempts + 1, last_error = $2,
              last_attempt_at = now(), updated_at = now()
        WHERE id = $1
       RETURNING attempts`,
      [id, error],
    );
    return rows[0]?.attempts ?? 0;
  }
}
