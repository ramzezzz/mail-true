/**
 * Доступ к базе для внешних и связанных ящиков.
 *
 * Открытых паролей здесь нет ни в одном месте: наружу отдаётся
 * {@link ExternalAccount} без пароля, а расшифровка происходит только
 * в момент подключения к чужому серверу (collector.ts / direct.ts).
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type {
  CollectScope,
  CollectorState,
  CollectorStatus,
  ExternalAccount,
  ExternalAccountInput,
  ExternalAccountPatch,
  ExternalMode,
  LinkedAccount,
} from './types.js';

export interface AccountsDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

interface ExternalRow extends QueryResultRow {
  id: string;
  owner_email: string;
  address: string;
  label: string | null;
  mode: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  imap_user: string;
  password_enc: string;
  allow_insecure_tls: boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  target_folder: string;
  collect_scope: string;
  interval_minutes: number;
  enabled: boolean;
  last_run_at: Date | null;
  last_ok_at: Date | null;
  last_status: string;
  last_error: string | null;
  last_copied: number;
  last_skipped: number;
  last_failed: number;
  last_duration_ms: number;
  total_copied: string;
  runs: number;
  created_at: Date;
}

interface LinkedRow extends QueryResultRow {
  id: string;
  linked_email: string;
  label: string | null;
  password_enc: string;
  position: number;
  created_at: Date;
}

const EXTERNAL_COLUMNS = `id, owner_email, address, label, mode,
       imap_host, imap_port, imap_secure, imap_user, password_enc, allow_insecure_tls,
       smtp_host, smtp_port, smtp_secure, smtp_user,
       target_folder, collect_scope, interval_minutes, enabled,
       last_run_at, last_ok_at, last_status, last_error,
       last_copied, last_skipped, last_failed, last_duration_ms,
       total_copied::text AS total_copied, runs, created_at`;

function toState(row: ExternalRow): CollectorState {
  return {
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    status: row.last_status as CollectorStatus,
    error: row.last_error,
    lastCopied: row.last_copied,
    lastSkipped: row.last_skipped,
    lastFailed: row.last_failed,
    lastDurationMs: row.last_duration_ms,
    totalCopied: Number(row.total_copied),
    runs: row.runs,
  };
}

/** Строка базы -> внешний ящик без пароля. */
export function toExternalAccount(row: ExternalRow): ExternalAccount {
  return {
    id: Number(row.id),
    address: row.address,
    label: row.label,
    mode: row.mode as ExternalMode,
    imap: {
      host: row.imap_host,
      port: row.imap_port,
      secure: row.imap_secure,
      user: row.imap_user,
    },
    smtp:
      row.smtp_host && row.smtp_port
        ? {
            host: row.smtp_host,
            port: row.smtp_port,
            secure: row.smtp_secure,
            user: row.smtp_user ?? row.imap_user,
          }
        : null,
    allowInsecureTls: row.allow_insecure_tls,
    targetFolder: row.target_folder,
    collectScope: row.collect_scope as CollectScope,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled,
    state: toState(row),
    createdAt: row.created_at.toISOString(),
  };
}

/** Внешний ящик вместе с шифротекстом пароля — только для внутреннего употребления. */
export interface ExternalAccountSecret {
  account: ExternalAccount;
  ownerEmail: string;
  passwordEnc: string;
}

