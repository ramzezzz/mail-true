/**
 * Доступ к базе для ожидания ответа (таблица awaiting_replies,
 * миграция 0030).
 *
 * Отдельное подключение к Postgres, как у отложенных писем и меток: почта
 * обязана читаться и без базы. Нет базы — нет возможности ждать ответа,
 * и интерфейс узнаёт об этом честно (`available: false`).
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { SnoozePreset } from './snooze-schedule.js';

/** Состояние записи. Живое только одно — 'waiting'. */
export type AwaitState = 'waiting' | 'answered' | 'reminded' | 'cancelled' | 'gone';

/** Чем опознан ответ. Пусто — ответа не было. */
export type AnswerKind = 'references' | 'subject' | null;

export interface AwaitingRow {
  id: number;
  accountEmail: string;
  sentPath: string;
  sentUid: number;
  sentUidValidity: number;
  messageId: string;
  subject: string;
  /** Адреса «Кому» через запятую — в том виде, в каком лежат в базе. */
  toAddresses: string;
  sentAt: string;
  dueAt: string;
  timeZone: string | null;
  preset: SnoozePreset;
  state: AwaitState;
  answerKind: AnswerKind;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface AwaitingInsert {
  accountEmail: string;
  sentPath: string;
  sentUid: number;
  sentUidValidity: number;
  messageId: string;
  subject: string;
  toAddresses: string;
  sentAt: Date;
  dueAt: Date;
  timeZone: string | null;
  preset: SnoozePreset;
}

interface AwaitingRowRaw extends QueryResultRow {
  id: string;
  account_email: string;
  sent_path: string;
  sent_uid: string;
  sent_uidvalidity: string;
  message_id: string;
  subject: string;
  to_addresses: string;
  sent_at: Date;
  due_at: Date;
  time_zone: string | null;
  preset: string;
  state: string;
  answer_kind: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

const COLUMNS = `id, account_email, sent_path, sent_uid::text AS sent_uid,
       sent_uidvalidity::text AS sent_uidvalidity, message_id, subject,
       to_addresses, sent_at, due_at, time_zone, preset, state, answer_kind,
       attempts, last_error, created_at`;

function toRow(raw: AwaitingRowRaw): AwaitingRow {
  return {
    id: Number(raw.id),
    accountEmail: raw.account_email,
    sentPath: raw.sent_path,
    sentUid: Number(raw.sent_uid),
    sentUidValidity: Number(raw.sent_uidvalidity),
    messageId: raw.message_id,
    subject: raw.subject,
    toAddresses: raw.to_addresses,
    sentAt: raw.sent_at.toISOString(),
    dueAt: raw.due_at.toISOString(),
    timeZone: raw.time_zone,
    preset: raw.preset as SnoozePreset,
    state: raw.state as AwaitState,
    answerKind: (raw.answer_kind as AnswerKind) ?? null,
    attempts: raw.attempts,
    lastError: raw.last_error,
    createdAt: raw.created_at.toISOString(),
  };
}

/** Отсутствующая таблица (42P01) — миграция 0030 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/**
 * Хранилище ожиданий ответа.
 *
 * Интерфейс, а не только класс: работник общается с базой только через
 * него, поэтому проверки подставляют сюда хранилище в памяти и проверяют
 * поведение работника без Postgres — в том числе то, ради чего всё и
 * делается: напоминание НЕ приходит, когда ответ есть.
 */
export interface AwaitingStore {
  /** Применена ли миграция 0030. */
  schemaReady(): Promise<boolean>;
  add(entry: AwaitingInsert): Promise<AwaitingRow>;
  /** Живые записи ящика, ближайший срок первым. */
  listWaiting(accountEmail: string): Promise<AwaitingRow[]>;
  /** Записи, которым пора проверяться (по всем ящикам). */
  listDue(now: Date, limit: number): Promise<AwaitingRow[]>;
  /** Закрывает запись. */
  close(
    id: number,
    state: Exclude<AwaitState, 'waiting'>,
    answerKind?: AnswerKind,
    note?: string | null,
  ): Promise<void>;
  /** Отменяет ожидание по идентификатору письма («больше не ждать»). */
  cancelByMessageId(accountEmail: string, messageId: string): Promise<boolean>;
  /** Отмечает неудачную попытку проверки. Запись остаётся живой. */
  markAttempt(id: number, error: string): Promise<number>;
}

export interface AwaitingDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

export class AwaitingDb implements AwaitingStore {
  readonly #pool: Pool;

