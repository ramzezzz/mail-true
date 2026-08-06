/**
 * Доступ к базе для заглушённых цепочек (таблица muted_threads,
 * миграция 0029).
 *
 * Отдельное подключение к Postgres, как у меток и отложенных писем: почта
 * обязана читаться и без базы. Нет базы — нет возможности заглушить
 * переписку, и интерфейс узнаёт об этом честно (`available: false`),
 * а не показывает кнопку, которая молча ничего не делает.
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';

/** Состояние записи. Живое только одно — 'muted'. */
export type MuteState = 'muted' | 'lifted';

/** Заглушённая переписка. */
export interface MutedRow {
  id: number;
  accountEmail: string;
  /** Ключ переписки: Message-ID её корневого письма (без угловых скобок). */
  threadKey: string;
  /** Message-ID писем переписки — из них собирается условие Sieve. */
  messageIds: string[];
  subject: string;
  fromAddress: string;
  state: MuteState;
  createdAt: string;
}

/** Что кладём в базу, заглушая переписку. */
export interface MuteInsert {
  accountEmail: string;
  threadKey: string;
  messageIds: string[];
  subject: string;
  fromAddress: string;
}

interface MutedRowRaw extends QueryResultRow {
  id: string;
  account_email: string;
  thread_key: string;
  message_ids: string[] | null;
  subject: string;
  from_address: string;
  state: string;
  created_at: Date;
}

const COLUMNS = `id, account_email, thread_key, message_ids, subject, from_address,
       state, created_at`;

function toRow(raw: MutedRowRaw): MutedRow {
  return {
    id: Number(raw.id),
    accountEmail: raw.account_email,
    threadKey: raw.thread_key,
    messageIds: raw.message_ids ?? [],
    subject: raw.subject,
    fromAddress: raw.from_address,
    state: raw.state as MuteState,
    createdAt: raw.created_at.toISOString(),
  };
}

/**
 * Хранилище заглушённых цепочек.
 *
 * Интерфейс, а не только класс: служба общается с базой только через него,
 * поэтому проверки подставляют сюда хранилище в памяти и проверяют ПОРЯДОК
 * действий (запись, файл правил, перенос писем) без Postgres.
 */
export interface MuteStore {
  /** Применена ли миграция 0029. */
  schemaReady(): Promise<boolean>;
  /**
   * Заглушает переписку. Повторное заглушение той же переписки не заводит
   * дубль, а ДОПОЛНЯЕТ список идентификаторов: за время, пока заглушка была
   * снята, в переписке могли появиться новые письма.
   */
  mute(entry: MuteInsert): Promise<MutedRow>;
  /** Живые записи ящика, недавние первыми. */
  listMuted(accountEmail: string): Promise<MutedRow[]>;
  /** Снимает заглушку. Возвращает false, если такой записи не было. */
  lift(accountEmail: string, threadKey: string): Promise<boolean>;
}

export interface MuteDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

export class MuteDb implements MuteStore {
  readonly #pool: Pool;

  constructor(opts: MuteDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (заглушённые цепочки)'),
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
      `SELECT to_regclass('public.muted_threads') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async mute(entry: MuteInsert): Promise<MutedRow> {
    const rows = await this.#query<MutedRowRaw>(
      /*
       * Объединение списков, а не замена: переписку могли заглушить,
       * потом снять заглушку, потом заглушить снова — и во второй раз
       * старые идентификаторы всё ещё нужны, потому что новые ответы
       * ссылаются в том числе на самые ранние письма.
       */
      `INSERT INTO muted_threads
         (account_email, thread_key, message_ids, subject, from_address)
       VALUES (lower($1), $2, $3::text[], $4, $5)
       ON CONFLICT (lower(account_email), thread_key) DO UPDATE
         SET message_ids = (
               SELECT array_agg(DISTINCT id)
                 FROM unnest(muted_threads.message_ids || EXCLUDED.message_ids) AS id
             ),
             subject = EXCLUDED.subject,
             from_address = EXCLUDED.from_address,
             state = 'muted',
             lifted_at = NULL,
             updated_at = now()
       RETURNING ${COLUMNS}`,
      [entry.accountEmail, entry.threadKey, entry.messageIds, entry.subject, entry.fromAddress],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось записать заглушённую цепочку');
    return toRow(row);
  }

  async listMuted(accountEmail: string): Promise<MutedRow[]> {
    const rows = await this.#query<MutedRowRaw>(
      `SELECT ${COLUMNS} FROM muted_threads
        WHERE lower(account_email) = lower($1) AND state = 'muted'
        ORDER BY created_at DESC`,
      [accountEmail],
    );
    return rows.map(toRow);
  }

  async lift(accountEmail: string, threadKey: string): Promise<boolean> {
    const rows = await this.#query<{ id: string }>(
      `UPDATE muted_threads
          SET state = 'lifted', lifted_at = now(), updated_at = now()
        WHERE lower(account_email) = lower($1) AND thread_key = $2 AND state = 'muted'
       RETURNING id`,
      [accountEmail, threadKey],
    );
    return rows.length > 0;
  }
}
