/**
 * Доступ к базе почтового стека из админки.
 *
 * Работаем с теми же таблицами, что читают Postfix и Dovecot
 * (virtual_domains / virtual_users / virtual_aliases), плюс свои
 * админские таблицы из миграции 0003. Существующие столбцы не трогаем:
 * любое изменение схемы Postfix и Dovecot увидят немедленно.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { AuditRecord } from './audit.js';

export interface AdminDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

/* ------------------------------------------------------------------ */
/* Строки таблиц                                                        */
/* ------------------------------------------------------------------ */

export interface AdminUserRow {
  id: number;
  login: string;
  password_hash: string;
  display_name: string | null;
  role: string;
  totp_enabled: boolean;
  active: boolean;
  last_login_at: Date | null;
  last_login_ip: string | null;
  failed_attempts: number;
  locked_until: Date | null;
  created_at: Date;
}

export interface MailUserRow {
  id: number;
  domain_id: number;
  email: string;
  display_name: string | null;
  quota_bytes: string | number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  domain: string;
  alias_count: string | number;
}

export interface DomainRow {
  id: number;
  name: string;
  created_at: Date;
  user_count: string | number;
  alias_count: string | number;
  dkim_selector: string | null;
  dkim_public_key: string | null;
  dkim_dns_record: string | null;
  dns_status: unknown;
  dns_checked_at: Date | null;
  dns_overall: string | null;
}

export interface AliasRow {
  id: number;
  domain_id: number;
  source: string;
  destination: string;
  active: boolean;
  created_at: Date;
  domain: string;
}

export interface AuditRow {
  id: string;
  admin_login: string;
  action: string;
  target_type: string;
  target_id: number | null;
  target_label: string | null;
  ip: string | null;
  old_value: unknown;
  new_value: unknown;
  created_at: Date;
}

export interface MailboxAccessRow {
  id: string;
  admin_login: string;
  mailbox_email: string;
  reason: string;
  ip: string | null;
  started_at: Date;
  ended_at: Date | null;
  /** leave | logout | replaced | expired; NULL — сеанс ещё идёт. */
  end_reason: string | null;
}

/** Строка задания импорта. result_enc — шифротекст, наружу не отдаётся. */
export interface ImportJobRow {
  id: string;
  admin_login: string;
  state: string;
  total: number;
  processed: number;
  created_count: number;
  failed_count: number;
  result_enc: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  expires_at: Date;
}