  constructor(opts: AwaitingDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (ожидание ответа)'),
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
      `SELECT to_regclass('public.awaiting_replies') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async add(entry: AwaitingInsert): Promise<AwaitingRow> {
    const rows = await this.#query<AwaitingRowRaw>(
      `INSERT INTO awaiting_replies
         (account_email, sent_path, sent_uid, sent_uidvalidity, message_id,
          subject, to_addresses, sent_at, due_at, time_zone, preset)
       VALUES (lower($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${COLUMNS}`,
      [
        entry.accountEmail,
        entry.sentPath,
        entry.sentUid,
        entry.sentUidValidity,
        entry.messageId,
        entry.subject,
        entry.toAddresses,
        entry.sentAt.toISOString(),
        entry.dueAt.toISOString(),
        entry.timeZone,
        entry.preset,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось записать ожидание ответа');
    return toRow(row);
  }

  async listWaiting(accountEmail: string): Promise<AwaitingRow[]> {
    const rows = await this.#query<AwaitingRowRaw>(
      `SELECT ${COLUMNS} FROM awaiting_replies
        WHERE lower(account_email) = lower($1) AND state = 'waiting'
        ORDER BY due_at`,
      [accountEmail],
    );
    return rows.map(toRow);
  }

  async listDue(now: Date, limit: number): Promise<AwaitingRow[]> {
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
    const rows = await this.#query<AwaitingRowRaw>(
      `SELECT ${COLUMNS} FROM awaiting_replies
        WHERE state = 'waiting' AND due_at <= $1
          AND (last_attempt_at IS NULL
               OR last_attempt_at <= $1::timestamptz - make_interval(mins => least(attempts, 60)))
        ORDER BY due_at
        LIMIT $2`,
      [now.toISOString(), limit],
    );
    return rows.map(toRow);
  }

  async close(
    id: number,
    state: Exclude<AwaitState, 'waiting'>,
    answerKind: AnswerKind = null,
    note: string | null = null,
  ): Promise<void> {
    await this.#query(
      `UPDATE awaiting_replies
          SET state = $2::varchar,
              answer_kind = $3::varchar,
              last_error = $4::text,
              answered_at = CASE WHEN $2 = 'answered' THEN now() ELSE answered_at END,
              reminded_at = CASE WHEN $2 = 'reminded' THEN now() ELSE reminded_at END,
              closed_at = now(),
              updated_at = now()
        WHERE id = $1 AND state = 'waiting'`,
      [id, state, answerKind, note],
    );
  }

  async cancelByMessageId(accountEmail: string, messageId: string): Promise<boolean> {
    const rows = await this.#query<{ id: string }>(
      `UPDATE awaiting_replies
          SET state = 'cancelled', closed_at = now(), updated_at = now()
        WHERE lower(account_email) = lower($1) AND message_id = $2 AND state = 'waiting'
       RETURNING id`,
      [accountEmail, messageId],
    );
    return rows.length > 0;
  }

  async markAttempt(id: number, error: string): Promise<number> {
    const rows = await this.#query<{ attempts: number }>(
      `UPDATE awaiting_replies
          SET attempts = attempts + 1, last_error = $2,
              last_attempt_at = now(), updated_at = now()
        WHERE id = $1
       RETURNING attempts`,
      [id, error],
    );
    return rows[0]?.attempts ?? 0;
  }
}
