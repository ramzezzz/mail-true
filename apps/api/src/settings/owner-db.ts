/**
 * База трёх возможностей владельца ящика: история входов, выгрузка ящика
 * и восстановление после очистки корзины.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ОДИН МОДУЛЬ НА ТРИ ВОЗМОЖНОСТИ
 * ------------------------------------------------------------------
 * Из-за соединений, а не ради красоты. Каждый раздел продукта заводит
 * СВОЙ пул к Postgres (так сделаны настройки, отложенные письма, метки,
 * контакты) — это правильно: раздел обязан подниматься и падать сам по
 * себе. Но пул — это живые соединения, а их у Postgres конечное число,
 * и три новых пула по два соединения на возможности, которые открывают
 * от силы раз в месяц, — это шесть соединений, занятых постоянно.
 *
 * Поэтому пул здесь один, а возможности остаются независимыми: у каждой
 * своя проверка схемы (`accessReady`, `exportReady`, `recoveryReady`), и
 * не применённая миграция выключает ровно одну из трёх, а не все.
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { AccessChannel } from './access-log.js';

/** Отсутствующая таблица (42P01) — миграция не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/** Нарушение уникального индекса (23505) — живое задание уже есть. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

/* ------------------------------------------------------------------ */
/* История входов                                                       */
/* ------------------------------------------------------------------ */

/** Что записываем своей рукой. Набор проверяет код, а не база. */
export type AccessKind =
  'login' | 'login.failed' | 'logout' | 'settings' | 'filters' | 'folders' | 'trash' | 'export';

export interface AccessInsert {
  accountEmail: string;
  kind: AccessKind;
  channel: AccessChannel;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  detail: string;
}

export interface AccessRow {
  id: number;
  at: string;
  kind: AccessKind;
  channel: AccessChannel;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  detail: string;
}

interface AccessRowRaw extends QueryResultRow {
  id: string;
  at: Date;
  kind: string;
  channel: string;
  success: boolean;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
}

/* ------------------------------------------------------------------ */
/* Выгрузка ящика                                                       */
/* ------------------------------------------------------------------ */

export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled' | 'expired';

export interface ExportRow {
  id: number;
  accountEmail: string;
  state: ExportState;
  includeSpam: boolean;
  includeTrash: boolean;
  totalMessages: number;
  doneMessages: number;
  totalBytes: number;
  doneBytes: number;
  skipped: number;
  filePath: string | null;
  fileBytes: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
}

interface ExportRowRaw extends QueryResultRow {
  id: string;
  account_email: string;
  state: string;
  include_spam: boolean;
  include_trash: boolean;
  total_messages: number;
  done_messages: number;
  total_bytes: string;
  done_bytes: string;
  skipped: number;
  file_path: string | null;
  file_bytes: string;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date | null;
}

const EXPORT_COLUMNS = `id, account_email, state, include_spam, include_trash,
  total_messages, done_messages, total_bytes, done_bytes, skipped,
  file_path, file_bytes, last_error, created_at, started_at, finished_at, expires_at`;