/** Отсутствующая таблица (42P01) — миграция 0005 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/** Нарушение уникальности (23505) — такой ящик уже подключён. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

export class AccountsDb {
  readonly #pool: Pool;

  constructor(opts: AccountsDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Только суть ошибки: объект pg тянет за собой состояние соединения
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (внешние ящики)'),
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(text, values);
    return result.rows;
  }

  async one<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, values);
    return rows[0] ?? null;
  }

  async connect(): Promise<PoolClient> {
    return this.#pool.connect();
  }

  /** Применена ли миграция 0005. */
  async schemaReady(): Promise<boolean> {
    const row = await this.one<{ ok: boolean }>(
      `SELECT to_regclass('public.external_accounts') IS NOT NULL AS ok`,
    );
    return row?.ok === true;
  }

  /* ---------------------------------------------------------------- */
  /* Внешние ящики                                                      */
  /* ---------------------------------------------------------------- */

  async listExternal(ownerEmail: string): Promise<ExternalAccount[]> {
    const rows = await this.query<ExternalRow>(
      `SELECT ${EXTERNAL_COLUMNS} FROM external_accounts
        WHERE lower(owner_email) = lower($1) ORDER BY id`,
      [ownerEmail],
    );
    return rows.map(toExternalAccount);
  }

  async findExternal(ownerEmail: string, id: number): Promise<ExternalAccountSecret | null> {
    const row = await this.one<ExternalRow>(
      `SELECT ${EXTERNAL_COLUMNS} FROM external_accounts
        WHERE id = $1 AND lower(owner_email) = lower($2)`,
      [id, ownerEmail],
    );
    if (!row) return null;
    return {
      account: toExternalAccount(row),
      ownerEmail: row.owner_email,
      passwordEnc: row.password_enc,
    };
  }

  async createExternal(
    ownerEmail: string,
    input: ExternalAccountInput,
    passwordEnc: string,
  ): Promise<ExternalAccount> {
    const row = await this.one<ExternalRow>(
      `INSERT INTO external_accounts
         (owner_email, address, label, mode,
          imap_host, imap_port, imap_secure, imap_user, password_enc, allow_insecure_tls,
          smtp_host, smtp_port, smtp_secure, smtp_user,
          target_folder, collect_scope, interval_minutes, enabled)
       VALUES (lower($1), lower($2), $3, $4,
               $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14,
               $15, $16, $17, $18)
       RETURNING ${EXTERNAL_COLUMNS}`,
      [
        ownerEmail,
        input.address,
        input.label,
        input.mode,
        input.imapHost,
        input.imapPort,
        input.imapSecure,
        input.imapUser,
        passwordEnc,
        input.allowInsecureTls,
        input.smtpHost,
        input.smtpPort,
        input.smtpSecure,
        input.smtpUser,
        input.targetFolder,
        input.collectScope,
        input.intervalMinutes,
        input.enabled,
      ],
    );
    if (!row) throw new Error('Не удалось создать подключение внешнего ящика');
    return toExternalAccount(row);
  }

  /**
   * Изменяет подключение. Пароль передаётся отдельно и только когда его
   * действительно меняют: смена папки-приёмника не должна требовать
   * повторного ввода пароля от чужого сервера.
   */
  async updateExternal(
    ownerEmail: string,
    id: number,
    patch: ExternalAccountPatch,
    passwordEnc?: string,
  ): Promise<ExternalAccount | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}`);
    };
    if (patch.label !== undefined) put('label', patch.label);
    if (patch.mode !== undefined) put('mode', patch.mode);
    if (patch.imapHost !== undefined) put('imap_host', patch.imapHost);
    if (patch.imapPort !== undefined) put('imap_port', patch.imapPort);
    if (patch.imapSecure !== undefined) put('imap_secure', patch.imapSecure);
    if (patch.imapUser !== undefined) put('imap_user', patch.imapUser);
    if (patch.allowInsecureTls !== undefined) put('allow_insecure_tls', patch.allowInsecureTls);
    if (patch.smtpHost !== undefined) put('smtp_host', patch.smtpHost);
    if (patch.smtpPort !== undefined) put('smtp_port', patch.smtpPort);
    if (patch.smtpSecure !== undefined) put('smtp_secure', patch.smtpSecure);
    if (patch.smtpUser !== undefined) put('smtp_user', patch.smtpUser);
    if (patch.targetFolder !== undefined) put('target_folder', patch.targetFolder);
    if (patch.collectScope !== undefined) put('collect_scope', patch.collectScope);
    if (patch.intervalMinutes !== undefined) put('interval_minutes', patch.intervalMinutes);
    if (patch.enabled !== undefined) put('enabled', patch.enabled);
    if (passwordEnc !== undefined) put('password_enc', passwordEnc);

    if (sets.length > 0) {
      values.push(id, ownerEmail);
      await this.query(
        `UPDATE external_accounts SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${String(values.length - 1)}
            AND lower(owner_email) = lower($${String(values.length)})`,
        values,
      );
    }
    const found = await this.findExternal(ownerEmail, id);
    return found?.account ?? null;
  }

  async deleteExternal(ownerEmail: string, id: number): Promise<boolean> {
    const rows = await this.query<{ id: string }>(
      `DELETE FROM external_accounts WHERE id = $1 AND lower(owner_email) = lower($2)
       RETURNING id`,
      [id, ownerEmail],
    );
    return rows.length > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Состояние сборщика                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Помечает начало сбора. Возвращает false, если сбор уже идёт:
   * два одновременных сбора одного ящика — верный способ получить дубли
   * и заблокировать учётную запись на чужом сервере.
   *
   * «Уже идёт» проверяется по времени, а не только по пометке. Пометка
   * могла остаться от процесса, которого больше нет (убит на середине
   * сбора, либо это вообще другой экземпляр сервера) — и тогда без срока
   * давности подключение не собиралось бы уже никогда: `resetRunning`
   * приводит записи в порядок только при старте, а `listDueCollectors`
   * записи с пометкой не выбирает вовсе.
   */
  async markCollectorStart(id: number, staleMinutes = 30): Promise<boolean> {
    const rows = await this.query<{ id: string }>(
      `UPDATE external_accounts
          SET last_status = 'running', last_run_at = now(), last_error = NULL,
              runs = runs + 1, updated_at = now()
        WHERE id = $1
          AND (last_status <> 'running'
               OR last_run_at IS NULL
               OR last_run_at < now() - make_interval(mins => $2::int))
       RETURNING id`,
      [id, staleMinutes],
    );
    return rows.length > 0;
  }

  async markCollectorDone(
    id: number,
    result: {
      status: CollectorStatus;
      copied: number;
      skipped: number;
      failed: number;
      durationMs: number;
      error: string | null;
    },
  ): Promise<void> {
    await this.query(
      // Явные приведения типов обязательны: один и тот же параметр
      // используется и как значение столбца, и в сравнении, а Postgres
      // отказывается выводить тип сам («inconsistent types deduced»).
      `UPDATE external_accounts
          SET last_status = $2::varchar,
              last_copied = $3::int, last_skipped = $4::int, last_failed = $5::int,
              last_duration_ms = $6::int, last_error = $7::text,
              total_copied = total_copied + $3::int,
              last_ok_at = CASE WHEN $2::varchar = 'ok' THEN now() ELSE last_ok_at END,
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        result.status,
        result.copied,
        result.skipped,
        result.failed,
        Math.round(result.durationMs),
        result.error,
      ],
    );
  }

  /** Сбрасывает зависшее состояние 'running' (перезапуск процесса во время сбора). */
  async resetRunning(): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE external_accounts
          SET last_status = 'error',
              last_error = 'Сбор прерван перезапуском сервера',
              updated_at = now()
        WHERE last_status = 'running'
       RETURNING id`,
    );
    return rows.length;
  }

  /**
   * Подключения, которым пора забирать почту.
   *
   * Брошенная пометка «идёт сбор» (старше `staleMinutes`) не должна
   * исключать подключение навсегда — иначе один убитый на середине сбора
   * процесс останавливает сбор с этого ящика до перезапуска сервера.
   */
  async listDueCollectors(limit: number, staleMinutes = 30): Promise<ExternalAccountSecret[]> {
    const rows = await this.query<ExternalRow>(
      `SELECT ${EXTERNAL_COLUMNS} FROM external_accounts
        WHERE enabled AND mode = 'collector' AND interval_minutes > 0
          AND (last_status <> 'running'
               OR last_run_at IS NULL
               OR last_run_at < now() - make_interval(mins => $2::int))
          AND (last_run_at IS NULL
               OR last_run_at < now() - make_interval(mins => interval_minutes))
        ORDER BY last_run_at NULLS FIRST
        LIMIT $1`,
      [limit, staleMinutes],
    );
    return rows.map((row) => ({
      account: toExternalAccount(row),
      ownerEmail: row.owner_email,
      passwordEnc: row.password_enc,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Связанные свои ящики                                               */
  /* ---------------------------------------------------------------- */

  async listLinked(ownerEmail: string): Promise<LinkedAccount[]> {
    const rows = await this.query<LinkedRow>(
      `SELECT id, linked_email, label, password_enc, position, created_at
         FROM linked_accounts WHERE lower(owner_email) = lower($1)
        ORDER BY position, id`,
      [ownerEmail],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      email: row.linked_email,
      label: row.label,
      position: row.position,
      createdAt: row.created_at.toISOString(),
    }));
  }

  /** Шифротекст пароля связанного ящика — для переключения без ввода пароля. */
  async findLinkedSecret(ownerEmail: string, linkedEmail: string): Promise<string | null> {
    const row = await this.one<{ password_enc: string }>(
      `SELECT password_enc FROM linked_accounts
        WHERE lower(owner_email) = lower($1) AND lower(linked_email) = lower($2)`,
      [ownerEmail, linkedEmail],
    );
    return row?.password_enc ?? null;
  }

  async linkAccount(
    ownerEmail: string,
    linkedEmail: string,
    label: string | null,
    passwordEnc: string,
  ): Promise<LinkedAccount[]> {
    await this.query(
      `INSERT INTO linked_accounts (owner_email, linked_email, label, password_enc, position)
       VALUES (lower($1), lower($2), $3, $4,
               coalesce((SELECT max(position) + 1 FROM linked_accounts
                          WHERE lower(owner_email) = lower($1)), 0))
       ON CONFLICT (lower(owner_email), lower(linked_email))
       DO UPDATE SET password_enc = EXCLUDED.password_enc,
                     label = EXCLUDED.label,
                     updated_at = now()`,
      [ownerEmail, linkedEmail, label, passwordEnc],
    );
    return this.listLinked(ownerEmail);
  }

  async unlinkAccount(ownerEmail: string, linkedEmail: string): Promise<LinkedAccount[]> {
    await this.query(
      `DELETE FROM linked_accounts
        WHERE lower(owner_email) = lower($1) AND lower(linked_email) = lower($2)`,
      [ownerEmail, linkedEmail],
    );
    return this.listLinked(ownerEmail);
  }
}