/** Уникальное нарушение Postgres (23505) — адрес/домен уже занят. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

/** Отсутствующая таблица (42P01) — миграция 0003 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

export class AdminDb {
  private readonly pool: Pool;

  constructor(private readonly opts: AdminDbOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // В журнал — только суть ошибки: объект pg тянет за собой состояние
    // соединения, и одна запись весит килобайты (см. src/log.ts)
    this.pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (админка)'),
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(text, values);
    return result.rows;
  }

  async one<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, values);
    return rows[0] ?? null;
  }

  /** Транзакция: коммит при успехе, откат при исключении. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Отвечает ли база. Для пробы состояния: соединение берётся из уже
   * существующего пула, запрос — самый дешёвый из возможных.
   */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /** Проверка, что миграция 0003 применена. */
  async adminSchemaReady(): Promise<boolean> {
    const row = await this.one<{ ok: boolean }>(
      `SELECT to_regclass('public.admin_users') IS NOT NULL AS ok`,
    );
    return row?.ok === true;
  }

  /* ---------------------------------------------------------------- */
  /* Администраторы                                                     */
  /* ---------------------------------------------------------------- */

  async findAdminByLogin(login: string): Promise<AdminUserRow | null> {
    return this.one<AdminUserRow>(
      `SELECT id, login, password_hash, display_name, role, totp_enabled, active,
              last_login_at, last_login_ip, failed_attempts, locked_until, created_at
         FROM admin_users WHERE login = $1`,
      [login],
    );
  }

  async findAdminById(id: number): Promise<AdminUserRow | null> {
    return this.one<AdminUserRow>(
      `SELECT id, login, password_hash, display_name, role, totp_enabled, active,
              last_login_at, last_login_ip, failed_attempts, locked_until, created_at
         FROM admin_users WHERE id = $1`,
      [id],
    );
  }

  async listAdmins(): Promise<AdminUserRow[]> {
    return this.query<AdminUserRow>(
      `SELECT id, login, password_hash, display_name, role, totp_enabled, active,
              last_login_at, last_login_ip, failed_attempts, locked_until, created_at
         FROM admin_users ORDER BY login`,
    );
  }

  async createAdmin(
    login: string,
    passwordHash: string,
    role: string,
    displayName: string | null,
  ): Promise<AdminUserRow> {
    const row = await this.one<AdminUserRow>(
      `INSERT INTO admin_users (login, password_hash, role, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, login, password_hash, display_name, role, totp_enabled, active,
                 last_login_at, last_login_ip, failed_attempts, locked_until, created_at`,
      [login, passwordHash, role, displayName],
    );
    if (!row) throw new Error('Не удалось создать администратора');
    return row;
  }

  async markAdminLoginSuccess(id: number, ip: string | null): Promise<void> {
    await this.query(
      `UPDATE admin_users
          SET last_login_at = now(), last_login_ip = $2,
              failed_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [id, ip],
    );
  }

  /** Увеличивает счётчик неудач и при переполнении ставит блокировку. */
  async markAdminLoginFailure(
    id: number,
    maxFailures: number,
    lockMinutes: number,
  ): Promise<{ failed_attempts: number; locked_until: Date | null } | null> {
    return this.one<{ failed_attempts: number; locked_until: Date | null }>(
      `UPDATE admin_users
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= $2
                                  THEN now() + ($3 || ' minutes')::interval
                                  ELSE locked_until END,
              updated_at = now()
        WHERE id = $1
        RETURNING failed_attempts, locked_until`,
      [id, maxFailures, String(lockMinutes)],
    );
  }

  /* ---------------------------------------------------------------- */
  /* Почтовые пользователи                                              */
  /* ---------------------------------------------------------------- */

  async listMailUsers(filters: {
    search?: string | undefined;
    domainId?: number | undefined;
    active?: boolean | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: MailUserRow[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.search) {
      values.push(`%${filters.search.toLowerCase()}%`);
      where.push(`(lower(u.email) LIKE $${values.length} OR lower(coalesce(u.display_name,'')) LIKE $${values.length})`);
    }
    if (filters.domainId !== undefined) {
      values.push(filters.domainId);
      where.push(`u.domain_id = $${values.length}`);
    }
    if (filters.active !== undefined) {
      values.push(filters.active);
      where.push(`u.active = $${values.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await this.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM virtual_users u ${whereSql}`,
      values,
    );
    values.push(filters.limit, filters.offset);
    const rows = await this.query<MailUserRow>(
      `SELECT u.id, u.domain_id, u.email, u.display_name, u.quota_bytes, u.active,
              u.created_at, u.updated_at, d.name AS domain,
              (SELECT count(*) FROM virtual_aliases a WHERE a.source = u.email)::text AS alias_count
         FROM virtual_users u
         JOIN virtual_domains d ON d.id = u.domain_id
         ${whereSql}
         ORDER BY u.email
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows, total: Number(totalRow?.count ?? 0) };
  }

  async findMailUserById(id: number): Promise<MailUserRow | null> {
    return this.one<MailUserRow>(
      `SELECT u.id, u.domain_id, u.email, u.display_name, u.quota_bytes, u.active,
              u.created_at, u.updated_at, d.name AS domain,
              (SELECT count(*) FROM virtual_aliases a WHERE a.source = u.email)::text AS alias_count
         FROM virtual_users u JOIN virtual_domains d ON d.id = u.domain_id
        WHERE u.id = $1`,
      [id],
    );
  }

  async findMailUserByEmail(email: string): Promise<MailUserRow | null> {
    return this.one<MailUserRow>(
      `SELECT u.id, u.domain_id, u.email, u.display_name, u.quota_bytes, u.active,
              u.created_at, u.updated_at, d.name AS domain,
              (SELECT count(*) FROM virtual_aliases a WHERE a.source = u.email)::text AS alias_count
         FROM virtual_users u JOIN virtual_domains d ON d.id = u.domain_id
        WHERE lower(u.email) = lower($1)`,
      [email],
    );
  }

  /** Находит домен по имени; при allowCreate создаёт отсутствующий. */
  async resolveDomain(name: string, allowCreate: boolean): Promise<{ id: number; name: string } | null> {
    const existing = await this.one<{ id: number; name: string }>(
      `SELECT id, name FROM virtual_domains WHERE lower(name) = lower($1)`,
      [name],
    );
    if (existing) return existing;
    if (!allowCreate) return null;
    const created = await this.one<{ id: number; name: string }>(
      `INSERT INTO virtual_domains (name) VALUES (lower($1))
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [name],
    );
    if (created) {
      await this.query(
        `INSERT INTO domain_settings (domain_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [created.id],
      );
      // Раздел «Помощник ИИ» у нового домена должен быть таким же, как
      // у старого: выключенным, но настраиваемым. Раньше строку настроек
      // заводила только миграция 0004, и у доменов, добавленных после неё,
      // помощник настроить было нельзя вовсе. Чтение теперь и без строки
      // обходится (см. apps/api/src/ai/db.ts), но пусть в базе будет ровно.
      try {
        await this.query(
          `INSERT INTO ai_domain_settings (domain_id) VALUES ($1) ON CONFLICT DO NOTHING`,
          [created.id],
        );
      } catch (err) {
        // Миграция 0004 не применена — это не повод не заводить домен.
        if (!isUndefinedTable(err)) throw err;
      }
    }
    return created;
  }

  async createMailUser(input: {
    domainId: number;
    email: string;
    passwordHash: string;
    displayName: string | null;
    quotaBytes: number;
    active: boolean;
  }): Promise<MailUserRow> {
    const row = await this.one<{ id: number }>(
      `INSERT INTO virtual_users (domain_id, email, password, display_name, quota_bytes, active)
       VALUES ($1, lower($2), $3, $4, $5, $6) RETURNING id`,
      [
        input.domainId,
        input.email,
        input.passwordHash,
        input.displayName,
        input.quotaBytes,
        input.active,
      ],
    );
    if (!row) throw new Error('Не удалось создать ящик');
    const created = await this.findMailUserById(row.id);
    if (!created) throw new Error('Ящик создан, но не читается');
    return created;
  }

  async updateMailUser(
    id: number,
    patch: { displayName?: string | null; quotaBytes?: number; active?: boolean },
  ): Promise<MailUserRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName !== undefined) {
      values.push(patch.displayName);
      sets.push(`display_name = $${values.length}`);
    }
    if (patch.quotaBytes !== undefined) {
      values.push(patch.quotaBytes);
      sets.push(`quota_bytes = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) return this.findMailUserById(id);
    values.push(id);
    await this.query(
      `UPDATE virtual_users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
      values,
    );
    return this.findMailUserById(id);
  }

  async setMailUserPassword(id: number, passwordHash: string): Promise<void> {
    await this.query(
      `UPDATE virtual_users SET password = $2, updated_at = now() WHERE id = $1`,
      [id, passwordHash],
    );
  }

  async deleteMailUser(id: number): Promise<void> {
    await this.query(`DELETE FROM virtual_users WHERE id = $1`, [id]);
  }

  /**
   * Убирает всё, что принадлежит ящику, но живёт вне virtual_users.
   *
   * Связь этих таблиц с ящиком — по адресу, а не по внешнему ключу
   * (так сделано осознанно: настройки переживают пересоздание строки
   * пользователя, см. миграцию 0005). Плата за это — уборка вручную,
   * и до сих пор её просто не делали: после удаления ящика оставались
   * настройки, подписи, правила фильтрации, подключённые чужие ящики
   * с зашифрованными паролями и сотни строк состояния переноса.
   *
   * Возвращает число удалённых строк — оно попадает в mailbox_deletions
   * и в журнал аудита, чтобы уборка была видна, а не подразумевалась.
   * Отсутствие таблицы (миграция не применена) пропускается: удаление
   * ящика не должно падать из-за необязательного раздела.
   */
  async purgeMailboxData(email: string): Promise<number> {
    const statements: Array<{ sql: string; values: unknown[] }> = [
      { sql: `DELETE FROM ai_user_settings WHERE lower(account_email) = lower($1)`, values: [email] },
      { sql: `DELETE FROM mail_user_settings WHERE lower(account_email) = lower($1)`, values: [email] },
      { sql: `DELETE FROM mail_signatures WHERE lower(account_email) = lower($1)`, values: [email] },
      { sql: `DELETE FROM mail_filters WHERE lower(account_email) = lower($1)`, values: [email] },
      // Связанные ящики — с обеих сторон: и наши ссылки, и ссылки на нас.
      {
        sql: `DELETE FROM linked_accounts
               WHERE lower(owner_email) = lower($1) OR lower(linked_email) = lower($1)`,
        values: [email],
      },
      { sql: `DELETE FROM external_accounts WHERE lower(owner_email) = lower($1)`, values: [email] },
      // Состояние переноса и сборщика: ключи дедупликации и точки докачки.
      { sql: `DELETE FROM migrate_messages WHERE lower(account) = lower($1)`, values: [email] },
      { sql: `DELETE FROM migrate_cursors WHERE lower(account) = lower($1)`, values: [email] },
    ];
    let removed = 0;
    for (const statement of statements) {
      try {
        const result = await this.pool.query(statement.sql, statement.values);
        removed += result.rowCount ?? 0;
      } catch (err) {
        if (!isUndefinedTable(err)) throw err;
      }
    }
    return removed;
  }

  /* ---------------------------------------------------------------- */
  /* Уборка после удаления ящика (миграция 0006)                        */
  /* ---------------------------------------------------------------- */

  async recordMailboxDeletion(input: {
    email: string;
    domain: string;
    adminLogin: string;
    reason: string | null;
    purgeDelayMinutes: number;
  }): Promise<number> {
    const row = await this.one<{ id: string }>(
      `INSERT INTO mailbox_deletions (email, domain, admin_login, reason, purge_after)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)
       RETURNING id::text`,
      [input.email, input.domain, input.adminLogin, input.reason, String(input.purgeDelayMinutes)],
    );
    return Number(row?.id ?? 0);
  }

  async updateMailboxDeletion(
    id: number,
    patch: {
      quarantinePath?: string | null;
      maildirPath?: string | null;
      state?: 'pending' | 'purged' | 'failed';
      imapPurged?: boolean;
      dbRowsRemoved?: number;
      bytesFreed?: number;
      error?: string | null;
      purged?: boolean;
      bumpAttempts?: boolean;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}`);
    };
    if (patch.quarantinePath !== undefined) put('quarantine_path', patch.quarantinePath);
    if (patch.maildirPath !== undefined) put('maildir_path', patch.maildirPath);
    if (patch.state !== undefined) put('state', patch.state);
    if (patch.imapPurged !== undefined) put('imap_purged', patch.imapPurged);
    if (patch.dbRowsRemoved !== undefined) put('db_rows_removed', patch.dbRowsRemoved);
    if (patch.bytesFreed !== undefined) put('bytes_freed', patch.bytesFreed);
    if (patch.error !== undefined) put('error', patch.error);
    if (patch.purged === true) sets.push('purged_at = now()');
    if (patch.bumpAttempts === true) sets.push('attempts = attempts + 1');
    if (sets.length === 0) return;
    values.push(id);
    await this.query(
      `UPDATE mailbox_deletions SET ${sets.join(', ')} WHERE id = $${String(values.length)}`,
      values,
    );
  }

  /** Что пора убрать с диска: карантин отлежал положенное. */
  async listDeletionsToPurge(limit: number): Promise<
    Array<{ id: number; email: string; quarantinePath: string | null }>
  > {
    const rows = await this.query<{ id: string; email: string; quarantine_path: string | null }>(
      `SELECT id::text, email, quarantine_path
         FROM mailbox_deletions
        WHERE state = 'pending' AND purge_after <= now() AND attempts < 10
        ORDER BY purge_after
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      quarantinePath: r.quarantine_path,
    }));
  }

  async listMailboxDeletions(limit: number): Promise<
    Array<{
      id: number;
      email: string;
      domain: string;
      adminLogin: string | null;
      state: string;
      imapPurged: boolean;
      dbRowsRemoved: number;
      bytesFreed: number;
      requestedAt: string;
      purgeAfter: string;
      purgedAt: string | null;
      error: string | null;
    }>
  > {
    const rows = await this.query<{
      id: string;
      email: string;
      domain: string;
      admin_login: string | null;
      state: string;
      imap_purged: boolean;
      db_rows_removed: number;
      bytes_freed: string;
      requested_at: Date;
      purge_after: Date;
      purged_at: Date | null;
      error: string | null;
    }>(
      `SELECT id::text, email, domain, admin_login, state, imap_purged,
              db_rows_removed, bytes_freed::text, requested_at, purge_after, purged_at, error
         FROM mailbox_deletions
        ORDER BY requested_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      domain: r.domain,
      adminLogin: r.admin_login,
      state: r.state,
      imapPurged: r.imap_purged,
      dbRowsRemoved: r.db_rows_removed,
      bytesFreed: Number(r.bytes_freed),
      requestedAt: r.requested_at.toISOString(),
      purgeAfter: r.purge_after.toISOString(),
      purgedAt: r.purged_at?.toISOString() ?? null,
      error: r.error,
    }));
  }

  /** Все адреса ящиков — уборщику, чтобы отличить осиротевший каталог. */
  async listAllMailboxEmails(): Promise<string[]> {
    const rows = await this.query<{ email: string }>(`SELECT email FROM virtual_users`);
    return rows.map((r) => r.email);
  }

  async listEmailsIn(emails: readonly string[]): Promise<string[]> {
    if (emails.length === 0) return [];
    const rows = await this.query<{ email: string }>(
      `SELECT email FROM virtual_users WHERE lower(email) = ANY($1::text[])`,
      [emails.map((e) => e.toLowerCase())],
    );
    return rows.map((r) => r.email);
  }

  /* ---------------------------------------------------------------- */
  /* Домены и алиасы                                                    */
  /* ---------------------------------------------------------------- */

  async listDomains(): Promise<DomainRow[]> {
    return this.query<DomainRow>(
      `SELECT d.id, d.name, d.created_at,
              (SELECT count(*) FROM virtual_users u WHERE u.domain_id = d.id)::text AS user_count,
              (SELECT count(*) FROM virtual_aliases a WHERE a.domain_id = d.id)::text AS alias_count,
              s.dkim_selector, s.dkim_public_key, s.dkim_dns_record,
              s.dns_status, s.dns_checked_at, s.dns_overall
         FROM virtual_domains d
         LEFT JOIN domain_settings s ON s.domain_id = d.id
        ORDER BY d.name`,
    );
  }

  async findDomainById(id: number): Promise<DomainRow | null> {
    const rows = await this.query<DomainRow>(
      `SELECT d.id, d.name, d.created_at,
              (SELECT count(*) FROM virtual_users u WHERE u.domain_id = d.id)::text AS user_count,
              (SELECT count(*) FROM virtual_aliases a WHERE a.domain_id = d.id)::text AS alias_count,
              s.dkim_selector, s.dkim_public_key, s.dkim_dns_record,
              s.dns_status, s.dns_checked_at, s.dns_overall
         FROM virtual_domains d
         LEFT JOIN domain_settings s ON s.domain_id = d.id
        WHERE d.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async deleteDomain(id: number): Promise<void> {
    await this.query(`DELETE FROM virtual_domains WHERE id = $1`, [id]);
  }

  async saveDnsStatus(
    domainId: number,
    status: unknown,
    overall: string,
  ): Promise<void> {
    await this.query(
      `INSERT INTO domain_settings (domain_id, dns_status, dns_checked_at, dns_overall)
       VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (domain_id) DO UPDATE
          SET dns_status = EXCLUDED.dns_status,
              dns_checked_at = now(),
              dns_overall = EXCLUDED.dns_overall,
              updated_at = now()`,
      [domainId, JSON.stringify(status), overall],
    );
  }

  async saveDomainSettings(
    domainId: number,
    patch: { dkimSelector?: string; dkimPublicKey?: string | null; dkimDnsRecord?: string | null; notes?: string | null },
  ): Promise<void> {
    await this.query(
      `INSERT INTO domain_settings (domain_id, dkim_selector, dkim_public_key, dkim_dns_record, notes)
       VALUES ($1, coalesce($2, 'mail'), $3, $4, $5)
       ON CONFLICT (domain_id) DO UPDATE
          SET dkim_selector   = coalesce($2, domain_settings.dkim_selector),
              dkim_public_key = coalesce($3, domain_settings.dkim_public_key),
              dkim_dns_record = coalesce($4, domain_settings.dkim_dns_record),
              notes           = coalesce($5, domain_settings.notes),
              updated_at = now()`,
      [
        domainId,
        patch.dkimSelector ?? null,
        patch.dkimPublicKey ?? null,
        patch.dkimDnsRecord ?? null,
        patch.notes ?? null,
      ],
    );
  }

  async listAliases(filters: {
    search?: string | undefined;
    domainId?: number | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: AliasRow[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.search) {
      values.push(`%${filters.search.toLowerCase()}%`);
      where.push(`(lower(a.source) LIKE $${values.length} OR lower(a.destination) LIKE $${values.length})`);
    }
    if (filters.domainId !== undefined) {
      values.push(filters.domainId);
      where.push(`a.domain_id = $${values.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = await this.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM virtual_aliases a ${whereSql}`,
      values,
    );
    values.push(filters.limit, filters.offset);
    const rows = await this.query<AliasRow>(
      `SELECT a.id, a.domain_id, a.source, a.destination, a.active, a.created_at, d.name AS domain
         FROM virtual_aliases a JOIN virtual_domains d ON d.id = a.domain_id
         ${whereSql}
         ORDER BY a.source, a.destination
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows, total: Number(totalRow?.count ?? 0) };
  }

  async findAliasById(id: number): Promise<AliasRow | null> {
    return this.one<AliasRow>(
      `SELECT a.id, a.domain_id, a.source, a.destination, a.active, a.created_at, d.name AS domain
         FROM virtual_aliases a JOIN virtual_domains d ON d.id = a.domain_id
        WHERE a.id = $1`,
      [id],
    );
  }

  async createAlias(domainId: number, source: string, destination: string): Promise<AliasRow> {
    const row = await this.one<{ id: number }>(
      `INSERT INTO virtual_aliases (domain_id, source, destination)
       VALUES ($1, lower($2), lower($3)) RETURNING id`,
      [domainId, source, destination],
    );
    if (!row) throw new Error('Не удалось создать алиас');
    const created = await this.findAliasById(row.id);
    if (!created) throw new Error('Алиас создан, но не читается');
    return created;
  }

  async setAliasActive(id: number, active: boolean): Promise<AliasRow | null> {
    await this.query(`UPDATE virtual_aliases SET active = $2 WHERE id = $1`, [id, active]);
    return this.findAliasById(id);
  }

  async deleteAlias(id: number): Promise<void> {
    await this.query(`DELETE FROM virtual_aliases WHERE id = $1`, [id]);
  }

  /* ---------------------------------------------------------------- */
  /* Журналы                                                            */
  /* ---------------------------------------------------------------- */

  /** Пишет запись аудита. Ошибка записи не должна валить основное действие. */
  async writeAudit(record: AuditRecord): Promise<void> {
    try {
      await this.query(
        `INSERT INTO admin_audit_log
           (admin_id, admin_login, action, target_type, target_id, target_label,
            ip, user_agent, old_value, new_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
        [
          record.adminId > 0 ? record.adminId : null,
          record.adminLogin,
          record.action,
          record.targetType,
          record.targetId,
          record.targetLabel,
          record.ip,
          record.userAgent,
          record.oldValue === null ? null : JSON.stringify(record.oldValue),
          record.newValue === null ? null : JSON.stringify(record.newValue),
        ],
      );
    } catch (err) {
      this.opts.logger.error(errorInfo(err, { action: record.action }), 'Не удалось записать аудит');
    }
  }

  async listAudit(filters: {
    action?: string | undefined;
    adminLogin?: string | undefined;
    targetType?: string | undefined;
    search?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: AuditRow[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.action) {
      values.push(filters.action);
      where.push(`action = $${values.length}`);
    }
    if (filters.adminLogin) {
      values.push(filters.adminLogin);
      where.push(`admin_login = $${values.length}`);
    }
    if (filters.targetType) {
      values.push(filters.targetType);
      where.push(`target_type = $${values.length}`);
    }
    if (filters.search) {
      values.push(`%${filters.search.toLowerCase()}%`);
      where.push(`lower(coalesce(target_label,'')) LIKE $${values.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = await this.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_audit_log ${whereSql}`,
      values,
    );
    values.push(filters.limit, filters.offset);
    const rows = await this.query<AuditRow>(
      `SELECT id::text, admin_login, action, target_type, target_id, target_label,
              ip, old_value, new_value, created_at
         FROM admin_audit_log ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows, total: Number(totalRow?.count ?? 0) };
  }

  /**
   * Открывает запись о входе в чужой ящик. Срок жизни сеанса пишется
   * сразу: по нему уборщик закрывает записи, брошенные без явного выхода
   * (закрытая вкладка, истёкший сеанс). Без этого столбца запись
   * оставалась открытой навсегда, и вход выглядел бесконечным.
   */
  async recordMailboxAccess(input: {
    adminId: number;
    adminLogin: string;
    mailboxEmail: string;
    reason: string;
    ip: string | null;
    userAgent: string | null;
    ttlSeconds: number;
  }): Promise<number> {
    const row = await this.one<{ id: string }>(
      `INSERT INTO admin_mailbox_access
         (admin_id, admin_login, mailbox_email, reason, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval) RETURNING id::text`,
      [
        input.adminId,
        input.adminLogin,
        input.mailboxEmail,
        input.reason,
        input.ip,
        input.userAgent,
        String(input.ttlSeconds),
      ],
    );
    return Number(row?.id ?? 0);
  }

  /** Закрывает запись. reason — чем именно закончился сеанс. */
  async endMailboxAccess(
    id: number,
    reason: 'leave' | 'logout' | 'replaced' | 'expired' = 'leave',
  ): Promise<void> {
    await this.query(
      `UPDATE admin_mailbox_access
          SET ended_at = now(), end_reason = $2
        WHERE id = $1 AND ended_at IS NULL`,
      [id, reason],
    );
  }

  /**
   * Закрывает все открытые записи администратора, кроме указанной.
   * Вход в другой ящик поверх текущего раньше оставлял предыдущую запись
   * открытой — получалось, что администратор одновременно «сидит»
   * в двух чужих ящиках, хотя сеанс всего один.
   */
  async closeOpenMailboxAccess(
    adminId: number,
    reason: 'logout' | 'replaced',
    exceptId?: number,
  ): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE admin_mailbox_access
          SET ended_at = now(), end_reason = $2
        WHERE admin_id = $1 AND ended_at IS NULL
          AND ($3::bigint IS NULL OR id <> $3::bigint)
        RETURNING id::text`,
      [adminId, reason, exceptId ?? null],
    );
    return rows.length;
  }

  /**
   * Закрывает записи, чей сеанс истёк. Время окончания — момент истечения
   * срока, а не «сейчас»: сеанс закончился тогда, а не когда до него дошёл
   * уборщик.
   */
  async expireStaleMailboxAccess(): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE admin_mailbox_access
          SET ended_at = expires_at, end_reason = 'expired'
        WHERE ended_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
        RETURNING id::text`,
    );
    return rows.length;
  }

  /**
   * Входы администраторов в конкретный ящик — для его ВЛАДЕЛЬЦА.
   * Спецификация (docs/admin-spec.md) требует, чтобы владелец видел такие
   * входы в своей истории действий; до сих пор эту таблицу читал только
   * админский маршрут под админским правом.
   */
  async listMailboxAccessForOwner(
    mailboxEmail: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: MailboxAccessRow[]; total: number }> {
    const totalRow = await this.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_mailbox_access
        WHERE lower(mailbox_email) = lower($1)`,
      [mailboxEmail],
    );
    const rows = await this.query<MailboxAccessRow>(
      `SELECT id::text, admin_login, mailbox_email, reason, ip, started_at, ended_at, end_reason
         FROM admin_mailbox_access
        WHERE lower(mailbox_email) = lower($1)
        ORDER BY started_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [mailboxEmail, limit, offset],
    );
    return { rows, total: Number(totalRow?.count ?? 0) };
  }

  async listMailboxAccess(filters: {
    mailboxEmail?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: MailboxAccessRow[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.mailboxEmail) {
      values.push(filters.mailboxEmail.toLowerCase());
      where.push(`lower(mailbox_email) = $${values.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = await this.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_mailbox_access ${whereSql}`,
      values,
    );
    values.push(filters.limit, filters.offset);
    const rows = await this.query<MailboxAccessRow>(
      `SELECT id::text, admin_login, mailbox_email, reason, ip, started_at, ended_at, end_reason
         FROM admin_mailbox_access ${whereSql}
        ORDER BY started_at DESC, id DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { rows, total: Number(totalRow?.count ?? 0) };
  }

  /* ---------------------------------------------------------------- */
  /* Задания импорта (миграция 0006)                                    */
  /* ---------------------------------------------------------------- */

  async createImportJob(input: {
    adminId: number;
    adminLogin: string;
    total: number;
  }): Promise<number> {
    const row = await this.one<{ id: string }>(
      `INSERT INTO user_import_jobs (admin_id, admin_login, total)
       VALUES ($1, $2, $3) RETURNING id::text`,
      [input.adminId > 0 ? input.adminId : null, input.adminLogin, input.total],
    );
    return Number(row?.id ?? 0);
  }

  /**
   * Дописывает состояние задания. Вызывается по ходу импорта, а не только
   * в конце: оборвавшаяся связь не должна уносить с собой сведения о том,
   * что уже создано, — иначе сгенерированные пароли пропадают навсегда.
   */
  async updateImportJob(
    id: number,
    patch: {
      state?: 'running' | 'done' | 'failed';
      processed?: number;
      createdCount?: number;
      failedCount?: number;
      resultEnc?: string | null;
      error?: string | null;
      finished?: boolean;
    },
  ): Promise<void> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}`);
    };
    if (patch.state !== undefined) put('state', patch.state);
    if (patch.processed !== undefined) put('processed', patch.processed);
    if (patch.createdCount !== undefined) put('created_count', patch.createdCount);
    if (patch.failedCount !== undefined) put('failed_count', patch.failedCount);
    if (patch.resultEnc !== undefined) put('result_enc', patch.resultEnc);
    if (patch.error !== undefined) put('error', patch.error);
    if (patch.finished === true) sets.push('finished_at = now()');
    values.push(id);
    await this.query(
      `UPDATE user_import_jobs SET ${sets.join(', ')} WHERE id = $${String(values.length)}`,
      values,
    );
  }

  async findImportJob(id: number): Promise<ImportJobRow | null> {
    return this.one<ImportJobRow>(
      `SELECT id::text, admin_login, state, total, processed, created_count, failed_count,
              result_enc, error, created_at, updated_at, finished_at, expires_at
         FROM user_import_jobs WHERE id = $1`,
      [id],
    );
  }

  async listImportJobs(limit: number): Promise<ImportJobRow[]> {
    return this.query<ImportJobRow>(
      `SELECT id::text, admin_login, state, total, processed, created_count, failed_count,
              NULL::text AS result_enc, error, created_at, updated_at, finished_at, expires_at
         FROM user_import_jobs
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
  }

  /** Просроченные задания вместе с паролями. Пароль не должен лежать вечно. */
  async deleteExpiredImportJobs(): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `DELETE FROM user_import_jobs WHERE expires_at <= now() RETURNING id::text`,
    );
    return rows.length;
  }

  /* ---------------------------------------------------------------- */
  /* Сводка                                                             */
  /* ---------------------------------------------------------------- */

  async overviewCounters(): Promise<{
    domains: number;
    users: number;
    usersActive: number;
    usersBlocked: number;
    aliases: number;
    admins: number;
    quotaTotal: number;
    auditToday: number;
    impersonations7d: number;
  }> {
    const row = await this.one<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM virtual_domains)::text AS domains,
         (SELECT count(*) FROM virtual_users)::text AS users,
         (SELECT count(*) FROM virtual_users WHERE active)::text AS users_active,
         (SELECT count(*) FROM virtual_users WHERE NOT active)::text AS users_blocked,
         (SELECT count(*) FROM virtual_aliases)::text AS aliases,
         (SELECT count(*) FROM admin_users WHERE active)::text AS admins,
         (SELECT coalesce(sum(quota_bytes),0) FROM virtual_users)::text AS quota_total,
         (SELECT count(*) FROM admin_audit_log WHERE created_at > now() - interval '1 day')::text AS audit_today,
         (SELECT count(*) FROM admin_mailbox_access WHERE started_at > now() - interval '7 days')::text AS imp_7d`,
    );
    const num = (key: string): number => Number(row?.[key] ?? 0);
    return {
      domains: num('domains'),
      users: num('users'),
      usersActive: num('users_active'),
      usersBlocked: num('users_blocked'),
      aliases: num('aliases'),
      admins: num('admins'),
      quotaTotal: num('quota_total'),
      auditToday: num('audit_today'),
      impersonations7d: num('imp_7d'),
    };
  }
}