function toExportRow(raw: ExportRowRaw): ExportRow {
  return {
    id: Number(raw.id),
    accountEmail: raw.account_email,
    state: raw.state as ExportState,
    includeSpam: raw.include_spam,
    includeTrash: raw.include_trash,
    totalMessages: raw.total_messages,
    doneMessages: raw.done_messages,
    totalBytes: Number(raw.total_bytes),
    doneBytes: Number(raw.done_bytes),
    skipped: raw.skipped,
    filePath: raw.file_path,
    fileBytes: Number(raw.file_bytes),
    lastError: raw.last_error,
    createdAt: raw.created_at.toISOString(),
    startedAt: raw.started_at?.toISOString() ?? null,
    finishedAt: raw.finished_at?.toISOString() ?? null,
    expiresAt: raw.expires_at?.toISOString() ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Восстановление после очистки корзины                                 */
/* ------------------------------------------------------------------ */

export type RecoveryState = 'pending' | 'restored' | 'purged' | 'gone';

export interface RecoveryInsert {
  accountEmail: string;
  recoveryPath: string;
  recoveryUid: number;
  recoveryUidValidity: number;
  originPath: string;
  messageId: string | null;
  subject: string;
  fromAddress: string;
  sentAt: Date | null;
  sizeBytes: number;
  purgeAt: Date;
}

export interface RecoveryRow {
  id: number;
  accountEmail: string;
  recoveryPath: string;
  recoveryUid: number;
  recoveryUidValidity: number;
  originPath: string;
  messageId: string | null;
  subject: string;
  fromAddress: string;
  sentAt: string | null;
  sizeBytes: number;
  deletedAt: string;
  purgeAt: string;
  state: RecoveryState;
  attempts: number;
  lastError: string | null;
}

interface RecoveryRowRaw extends QueryResultRow {
  id: string;
  account_email: string;
  recovery_path: string;
  recovery_uid: string;
  recovery_uidvalidity: string;
  origin_path: string;
  message_id: string | null;
  subject: string;
  from_address: string;
  sent_at: Date | null;
  size_bytes: string;
  deleted_at: Date;
  purge_at: Date;
  state: string;
  attempts: number;
  last_error: string | null;
}

const RECOVERY_COLUMNS = `id, account_email, recovery_path, recovery_uid, recovery_uidvalidity,
  origin_path, message_id, subject, from_address, sent_at, size_bytes,
  deleted_at, purge_at, state, attempts, last_error`;

function toRecoveryRow(raw: RecoveryRowRaw): RecoveryRow {
  return {
    id: Number(raw.id),
    accountEmail: raw.account_email,
    recoveryPath: raw.recovery_path,
    recoveryUid: Number(raw.recovery_uid),
    recoveryUidValidity: Number(raw.recovery_uidvalidity),
    originPath: raw.origin_path,
    messageId: raw.message_id,
    subject: raw.subject,
    fromAddress: raw.from_address,
    sentAt: raw.sent_at?.toISOString() ?? null,
    sizeBytes: Number(raw.size_bytes),
    deletedAt: raw.deleted_at.toISOString(),
    purgeAt: raw.purge_at.toISOString(),
    state: raw.state as RecoveryState,
    attempts: raw.attempts,
    lastError: raw.last_error,
  };
}

/* ------------------------------------------------------------------ */
/* Хранилище                                                            */
/* ------------------------------------------------------------------ */

/**
 * Договор с базой.
 *
 * Интерфейс, а не только класс: работники и маршруты общаются с базой
 * только через него, поэтому проверки подставляют сюда хранилище в памяти
 * и проверяют ПОРЯДОК действий без Postgres — так же, как это сделано у
 * отложенных писем (mail/snooze-db.ts).
 */
export interface OwnerStore {
  accessReady(): Promise<boolean>;
  exportReady(): Promise<boolean>;
  recoveryReady(): Promise<boolean>;

  addAccess(entry: AccessInsert): Promise<void>;
  listAccess(accountEmail: string, limit: number, before: string | null): Promise<AccessRow[]>;
  /** Уборка истории: старше срока — удалить. Возвращает число строк. */
  purgeAccess(olderThan: Date): Promise<number>;

  createExport(
    accountEmail: string,
    includeSpam: boolean,
    includeTrash: boolean,
  ): Promise<ExportRow>;
  listExports(accountEmail: string, limit: number): Promise<ExportRow[]>;
  findExport(id: number): Promise<ExportRow | null>;
  /** Берёт следующее задание в работу; null — очередь пуста. */
  claimExport(now: Date, staleBefore: Date): Promise<ExportRow | null>;
  updateExportProgress(id: number, patch: ExportProgressPatch): Promise<void>;
  finishExport(id: number, patch: ExportFinishPatch): Promise<void>;
  /** Готовые задания с вышедшим сроком — их файлы пора удалить. */
  listExpiredExports(now: Date, limit: number): Promise<ExportRow[]>;
  /** Сколько заданий сейчас в работе (по всем ящикам). */
  runningExports(): Promise<number>;

  /** Сколько дней ящик хранит очищенное; null — строки настроек ещё нет. */
  getRecoveryDays(accountEmail: string): Promise<number | null>;
  setRecoveryDays(accountEmail: string, days: number): Promise<void>;

  addRecovery(entry: RecoveryInsert): Promise<void>;
  /**
   * Записать сразу все перенесённые письма.
   *
   * Одним запросом, а не циклом: письма к этому моменту уже лежат в
   * служебной папке, и сбой посреди цикла оставлял часть из них без
   * записи — то есть невидимыми и вечными (см. recovery-service.ts).
   */
  addRecoveryBatch(entries: readonly RecoveryInsert[]): Promise<void>;
  listRecovery(accountEmail: string, limit: number): Promise<RecoveryRow[]>;
  /** Сводка: сколько писем и байт лежит в ожидании удаления. */
  recoveryTotals(accountEmail: string): Promise<{ count: number; bytes: number }>;
  findRecovery(accountEmail: string, ids: number[]): Promise<RecoveryRow[]>;
  listRecoveryDue(now: Date, limit: number): Promise<RecoveryRow[]>;
  closeRecovery(id: number, state: Exclude<RecoveryState, 'pending'>): Promise<void>;
  markRecoveryAttempt(id: number, error: string): Promise<void>;
}

export interface ExportProgressPatch {
  totalMessages?: number;
  doneMessages?: number;
  totalBytes?: number;
  doneBytes?: number;
  skipped?: number;
  /**
   * Куда работник пишет архив ПРЯМО СЕЙЧАС.
   *
   * Раньше путь появлялся в записи только в finishExport, то есть у
   * готового архива. У задания в состоянии 'running' он был всегда NULL,
   * и перезапуск процесса посреди выгрузки оставлял на диске недописанный
   * архив с настоящими письмами человека навсегда: новое имя содержит
   * текущее время, старый файл никто не перезаписывал, а уборщик по сроку
   * смотрит только на готовые записи. Знать о таком файле было некому.
   */
  filePath?: string;
}

export interface ExportFinishPatch {
  state: Exclude<ExportState, 'queued' | 'running'>;
  filePath?: string | null;
  fileBytes?: number;
  lastError?: string | null;
  expiresAt?: Date | null;
}

export interface OwnerDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

export class OwnerDb implements OwnerStore {
  readonly #pool: Pool;

  constructor(opts: OwnerDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (разделы владельца ящика)'),
    );
  }

  async shutdown(): Promise<void> {
    await this.#pool.end();
  }

  async #query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(text, values);
    return result.rows;
  }

  async #tableExists(name: string): Promise<boolean> {
    const rows = await this.#query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [
      `public.${name}`,
    ]);
    return rows[0]?.ok === true;
  }

  accessReady(): Promise<boolean> {
    return this.#tableExists('mailbox_access_log');
  }

  exportReady(): Promise<boolean> {
    return this.#tableExists('mailbox_export_jobs');
  }

  async recoveryReady(): Promise<boolean> {
    if (!(await this.#tableExists('trash_recovery_items'))) return false;
    // Мало таблицы: миграция 0025 добавляет ещё и колонку срока в
    // mail_user_settings, а без неё срок негде хранить и настройка молча
    // не сохранялась бы. Проверяем обе половины миграции.
    const rows = await this.#query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'mail_user_settings'
            AND column_name = 'trash_recovery_days'
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  /* --- История входов --- */

  async addAccess(entry: AccessInsert): Promise<void> {
    await this.#query(
      `INSERT INTO mailbox_access_log
         (account_email, kind, channel, success, ip, user_agent, detail)
       VALUES (lower($1), $2, $3, $4, $5, $6, $7)`,
      [
        entry.accountEmail,
        entry.kind,
        entry.channel,
        entry.success,
        entry.ip,
        entry.userAgent,
        entry.detail,
      ],
    );
  }

  async listAccess(
    accountEmail: string,
    limit: number,
    before: string | null,
  ): Promise<AccessRow[]> {
    const rows = await this.#query<AccessRowRaw>(
      `SELECT id, at, kind, channel, success, ip, user_agent, detail
         FROM mailbox_access_log
        WHERE lower(account_email) = lower($1)
          AND ($2::timestamptz IS NULL OR at < $2::timestamptz)
        ORDER BY at DESC, id DESC
        LIMIT $3`,
      [accountEmail, before, limit],
    );
    return rows.map((raw) => ({
      id: Number(raw.id),
      at: raw.at.toISOString(),
      kind: raw.kind as AccessKind,
      channel: raw.channel as AccessChannel,
      success: raw.success,
      ip: raw.ip,
      userAgent: raw.user_agent,
      detail: raw.detail ?? '',
    }));
  }

  async purgeAccess(olderThan: Date): Promise<number> {
    const result = await this.#pool.query(`DELETE FROM mailbox_access_log WHERE at < $1`, [
      olderThan.toISOString(),
    ]);
    return result.rowCount ?? 0;
  }

  /* --- Собственные адреса сервера приложения (миграция 0036) --- */

  serviceAddressesReady(): Promise<boolean> {
    return this.#tableExists('api_service_addresses');
  }

  /**
   * Отметить адреса своими. Уже известный адрес не заводится заново — у
   * него обновляется «когда видели в последний раз», по которому строка
   * потом и стареет.
   */
  async rememberServiceAddresses(ips: readonly string[]): Promise<void> {
    if (ips.length === 0) return;
    await this.#query(
      `INSERT INTO api_service_addresses (ip)
       SELECT DISTINCT unnest($1::text[])
       ON CONFLICT (ip) DO UPDATE SET last_seen = now()`,
      [[...ips]],
    );
  }

  async listServiceAddresses(): Promise<string[]> {
    const rows = await this.#query<{ ip: string }>(`SELECT ip FROM api_service_addresses`);
    return rows.map((row) => row.ip);
  }

  async purgeServiceAddresses(olderThan: Date): Promise<number> {
    const result = await this.#pool.query(
      `DELETE FROM api_service_addresses WHERE last_seen < $1`,
      [olderThan.toISOString()],
    );
    return result.rowCount ?? 0;
  }

  /* --- Выгрузка --- */

  async createExport(
    accountEmail: string,
    includeSpam: boolean,
    includeTrash: boolean,
  ): Promise<ExportRow> {
    const rows = await this.#query<ExportRowRaw>(
      `INSERT INTO mailbox_export_jobs (account_email, include_spam, include_trash)
       VALUES (lower($1), $2, $3)
       RETURNING ${EXPORT_COLUMNS}`,
      [accountEmail, includeSpam, includeTrash],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось создать задание выгрузки');
    return toExportRow(row);
  }

  async listExports(accountEmail: string, limit: number): Promise<ExportRow[]> {
    const rows = await this.#query<ExportRowRaw>(
      `SELECT ${EXPORT_COLUMNS} FROM mailbox_export_jobs
        WHERE lower(account_email) = lower($1)
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [accountEmail, limit],
    );
    return rows.map(toExportRow);
  }

  async findExport(id: number): Promise<ExportRow | null> {
    const rows = await this.#query<ExportRowRaw>(
      `SELECT ${EXPORT_COLUMNS} FROM mailbox_export_jobs WHERE id = $1`,
      [id],
    );
    return rows[0] ? toExportRow(rows[0]) : null;
  }

  /**
   * Берёт следующее задание в работу.
   *
   * Одним запросом с `FOR UPDATE SKIP LOCKED`, а не «выбрать, потом
   * обновить»: сервер приложения может быть запущен в двух экземплярах
   * (за одним обратным прокси), и два работника, выбравшие одно задание,
   * писали бы в один файл. Пропуск заблокированных строк здесь и означает
   * «это задание уже кто-то взял».
   *
   * Второй частью условия подбираются брошенные задания: 'running' без
   * отметки живости дольше срока — это перезапуск контейнера посреди
   * работы, и без этого такое задание висело бы вечно.
   */
  async claimExport(now: Date, staleBefore: Date): Promise<ExportRow | null> {
    const rows = await this.#query<ExportRowRaw>(
      `UPDATE mailbox_export_jobs SET
         state = 'running',
         started_at = COALESCE(started_at, $1::timestamptz),
         heartbeat_at = $1::timestamptz
       WHERE id = (
         SELECT id FROM mailbox_export_jobs
          WHERE state = 'queued'
             OR (state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < $2::timestamptz))
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING ${EXPORT_COLUMNS}`,
      [now.toISOString(), staleBefore.toISOString()],
    );
    return rows[0] ? toExportRow(rows[0]) : null;
  }

  async updateExportProgress(id: number, patch: ExportProgressPatch): Promise<void> {
    await this.#query(
      `UPDATE mailbox_export_jobs SET
         total_messages = COALESCE($2, total_messages),
         done_messages  = COALESCE($3, done_messages),
         total_bytes    = COALESCE($4, total_bytes),
         done_bytes     = COALESCE($5, done_bytes),
         skipped        = COALESCE($6, skipped),
         -- Путь только записывается, но не стирается: стереть его может
         -- лишь finishExport, и только вместе с судьбой самого файла.
         file_path      = COALESCE($7, file_path),
         heartbeat_at   = now()
       WHERE id = $1`,
      [
        id,
        patch.totalMessages ?? null,
        patch.doneMessages ?? null,
        patch.totalBytes ?? null,
        patch.doneBytes ?? null,
        patch.skipped ?? null,
        patch.filePath ?? null,
      ],
    );
  }

  async finishExport(id: number, patch: ExportFinishPatch): Promise<void> {
    await this.#query(
      `UPDATE mailbox_export_jobs SET
         state = $2,
         file_path = $3,
         file_bytes = COALESCE($4, file_bytes),
         last_error = $5,
         expires_at = $6,
         finished_at = now(),
         heartbeat_at = NULL
       WHERE id = $1`,
      [
        id,
        patch.state,
        patch.filePath ?? null,
        patch.fileBytes ?? null,
        patch.lastError ?? null,
        patch.expiresAt?.toISOString() ?? null,
      ],
    );
  }

  async listExpiredExports(now: Date, limit: number): Promise<ExportRow[]> {
    const rows = await this.#query<ExportRowRaw>(
      `SELECT ${EXPORT_COLUMNS} FROM mailbox_export_jobs
        WHERE state = 'ready' AND expires_at IS NOT NULL AND expires_at < $1::timestamptz
        ORDER BY expires_at
        LIMIT $2`,
      [now.toISOString(), limit],
    );
    return rows.map(toExportRow);
  }

  async runningExports(): Promise<number> {
    const rows = await this.#query<{ n: string }>(
      `SELECT count(*)::text AS n FROM mailbox_export_jobs WHERE state = 'running'`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /* --- Восстановление --- */

  async getRecoveryDays(accountEmail: string): Promise<number | null> {
    const rows = await this.#query<{ days: number | null }>(
      `SELECT trash_recovery_days AS days FROM mail_user_settings
        WHERE lower(account_email) = lower($1)`,
      [accountEmail],
    );
    // Строки нет — человек ни разу не открывал настройки. Это НЕ «ноль
    // дней»: умолчание задаёт миграция (семь), и вызывающий подставляет
    // его сам, чтобы поведение до и после первого сохранения совпадало.
    return rows.length === 0 ? null : (rows[0]?.days ?? null);
  }

  async setRecoveryDays(accountEmail: string, days: number): Promise<void> {
    await this.#query(
      `INSERT INTO mail_user_settings (account_email, trash_recovery_days)
       VALUES (lower($1), $2)
       ON CONFLICT (account_email)
         DO UPDATE SET trash_recovery_days = EXCLUDED.trash_recovery_days, updated_at = now()`,
      [accountEmail, days],
    );
  }

  async addRecovery(entry: RecoveryInsert): Promise<void> {
    await this.#query(
      `INSERT INTO trash_recovery_items
         (account_email, recovery_path, recovery_uid, recovery_uidvalidity, origin_path,
          message_id, subject, from_address, sent_at, size_bytes, purge_at)
       VALUES (lower($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT DO NOTHING`,
      [
        entry.accountEmail,
        entry.recoveryPath,
        entry.recoveryUid,
        entry.recoveryUidValidity,
        entry.originPath,
        entry.messageId,
        entry.subject,
        entry.fromAddress,
        entry.sentAt?.toISOString() ?? null,
        entry.sizeBytes,
        entry.purgeAt.toISOString(),
      ],
    );
  }

  async addRecoveryBatch(entries: readonly RecoveryInsert[]): Promise<void> {
    if (entries.length === 0) return;
    const values: unknown[] = [];
    const rows: string[] = [];
    for (const entry of entries) {
      const base = values.length;
      rows.push(
        `(lower($${base + 1}), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
          `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`,
      );
      values.push(
        entry.accountEmail,
        entry.recoveryPath,
        entry.recoveryUid,
        entry.recoveryUidValidity,
        entry.originPath,
        entry.messageId,
        entry.subject,
        entry.fromAddress,
        entry.sentAt?.toISOString() ?? null,
        entry.sizeBytes,
        entry.purgeAt.toISOString(),
      );
    }
    await this.#query(
      `INSERT INTO trash_recovery_items
         (account_email, recovery_path, recovery_uid, recovery_uidvalidity, origin_path,
          message_id, subject, from_address, sent_at, size_bytes, purge_at)
       VALUES ${rows.join(', ')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  async listRecovery(accountEmail: string, limit: number): Promise<RecoveryRow[]> {
    const rows = await this.#query<RecoveryRowRaw>(
      `SELECT ${RECOVERY_COLUMNS} FROM trash_recovery_items
        WHERE lower(account_email) = lower($1) AND state = 'pending'
        ORDER BY deleted_at DESC, id DESC
        LIMIT $2`,
      [accountEmail, limit],
    );
    return rows.map(toRecoveryRow);
  }

  async recoveryTotals(accountEmail: string): Promise<{ count: number; bytes: number }> {
    const rows = await this.#query<{ n: string; b: string | null }>(
      `SELECT count(*)::text AS n, COALESCE(sum(size_bytes), 0)::text AS b
         FROM trash_recovery_items
        WHERE lower(account_email) = lower($1) AND state = 'pending'`,
      [accountEmail],
    );
    return { count: Number(rows[0]?.n ?? 0), bytes: Number(rows[0]?.b ?? 0) };
  }

  async findRecovery(accountEmail: string, ids: number[]): Promise<RecoveryRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.#query<RecoveryRowRaw>(
      `SELECT ${RECOVERY_COLUMNS} FROM trash_recovery_items
        WHERE lower(account_email) = lower($1) AND state = 'pending' AND id = ANY($2::bigint[])`,
      [accountEmail, ids],
    );
    return rows.map(toRecoveryRow);
  }

  async listRecoveryDue(now: Date, limit: number): Promise<RecoveryRow[]> {
    const rows = await this.#query<RecoveryRowRaw>(
      `SELECT ${RECOVERY_COLUMNS} FROM trash_recovery_items
        WHERE state = 'pending' AND purge_at < $1::timestamptz
        ORDER BY purge_at
        LIMIT $2`,
      [now.toISOString(), limit],
    );
    return rows.map(toRecoveryRow);
  }

  async closeRecovery(id: number, state: Exclude<RecoveryState, 'pending'>): Promise<void> {
    await this.#query(
      `UPDATE trash_recovery_items
          SET state = $2, closed_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'pending'`,
      [id, state],
    );
  }

  async markRecoveryAttempt(id: number, error: string): Promise<void> {
    await this.#query(
      `UPDATE trash_recovery_items
          SET attempts = attempts + 1, last_error = $2, updated_at = now()
        WHERE id = $1`,
      [id, error.slice(0, 500)],
    );
  }
}
