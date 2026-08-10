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
/*
 * Реестр мест, где лежит адрес владельца. Он же питает смену домена —
 * и это не совпадение: список, из которого убирают данные удалённого
 * ящика, и список, который переписывают при переезде, обязаны быть одним.
 */
import { OWNER_ADDRESS_COLUMNS } from './domain-change.js';

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

/**
 * Строка задания переноса почты (миграция 0011).
 *
 * secret_enc — шифротекст паролей исходных ящиков. Наружу не отдаётся
 * НИКОГДА, даже в таком виде: унесённый шифротекст ждёт компрометации
 * ключа. Поэтому читающие запросы подставляют вместо него NULL, а полное
 * чтение делает только работник (см. findMigrationJobWithSecret).
 */
export interface MigrationJobRow {
  id: string;
  admin_login: string;
  state: string;
  stop_requested: boolean;
  source_host: string;
  source_port: number;
  source_secure: boolean;
  source_insecure_tls: boolean;
  source_master_user: string | null;
  source_master_separator: string | null;
  secret_enc: string | null;
  total: number;
  done_count: number;
  copied: string | number;
  skipped: string | number;
  failed: string | number;
  error: string | null;
  runner: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Строка «ящик задания переноса». */
export interface MigrationItemRow {
  id: string;
  job_id: string;
  position: number;
  source_user: string;
  dest_user: string;
  /** Ящик-приёмник в virtual_users; NULL — его нет (или удалён после). */
  dest_user_id: number | null;
  /**
   * Включён ли ящик-приёмник ПРЯМО СЕЙЧАС; null — ящика нет.
   *
   * Берётся живым соединением, а не запоминается при создании задания:
   * между постановкой в очередь и очередью до этой строки проходят часы,
   * и за это время ящик успевают и отключить, и восстановить из копии.
   */
  dest_active: boolean | null;
  state: string;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  current_folder: string | null;
  errors: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Уникальное нарушение Postgres (23505) — адрес/домен уже занят. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

/** Отсутствующая таблица (42P01) — миграция 0003 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/** Отсутствующий столбец (42703) — например, миграция 0009 не применена. */
export function isUndefinedColumn(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42703');
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

  /**
   * Тема оформления панели у администратора (миграция 0009).
   *
   * Отдельный запрос, а не столбец в общих SELECT: тема нужна ровно двум
   * местам (ответ о сессии и её запись), а строку администратора читают
   * с десяток мест, включая вход, — им лишний столбец ни к чему.
   *
   * База без миграции 0009 не должна ронять вход в панель: столбца нет —
   * значит, темы нет, панель возьмёт свою по умолчанию. Ошибка при этом
   * попадает в журнал ОДИН раз на запрос, а не на экран администратора.
   */
  async getAdminTheme(id: number): Promise<string | null> {
    try {
      const row = await this.one<{ theme: string | null }>(
        `SELECT theme FROM admin_users WHERE id = $1`,
        [id],
      );
      return row?.theme ?? null;
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err;
      this.opts.logger.warn(
        { ...errorInfo(err) },
        'В admin_users нет столбца theme: примените infra/postgres/migrations/0001_baseline.sql. Панель работает с темой по умолчанию.',
      );
      return null;
    }
  }

  /** Запомнить тему за администратором. null — «вернуть тему по умолчанию». */
  async setAdminTheme(id: number, theme: string | null): Promise<void> {
    await this.query(`UPDATE admin_users SET theme = $2, updated_at = now() WHERE id = $1`, [
      id,
      theme,
    ]);
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

  /**
   * Меняет роль и/или признак «действует» у администратора.
   *
   * Пароль сюда не входит намеренно: у него свой путь
   * (admin-password.ts), который вдобавок закрывает все сессии этой
   * учётной записи. Если бы пароль менялся здесь, второе действие рано
   * или поздно забыли бы — и смена пароля перестала бы выгонять того, у
   * кого украли cookie.
   */
  async updateAdmin(
    id: number,
    patch: { role?: string; active?: boolean },
  ): Promise<AdminUserRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    if (patch.role !== undefined) {
      values.push(patch.role);
      sets.push(`role = $${String(values.length)}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${String(values.length)}`);
    }
    if (sets.length === 0) {
      const rows = await this.listAdmins();
      return rows.find((r) => r.id === id) ?? null;
    }
    return this.one<AdminUserRow>(
      `UPDATE admin_users SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1
       RETURNING id, login, password_hash, display_name, role, totp_enabled, active,
                 last_login_at, last_login_ip, failed_attempts, locked_until, created_at`,
      values,
    );
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

  /* ---------------------------------------------------------------- */
  /* Подбор пароля: считаем по паре «учётка + адрес»                     */
  /* ---------------------------------------------------------------- */

  /**
   * Заперт ли ЭТОТ адрес для ЭТОЙ учётной записи.
   *
   * Отдельно от блокировки самой учётной записи: перебирающий запирает
   * себя, а не администратора. Разбор — в миграции 0037.
   */
  async adminAddressLock(login: string, ip: string): Promise<Date | null> {
    const row = await this.one<{ locked_until: Date | null }>(
      `SELECT locked_until FROM admin_login_failures
         WHERE login = $1 AND ip = $2 AND locked_until IS NOT NULL AND locked_until > now()`,
      [login, ip],
    );
    return row?.locked_until ?? null;
  }

  /** Промах с этого адреса. Возвращает счётчик и срок блокировки адреса. */
  async markAdminAddressFailure(
    login: string,
    ip: string,
    maxFailures: number,
    lockMinutes: number,
  ): Promise<{ attempts: number; locked_until: Date | null }> {
    const row = await this.one<{ attempts: number; locked_until: Date | null }>(
      `INSERT INTO admin_login_failures (login, ip, attempts)
            VALUES ($1, $2, 1)
       ON CONFLICT (login, ip) DO UPDATE
          SET attempts = admin_login_failures.attempts + 1,
              locked_until = CASE WHEN admin_login_failures.attempts + 1 >= $3
                                  THEN now() + ($4 || ' minutes')::interval
                                  ELSE admin_login_failures.locked_until END,
              updated_at = now()
        RETURNING attempts, locked_until`,
      [login, ip, maxFailures, String(lockMinutes)],
    );
    return row ?? { attempts: 0, locked_until: null };
  }

  /** Удачный вход — счётчик этого адреса обнуляется. */
  async clearAdminAddressFailures(login: string, ip: string): Promise<void> {
    await this.query(`DELETE FROM admin_login_failures WHERE login = $1 AND ip = $2`, [login, ip]);
  }

  /**
   * Запоминает адрес, с которого вход УДАЛСЯ.
   *
   * Нужно ровно для одного случая: учётная запись заперта из-за
   * распределённого подбора, и надо отличить своих от чужих. Без этого
   * распределённый подбор остаётся способом выключить администратору
   * доступ — только подороже.
   */
  async rememberAdminAddress(adminId: number, ip: string): Promise<void> {
    await this.query(
      `INSERT INTO admin_known_ips (admin_id, ip)
            VALUES ($1, $2)
       ON CONFLICT (admin_id, ip) DO UPDATE SET last_success = now()`,
      [adminId, ip],
    );
  }

  /** Входили ли с этого адреса успешно за последние N суток. */
  async adminAddressKnown(adminId: number, ip: string, days: number): Promise<boolean> {
    const row = await this.one<{ known: boolean }>(
      `SELECT true AS known FROM admin_known_ips
         WHERE admin_id = $1 AND ip = $2 AND last_success > now() - ($3 || ' days')::interval`,
      [adminId, ip, String(days)],
    );
    return row?.known === true;
  }

  /**
   * Уборка: строки о промахах живут не вечно.
   *
   * Без неё таблица растёт от каждого перебора и остаётся расти после
   * него. Читается она на каждом входе, и разрастание — это медленный
   * вход тогда, когда сервер и так под нагрузкой перебора.
   */
  async sweepAdminLoginFailures(keepDays: number): Promise<number> {
    // RETURNING нужен, чтобы узнать, сколько удалено: наш query() отдаёт
    // строки, а не отчёт драйвера.
    const rows = await this.query<{ gone: number }>(
      `DELETE FROM admin_login_failures
         WHERE updated_at < now() - ($1 || ' days')::interval
           AND (locked_until IS NULL OR locked_until < now())
       RETURNING 1 AS gone`,
      [String(keepDays)],
    );
    return rows.length;
  }

  /**
   * Уборка журналов панели по срокам.
   *
   * Три таблицы, у которых срока не было вовсе: журнал действий
   * администраторов, справочник знакомых адресов входа и журнал обращений
   * к ИИ. Все три росли строкой на каждое действие и попадали в каждую
   * резервную копию. Пачками, чтобы длинная уборка не держала базу: за
   * проход убирается не больше нескольких тысяч строк, остальное уйдёт на
   * следующем — уборщик ходит каждую минуту.
   */
  async sweepAdminLogs(opts: {
    auditDays: number;
    aiDays: number;
    knownIpDays: number;
    batch?: number;
  }): Promise<{ audit: number; ai: number; knownIps: number }> {
    const batch = opts.batch ?? 5000;
    const sweep = async (sql: string, days: number): Promise<number> => {
      try {
        const rows = await this.query<{ gone: number }>(sql, [String(days), batch]);
        return rows.length;
      } catch (err) {
        // Таблицы может не быть на старой базе: уборка не повод падать.
        if (isUndefinedTable(err)) return 0;
        throw err;
      }
    };
    /*
     * КОЛОНКИ СО ВРЕМЕНЕМ В ЭТИХ ТАБЛИЦАХ НАЗЫВАЮТСЯ ПО-РАЗНОМУ.
     *
     * `admin_audit_log.created_at`, `ai_audit_log.at`,
     * `admin_known_ips.last_success` — и перепутать их стоит дорого:
     * проход уборщика падает на первом же запросе целиком, вместе с
     * уборкой карантинов и следов подбора паролей, потому что они идут
     * тем же проходом. Живая проверка на стенде поймала обе ошибки
     * подряд: сперва `created_at` там, где `at`, потом наоборот.
     */
    const audit = await sweep(
      `DELETE FROM admin_audit_log
        WHERE id IN (
          SELECT id FROM admin_audit_log
           WHERE created_at < now() - ($1 || ' days')::interval
           ORDER BY id
           LIMIT $2
        )
       RETURNING 1 AS gone`,
      opts.auditDays,
    );
    const ai = await sweep(
      `DELETE FROM ai_audit_log
        WHERE id IN (
          SELECT id FROM ai_audit_log
           WHERE at < now() - ($1 || ' days')::interval
           ORDER BY id
           LIMIT $2
        )
       RETURNING 1 AS gone`,
      opts.aiDays,
    );
    const knownIps = await sweep(
      `DELETE FROM admin_known_ips
        WHERE ctid IN (
          SELECT ctid FROM admin_known_ips
           WHERE last_success < now() - ($1 || ' days')::interval
           LIMIT $2
        )
       RETURNING 1 AS gone`,
      opts.knownIpDays,
    );
    return { audit, ai, knownIps };
  }

  /*
   * КОЛОНКА «АЛИАСОВ» СЧИТАЕТ ПЕРЕСЫЛКИ В ЯЩИК, А НЕ ИЗ НЕГО.
   *
   * Раньше считались алиасы, чей ИСХОДНЫЙ адрес совпадает с адресом
   * ящика, — а такая пара запрещена в обе стороны: алиас поверх живого
   * ящика отклоняет alias-check.ts, ящик на адресе действующего алиаса —
   * маршрут создания. То есть колонка почти всегда показывала ноль.
   *
   * Настоящий вопрос, ради которого в неё смотрят, — «сколько пересылок
   * ведёт В этот ящик»: их и уничтожает удаление ящика (purgeMailboxData).
   */
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
    /**
     * Отбор по списку адресов — для фильтра «превысившие квоту».
     *
     * Занятость ящика живёт не в базе, а в снимке показателей, поэтому
     * сам список считает маршрут, а сюда приходит уже готовым. Пустой
     * список означает «никто не подходит», а не «фильтра нет»: иначе
     * человек увидел бы все ящики там, где ждал ни одного.
     */
    emails?: string[] | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: MailUserRow[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.search) {
      values.push(`%${filters.search.toLowerCase()}%`);
      where.push(
        `(lower(u.email) LIKE $${values.length} OR lower(coalesce(u.display_name,'')) LIKE $${values.length})`,
      );
    }
    if (filters.domainId !== undefined) {
      values.push(filters.domainId);
      where.push(`u.domain_id = $${values.length}`);
    }
    if (filters.active !== undefined) {
      values.push(filters.active);
      where.push(`u.active = $${values.length}`);
    }
    if (filters.emails !== undefined) {
      values.push(filters.emails);
      where.push(`lower(u.email) = ANY($${values.length}::text[])`);
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
              (SELECT count(*) FROM virtual_aliases a WHERE lower(a.destination) = lower(u.email))::text AS alias_count
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
              (SELECT count(*) FROM virtual_aliases a WHERE lower(a.destination) = lower(u.email))::text AS alias_count
         FROM virtual_users u JOIN virtual_domains d ON d.id = u.domain_id
        WHERE u.id = $1`,
      [id],
    );
  }

  async findMailUserByEmail(email: string): Promise<MailUserRow | null> {
    return this.one<MailUserRow>(
      `SELECT u.id, u.domain_id, u.email, u.display_name, u.quota_bytes, u.active,
              u.created_at, u.updated_at, d.name AS domain,
              (SELECT count(*) FROM virtual_aliases a WHERE lower(a.destination) = lower(u.email))::text AS alias_count
         FROM virtual_users u JOIN virtual_domains d ON d.id = u.domain_id
        WHERE lower(u.email) = lower($1)`,
      [email],
    );
  }

  /** Находит домен по имени; при allowCreate создаёт отсутствующий. */
  async resolveDomain(
    name: string,
    allowCreate: boolean,
  ): Promise<{ id: number; name: string } | null> {
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
    await this.query(`UPDATE virtual_users SET password = $2, updated_at = now() WHERE id = $1`, [
      id,
      passwordHash,
    ]);
  }

  async deleteMailUser(id: number): Promise<void> {
    await this.query(`DELETE FROM virtual_users WHERE id = $1`, [id]);
  }

  /**
   * Убирает всё, что принадлежит ящику, но живёт вне virtual_users.
   *
   * Связь этих таблиц с ящиком — по адресу, а не по внешнему ключу (так
   * сделано осознанно: настройки переживают пересоздание строки
   * пользователя, см. миграцию 0005). Плата за это — уборка вручную.
   *
   * ПОЧЕМУ СПИСОК БЕРЁТСЯ ИЗ РЕЕСТРА, А НЕ ПЕРЕЧИСЛЯЕТСЯ ЗДЕСЬ. Раньше
   * перечислялся — и отстал от продукта на четырнадцать разделов из
   * двадцати четырёх. После удаления ящика оставались метки, шаблоны,
   * сохранённые запросы, настройки и подписки на уведомления, отложенные
   * письма, заглушённые переписки, напоминания об ответе, корзина
   * восстановления, задания выгрузки, история входов, одноразовые адреса
   * и журнал расходов помощника.
   *
   * Дорого это стоило бы дважды. Во-первых, одноразовые адреса удалённого
   * ящика оставались ДЕЙСТВУЮЩИМИ: имя занято, почта на него принимается
   * и уходит в никуда. Во-вторых, ящик, заведённый заново с тем же
   * адресом, доставался новому человеку вместе с чужими метками,
   * шаблонами и историей входов — ровно та беда, от которой каталог почты
   * уже уводится в карантин (см. mailbox-cleanup.ts).
   *
   * Теперь список один на две работы: что переезжает при смене домена
   * (OWNER_ADDRESS_COLUMNS), то и убирается при удалении. Раздел, добавленный
   * ради одной из них, попадает во вторую сам. Забыть можно только оба
   * сразу — а этого не пропустит проверка, которая сверяет реестр со схемой.
   *
   * Возвращает число удалённых строк — оно попадает в mailbox_deletions
   * и в журнал аудита, чтобы уборка была видна, а не подразумевалась.
   * Отсутствие таблицы (миграция не применена) пропускается: удаление
   * ящика не должно падать из-за необязательного раздела.
   */
  /**
   * Готовые архивы выгрузки ящика — их пути на диске.
   *
   * Спрашиваются перед удалением ящика. Строку в базе уносит
   * `purgeMailboxData`, а файл удаляет только уборщик по сроку, и берёт
   * он его из той же строки — то есть после удаления ящика архив со ВСЕЙ
   * его перепиской остаётся в томе навсегда, попадает во все резервные
   * копии, и найти его больше нечем: обхода каталога выгрузок в продукте
   * нет.
   */
  async listExportFiles(email: string): Promise<string[]> {
    try {
      const res = await this.pool.query<{ file_path: string }>(
        `SELECT file_path FROM mailbox_export_jobs
          WHERE lower(account_email) = lower($1) AND file_path IS NOT NULL`,
        [email],
      );
      return res.rows.map((row) => row.file_path);
    } catch (err) {
      // Раздела выгрузок может не быть вовсе (миграция не применена).
      if (isUndefinedTable(err)) return [];
      throw err;
    }
  }

  async purgeMailboxData(email: string): Promise<{ rows: number; aliases: string[] }> {
    /*
     * ОДНОРАЗОВЫЙ АДРЕС — ЭТО ДВЕ СТРОКИ, И УДАЛЯТЬ НАДО ОБЕ.
     *
     * Маршрут живёт в `virtual_aliases` — именно его читает Postfix. Рядом
     * стоит пристройка в `disposable_aliases` со ссылкой
     * `alias_id REFERENCES virtual_aliases(id) ON DELETE CASCADE`, то есть
     * каскад работает ТОЛЬКО в одну сторону: убрали маршрут — пристройка
     * ушла сама; убрали пристройку — маршрут остался.
     *
     * Общий цикл ниже идёт по реестру и удаляет ровно пристройку. Из-за
     * этого одноразовые адреса удалённого ящика оставались действующими:
     * имя занято, почта на них принимается и разворачивается в
     * несуществующий ящик. Из раздела «Одноразовые адреса» строка при этом
     * исчезала — выключить её владельцу было нечем, а в разделе «Алиасы»
     * она висела без хозяина. Хуже всего третье: ящик, заведённый заново с
     * тем же адресом, получал весь спам, накопленный на старых одноразовых
     * адресах прежнего владельца.
     *
     * Поэтому маршруты сносятся отдельным запросом ДО общего цикла — а
     * пристройки к ним уносит каскад. То, что общий цикл потом не найдёт
     * ни одной строки, нормально: он и не должен знать про эту связь.
     */
    let removed = 0;
    /** Уничтоженные пересылки — поимённо, для журнала аудита. */
    const removedAliases: string[] = [];
    try {
      const routes = await this.pool.query(
        `DELETE FROM virtual_aliases
           WHERE id IN (SELECT alias_id FROM disposable_aliases WHERE lower(owner_email) = lower($1))`,
        [email],
      );
      removed += routes.rowCount ?? 0;
    } catch (err) {
      // Раздела одноразовых адресов может не быть вовсе (миграция не
      // применена) — удаление ящика из-за этого падать не должно.
      if (!isUndefinedTable(err)) throw err;
    }

    /*
     * Алиасы, ВЕДУЩИЕ В ЭТОТ ЯЩИК, — отдельным запросом.
     *
     * Диалог удаления обещает это прямым текстом («алиасы, которые вели в
     * этот ящик»), а не убирал их никто: общий реестр адресных колонок
     * знает `virtual_aliases.source`, но не `destination`, а внешнего
     * ключа на `virtual_users` у этой таблицы нет — только каскад от
     * домена.
     *
     * Оставленный алиас указывает в пустоту: Postfix переписывает адрес в
     * несуществующий ящик и отбивает письма отправителям. Пересылка,
     * работавшая годами, умирает молча, а в панели её не видно — колонка
     * «Алиасов» в списке ящиков считает только направление `source`.
     */
    try {
      /*
       * RETURNING, а не просто число: уничтоженные пересылки надо назвать
       * поимённо в журнале аудита. Раньше здесь оставалось только общее
       * `db_rows_removed` вперемешку с одноразовыми адресами — то есть
       * пересылка, работавшая годами, умирала молча и восстановить её было
       * неоткуда. У удаления домена ровно это уже починено: там полный
       * список уходит в before.aliases_removed (routes/domains.ts).
       */
      const inbound = await this.pool.query<{ source: string; destination: string }>(
        `DELETE FROM virtual_aliases WHERE lower(destination) = lower($1)
         RETURNING source, destination`,
        [email],
      );
      removed += inbound.rowCount ?? 0;
      for (const row of inbound.rows) removedAliases.push(`${row.source} -> ${row.destination}`);
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
    }

    const statements = OWNER_ADDRESS_COLUMNS.filter((c) => c.onDelete !== 'keep').map((column) => ({
      /*
       * Имена таблицы и колонки не приходят снаружи: они перечислены в
       * реестре в коде. Поэтому подстановка здесь безопасна — а параметром
       * их в SQL и не передать.
       */
      sql: `DELETE FROM ${column.table} WHERE lower(${column.column}) = lower($1)`,
      values: [email] as unknown[],
    }));

    for (const statement of statements) {
      try {
        const result = await this.pool.query(statement.sql, statement.values);
        removed += result.rowCount ?? 0;
      } catch (err) {
        if (!isUndefinedTable(err)) throw err;
      }
    }
    return { rows: removed, aliases: removedAliases };
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
  /**
   * Записи, по которым пора убирать карантин.
   *
   * Отдаётся не только путь карантина, но и путь самого каталога с ошибкой
   * предыдущей попытки. Без них уборщик не мог отличить два совершенно
   * разных случая, потому что оба выглядят как «карантина нет»:
   *
   *   • каталога не было вовсе (ящик ни разу не открывали) — убирать нечего;
   *   • увести каталог в карантин НЕ УДАЛОСЬ (права, том только на чтение) —
   *     почта осталась лежать по живому пути.
   *
   * Второй случай уборщик закрывал как успешно убранный, и каталог с чужой
   * перепиской доставался тому, кто заведёт ящик с этим же адресом заново.
   */
  async listDeletionsToPurge(
    limit: number,
    maxAttempts = 10,
  ): Promise<
    Array<{
      id: number;
      email: string;
      quarantinePath: string | null;
      maildirPath: string | null;
      error: string | null;
    }>
  > {
    const rows = await this.query<{
      id: string;
      email: string;
      quarantine_path: string | null;
      maildir_path: string | null;
      error: string | null;
    }>(
      `SELECT id::text, email, quarantine_path, maildir_path, error
         FROM mailbox_deletions
        WHERE state = 'pending' AND purge_after <= now() AND attempts < $2
        ORDER BY purge_after
        LIMIT $1`,
      [limit, maxAttempts],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      quarantinePath: r.quarantine_path,
      maildirPath: r.maildir_path,
      error: r.error,
    }));
  }

  /**
   * Сколько удалений ящиков упёрлись в предел попыток.
   *
   * Такая запись из выборки уборщика выпадает (attempts < MAX), и без
   * этого счётчика она пропадала МОЛЧА: карантинный каталог с чужой
   * почтой остаётся на диске навсегда, предупреждений больше нет,
   * сбросить счётчик нечем. Считаем их отдельно, чтобы сказать вслух —
   * в журнал уборщика и в самопроверку панели.
   */
  async countStuckDeletions(maxAttempts: number): Promise<number> {
    const row = await this.one<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM mailbox_deletions
        WHERE state = 'pending' AND purge_after <= now() AND attempts >= $1`,
      [maxAttempts],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Возвращает застрявшие удаления в работу: обнуляет счётчик попыток.
   *
   * Нужен ровно для того случая, ради которого повторы и заведены: том
   * был только на чтение, права чинили руками — после починки уборщику
   * надо дать ещё один шанс, а другого способа не было вовсе.
   */
  async retryStuckDeletions(maxAttempts: number): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE mailbox_deletions
          SET attempts = 0
        WHERE state = 'pending' AND attempts >= $1
        RETURNING id::text`,
      [maxAttempts],
    );
    return rows.length;
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

  /**
   * Ящики по списку адресов: номер строки и признак «включён».
   *
   * Нужно там, где адрес пришёл извне и его нельзя принимать на веру, —
   * прежде всего заданиям переноса почты. Одним запросом на весь список,
   * а не по адресу за раз: в выгрузке Kerio их бывают сотни.
   *
   * Ключ карты — адрес в нижнем регистре: адреса ящиков нечувствительны к
   * регистру, и «Ivan@» из чужой выгрузки обязан найти наш «ivan@».
   */
  async findMailboxStates(
    emails: readonly string[],
  ): Promise<Map<string, { id: number; email: string; active: boolean }>> {
    const found = new Map<string, { id: number; email: string; active: boolean }>();
    if (emails.length === 0) return found;
    const rows = await this.query<{ id: number; email: string; active: boolean }>(
      `SELECT id, email, active FROM virtual_users WHERE lower(email) = ANY($1::text[])`,
      [[...new Set(emails.map((e) => e.trim().toLowerCase()))]],
    );
    for (const row of rows) found.set(row.email.toLowerCase(), row);
    return found;
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

  async saveDnsStatus(domainId: number, status: unknown, overall: string): Promise<void> {
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
    patch: {
      dkimSelector?: string;
      dkimPublicKey?: string | null;
      dkimDnsRecord?: string | null;
      notes?: string | null;
    },
  ): Promise<void> {
    await this.query(
      `INSERT INTO domain_settings (domain_id, dkim_selector, dkim_public_key, dkim_dns_record, notes)
       VALUES ($1, coalesce($2, 'mail'), $3, $4, $5)
       ON CONFLICT (domain_id) DO UPDATE
          SET dkim_selector   = CASE WHEN $6 THEN coalesce($2, domain_settings.dkim_selector)
                                     ELSE domain_settings.dkim_selector END,
              dkim_public_key = CASE WHEN $7 THEN $3 ELSE domain_settings.dkim_public_key END,
              dkim_dns_record = CASE WHEN $8 THEN $4 ELSE domain_settings.dkim_dns_record END,
              notes           = CASE WHEN $9 THEN $5 ELSE domain_settings.notes END,
              updated_at = now()`,
      [
        domainId,
        patch.dkimSelector ?? null,
        patch.dkimPublicKey ?? null,
        patch.dkimDnsRecord ?? null,
        patch.notes ?? null,
        /*
         * «Не трогать» и «стереть» — разные вещи, и coalesce их путал.
         *
         * Раньше все четыре поля писались как `coalesce($n, прежнее)`, то
         * есть null означал «оставь как было». Но null приходит и от того,
         * кто просит СТЕРЕТЬ: схема маршрута объявляет `dkimPublicKey` и
         * `notes` nullable именно для этого. Убрать скомпрометированный
         * или устаревший ключ DKIM из панели было нельзя вообще — ответ
         * 200, в аудите before равно after, значение на месте.
         *
         * Теперь «не трогать» выражается ОТСУТСТВИЕМ поля (undefined), а
         * null пишется как null.
         */
        patch.dkimSelector !== undefined,
        patch.dkimPublicKey !== undefined,
        patch.dkimDnsRecord !== undefined,
        patch.notes !== undefined,
      ],
    );
  }

  /**
   * Куда ведёт алиас с таким исходным адресом. Нужен проверке связности:
   * по нему разматывается цепочка перенаправлений и ищется кольцо.
   */
  async aliasTargetOf(source: string): Promise<string | null> {
    const res = await this.pool.query<{ destination: string }>(
      `SELECT destination FROM virtual_aliases WHERE lower(source) = lower($1) AND active LIMIT 1`,
      [source],
    );
    return res.rows[0]?.destination ?? null;
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
      where.push(
        `(lower(a.source) LIKE $${values.length} OR lower(a.destination) LIKE $${values.length})`,
      );
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
      this.opts.logger.error(
        errorInfo(err, { action: record.action }),
        'Не удалось записать аудит',
      );
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
  /* Задания переноса почты (миграция 0011)                             */
  /* ---------------------------------------------------------------- */

  /**
   * Применены ли миграции переноса: 0013 (таблицы) и 0020 (связь строки
   * ящика с virtual_users). Без них раздел переноса честно отвечает 503.
   *
   * Столбец проверяется вместе с таблицей намеренно. Без dest_user_id
   * задание можно завести на несуществующий ящик, и узнаётся это уже
   * посреди переноса — ровно тот дефект, ради которого 0020 и появилась.
   * Работать «почти правильно» в этом месте хуже, чем не работать:
   * ночной перенос чужой почты не то занятие, где уместны сюрпризы.
   */
  async migrationSchemaReady(): Promise<boolean> {
    const row = await this.one<{ ok: boolean }>(
      `SELECT to_regclass('public.mail_migration_jobs') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'mail_migration_items'
                   AND column_name = 'dest_user_id'
              ) AS ok`,
    );
    return row?.ok === true;
  }

  /**
   * Завести задание вместе со списком ящиков одной транзакцией.
   *
   * Именно транзакцией: задание без строк ящиков — это «идёт перенос
   * ничего», а строки без задания вообще никто никогда не увидит.
   */
  async createMigrationJob(input: {
    adminId: number;
    adminLogin: string;
    source: {
      host: string;
      port: number;
      secure: boolean;
      allowInsecureTls: boolean;
      masterUser: string | null;
      masterSeparator: string | null;
    };
    secretEnc: string;
    /**
     * `destUserId` — строка ящика-приёмника в virtual_users (миграция 0020).
     * Проставляется при создании задания и держит связь настоящей: адрес
     * остаётся текстом ради отчёта, а существование проверяет база.
     */
    mailboxes: ReadonlyArray<{ sourceUser: string; destUser: string; destUserId?: number | null }>;
  }): Promise<number> {
    return this.transaction(async (client) => {
      const job = await client.query<{ id: string }>(
        `INSERT INTO mail_migration_jobs
           (admin_id, admin_login, source_host, source_port, source_secure,
            source_insecure_tls, source_master_user, source_master_separator,
            secret_enc, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id::text`,
        [
          input.adminId > 0 ? input.adminId : null,
          input.adminLogin,
          input.source.host,
          input.source.port,
          input.source.secure,
          input.source.allowInsecureTls,
          input.source.masterUser,
          input.source.masterSeparator,
          input.secretEnc,
          input.mailboxes.length,
        ],
      );
      const id = Number(job.rows[0]?.id ?? 0);
      for (const [index, box] of input.mailboxes.entries()) {
        await client.query(
          `INSERT INTO mail_migration_items (job_id, position, source_user, dest_user, dest_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, index, box.sourceUser, box.destUser, box.destUserId ?? null],
        );
      }
      return id;
    });
  }

  /**
   * Адреса ящиков-приёмников, в которые ПРЯМО СЕЙЧАС идёт перенос.
   *
   * Нужны восстановлению настроек из копии: копия несёт признак «ящик
   * включён», и применённая посреди ночного переноса она гасит ящик,
   * в который в этот момент кладут письма. Само восстановление при этом
   * не запрещается (объяснение — в routes/backup.ts), но человек обязан
   * узнать об этом от нас, а не по остановившимся счётчикам.
   *
   * Отсутствие таблиц (миграция 0013 не применена) — не повод ронять
   * восстановление: переноса тогда нет по определению.
   */
  async listActiveMigrationDestinations(): Promise<string[]> {
    try {
      const rows = await this.query<{ dest_user: string }>(
        `SELECT DISTINCT i.dest_user
           FROM mail_migration_items i
           JOIN mail_migration_jobs j ON j.id = i.job_id
          WHERE j.state IN ('queued', 'running')
            AND i.state IN ('queued', 'running')`,
      );
      return rows.map((r) => r.dest_user.toLowerCase());
    } catch (err) {
      if (isUndefinedTable(err)) return [];
      throw err;
    }
  }

  /**
   * Взять незавершённые задания под себя.
   *
   * Именно так перенос переживает перезапуск контейнера: у нового процесса
   * другой runner, а heartbeat_at прежнего перестал обновляться — задание
   * со «стухшим» биением подхватывается и продолжается с того места, где
   * его застал перезапуск (состояние докачки лежит в migrate_cursors).
   *
   * СКОЛЬКО ЗАДАНИЙ БРАТЬ ЗА РАЗ — ОТДЕЛЬНЫЙ ВОПРОС.
   *
   * Здесь не было предела вовсе: забирались ВСЕ незавершённые задания
   * сразу, и на каждое заводился свой перенос со своим пулом соединений
   * к базе. Переезд по отделам (список на 50 ящиков, потом следующий)
   * означал столько живых заданий, сколько их успели завести, и десятки
   * соединений сверх собственных пулов api. Postgres с умолчанием
   * max_connections = 100 отвечает на это «too many clients» — а из той же
   * базы берут данные Postfix и Dovecot, то есть сервер перестаёт
   * принимать почту и пускать людей в ящики. Фоновая работа не имеет права
   * ронять доставку, поэтому число одновременных заданий задаёт работник.
   *
   * @param staleSeconds после какого молчания считать прежнего работника мёртвым
   * @param limit        сколько заданий взять за этот проход
   * @param skipIds      задания, которые этот работник уже ведёт (их
   *                     биение обновляет отдельный таймер, и место в
   *                     пределе они занимать не должны)
   */
  async claimMigrationJobs(
    runner: string,
    staleSeconds: number,
    limit: number,
    skipIds: number[] = [],
  ): Promise<MigrationJobRow[]> {
    if (limit <= 0) return [];
    return this.query<MigrationJobRow>(
      `UPDATE mail_migration_jobs
          SET runner = $1, heartbeat_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM mail_migration_jobs
           WHERE state IN ('queued', 'running')
             AND NOT (id = ANY($4::bigint[]))
             AND (runner IS NULL
                  OR runner = $1
                  OR heartbeat_at IS NULL
                  OR heartbeat_at < now() - make_interval(secs => $2::double precision))
           -- По возрастанию номера: кто встал в очередь раньше, тот и едет
           -- раньше. SKIP LOCKED — чтобы два процесса не ждали друг друга
           -- на одной и той же строке.
           ORDER BY id
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id::text, admin_login, state, stop_requested, source_host, source_port,
                  source_secure, source_insecure_tls, source_master_user,
                  source_master_separator, secret_enc, total, done_count, copied,
                  skipped, failed, error, runner, heartbeat_at, created_at, updated_at,
                  started_at, finished_at`,
      [runner, staleSeconds, limit, skipIds],
    );
  }

  /**
   * Отпустить задание при остановке процесса, НЕ завершая его.
   *
   * Разница с updateMigrationJob({finished:true}) принципиальная: там
   * задание заканчивается и пароли стираются, здесь оно остаётся идущим
   * и пароли остаются. Перезапуск контейнера — не решение человека
   * прекратить перенос; закончив задание по SIGTERM, мы стирали бы пароли
   * и превращали обновление образа в потерю ночи переноса.
   *
   * Обнулённый runner значит «ничей»: следующий процесс забирает задание
   * немедленно, не выжидая срока молчания.
   */
  async releaseMigrationJob(id: number, runner: string): Promise<void> {
    await this.query(
      `UPDATE mail_migration_jobs
          SET runner = NULL, heartbeat_at = NULL, updated_at = now()
        WHERE id = $1 AND runner = $2 AND state IN ('queued', 'running')`,
      [id, runner],
    );
  }

  /**
   * Считает сорвавшуюся попытку и возвращает, сколько их подряд.
   *
   * Отдельный счётчик нужен потому, что «сорвалось» перестало завершать
   * задание: завершение стирает пароли исходных ящиков, и секундный
   * перерыв в работе базы не повод их уничтожать. Но и крутить задание
   * вечно нельзя — а именно это и выходило: работник берёт его каждые
   * десять секунд и тем же запросом обновляет отметку «жив», поэтому
   * сторож «молчит дольше 48 часов» не срабатывает никогда.
   */
  async bumpMigrationAttempt(id: number): Promise<number> {
    const rows = await this.query<{ attempts: number }>(
      `UPDATE mail_migration_jobs
          SET attempts = attempts + 1, updated_at = now()
        WHERE id = $1
        RETURNING attempts`,
      [id],
    );
    return rows[0]?.attempts ?? 0;
  }

  /** Удачный проход — счётчик сорвавшихся попыток обнуляется. */
  async resetMigrationAttempts(id: number): Promise<void> {
    await this.query(`UPDATE mail_migration_jobs SET attempts = 0 WHERE id = $1`, [id]);
  }

  /** Отметиться живым. Пока биение идёт, задание не отберёт другой процесс. */
  async touchMigrationJob(id: number, runner: string): Promise<void> {
    await this.query(
      `UPDATE mail_migration_jobs SET heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND runner = $2`,
      [id, runner],
    );
  }

  /** Нажали ли «Остановить». Работник спрашивает это между письмами. */
  async isMigrationStopRequested(id: number): Promise<boolean> {
    const row = await this.one<{ stop_requested: boolean }>(
      'SELECT stop_requested FROM mail_migration_jobs WHERE id = $1',
      [id],
    );
    return row?.stop_requested === true;
  }

  async requestMigrationStop(id: number): Promise<void> {
    await this.query(
      `UPDATE mail_migration_jobs SET stop_requested = TRUE, updated_at = now()
        WHERE id = $1 AND state IN ('queued', 'running')`,
      [id],
    );
  }

  async updateMigrationJob(
    id: number,
    patch: {
      state?: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
      doneCount?: number;
      copied?: number;
      skipped?: number;
      failed?: number;
      error?: string | null;
      started?: boolean;
      /**
       * Завершение. Здесь же СТИРАЕТСЯ свёрток паролей: они нужны ровно
       * столько, сколько идёт задание, и ни секундой дольше. Отдельной
       * командой этого не делают намеренно — отдельную команду можно
       * не выполнить (упал процесс, оборвалась связь), и пароль останется
       * лежать в базе, хотя переносить уже нечего.
       *
       * ОБРАТНАЯ СТОРОНА, о которой обязан помнить всякий, кто это зовёт:
       * finished:true — это НЕ «отметить неудачу». Это «переносить больше
       * нечего, пароли уничтожить». Работник однажды ставил его на любую
       * неожиданную ошибку, и секундный перерыв в работе базы уничтожал
       * свёрток паролей сотен чужих ящиков без возможности восстановить
       * (см. migrate-runner.ts, обработчик неожиданного отказа). Сорвалась
       * попытка — задание отпускают, а не заканчивают.
       */
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
    if (patch.doneCount !== undefined) put('done_count', patch.doneCount);
    if (patch.copied !== undefined) put('copied', patch.copied);
    if (patch.skipped !== undefined) put('skipped', patch.skipped);
    if (patch.failed !== undefined) put('failed', patch.failed);
    if (patch.error !== undefined) put('error', patch.error);
    if (patch.started === true) sets.push('started_at = COALESCE(started_at, now())');
    if (patch.finished === true) {
      sets.push('finished_at = now()', 'secret_enc = NULL', 'runner = NULL');
    }
    values.push(id);
    await this.query(
      `UPDATE mail_migration_jobs SET ${sets.join(', ')} WHERE id = $${String(values.length)}`,
      values,
    );
  }

  /** Полная строка задания ВМЕСТЕ с шифротекстом — только для работника. */
  async findMigrationJobWithSecret(id: number): Promise<MigrationJobRow | null> {
    return this.one<MigrationJobRow>(
      `SELECT id::text, admin_login, state, stop_requested, source_host, source_port,
              source_secure, source_insecure_tls, source_master_user,
              source_master_separator, secret_enc, total, done_count, copied, skipped,
              failed, error, runner, heartbeat_at, created_at, updated_at, started_at,
              finished_at
         FROM mail_migration_jobs WHERE id = $1`,
      [id],
    );
  }

  /** Строка задания для интерфейса: шифротекст заменён на NULL. */
  async findMigrationJob(id: number): Promise<MigrationJobRow | null> {
    return this.one<MigrationJobRow>(
      `SELECT id::text, admin_login, state, stop_requested, source_host, source_port,
              source_secure, source_insecure_tls, source_master_user,
              source_master_separator, NULL::text AS secret_enc, total, done_count,
              copied, skipped, failed, error, runner, heartbeat_at, created_at,
              updated_at, started_at, finished_at
         FROM mail_migration_jobs WHERE id = $1`,
      [id],
    );
  }

  async listMigrationJobs(limit: number): Promise<MigrationJobRow[]> {
    return this.query<MigrationJobRow>(
      `SELECT id::text, admin_login, state, stop_requested, source_host, source_port,
              source_secure, source_insecure_tls, source_master_user,
              source_master_separator, NULL::text AS secret_enc, total, done_count,
              copied, skipped, failed, error, runner, heartbeat_at, created_at,
              updated_at, started_at, finished_at
         FROM mail_migration_jobs
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
  }

  async listMigrationItems(jobId: number): Promise<MigrationItemRow[]> {
    return this.query<MigrationItemRow>(
      // Состояние ящика-приёмника подтягивается СВЕРКОЙ ПО АДРЕСУ, а не
      // только по dest_user_id: у заданий, заведённых до миграции 0020,
      // ссылки нет, и без сверки они выглядели бы как «ящик удалён».
      `SELECT i.id::text, i.job_id::text, i.position, i.source_user, i.dest_user,
              i.dest_user_id, u.active AS dest_active, i.state, i.total,
              i.copied, i.skipped, i.failed, i.current_folder, i.errors,
              i.started_at, i.finished_at
         FROM mail_migration_items i
         LEFT JOIN virtual_users u
                ON u.id = i.dest_user_id
                OR (i.dest_user_id IS NULL AND lower(u.email) = lower(i.dest_user))
        WHERE i.job_id = $1 ORDER BY i.position`,
      [jobId],
    );
  }

  async updateMigrationItem(
    jobId: number,
    position: number,
    patch: {
      state?: 'queued' | 'running' | 'ok' | 'partial' | 'failed' | 'stopped';
      total?: number;
      copied?: number;
      skipped?: number;
      failed?: number;
      currentFolder?: string | null;
      errors?: string | null;
      started?: boolean;
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
    if (patch.total !== undefined) put('total', patch.total);
    if (patch.copied !== undefined) put('copied', patch.copied);
    if (patch.skipped !== undefined) put('skipped', patch.skipped);
    if (patch.failed !== undefined) put('failed', patch.failed);
    if (patch.currentFolder !== undefined) put('current_folder', patch.currentFolder);
    if (patch.errors !== undefined) put('errors', patch.errors);
    if (patch.started === true) sets.push('started_at = COALESCE(started_at, now())');
    if (patch.finished === true) sets.push('finished_at = now()');
    values.push(jobId, position);
    await this.query(
      `UPDATE mail_migration_items SET ${sets.join(', ')}
        WHERE job_id = $${String(values.length - 1)} AND position = $${String(values.length)}`,
      values,
    );
  }

  /**
   * Пароли заданий, которые уже никто не ведёт.
   *
   * Страховка на случай, за который иначе никто не отвечает: работник
   * умер, задание никем не подхвачено (раздел выключили, сервер перевели
   * в другой режим) — а свёрток паролей лежит. Здесь он стирается, а само
   * задание честно помечается неудавшимся: продолжить его без паролей всё
   * равно нельзя, и делать вид, что оно «идёт», — обман.
   */
  async expireStaleMigrationJobs(maxHours: number): Promise<number> {
    const rows = await this.query<{ id: string }>(
      /*
       * БРОШЕНО — ЭТО ПРО МОЛЧАНИЕ, А НЕ ПРО ВОЗРАСТ.
       *
       * Условие смотрело только на created_at: задание старше срока
       * убивалось независимо от того, идёт оно прямо сейчас или нет. А
       * перенос организации — это сотни ящиков и, как прямо сказано в
       * шапке работника, сутки работы.
       *
       * Выходило так: на исходе срока очередной обход (раз в десять
       * секунд) находил ЖИВОЕ задание и ставил ему state = 'failed',
       * secret_enc = NULL, runner = NULL. Последствия:
       *
       *   * в панели идущий перенос показан отказавшим, причём с ложной
       *     причиной «работник не выходил на связь» — биение шло секунду
       *     назад, и счётчики продолжали расти;
       *   * touchMigrationJob перестаёт что-либо обновлять (он ищет по
       *     runner, а тот уже NULL);
       *   * задание больше не подхватывается: claimMigrationJobs берёт
       *     только queued и running.
       *
       * То есть перезапуск контейнера в этот момент — уже не «продолжится
       * после запуска», как обещает вся конструкция работника, а
       * безвозвратная потеря: свёрток паролей исходных ящиков стёрт, и
       * пароли сотен чужих ящиков приходится собирать заново.
       *
       * Правильный признак брошенности у нас уже есть и им же пользуется
       * claimMigrationJobs — heartbeat_at. Работник обновляет его, пока
       * жив; молчание дольше срока и означает, что вести задание некому.
       * Возраст остаётся как запасной случай для заданий, которые не
       * начинали вести НИ РАЗУ (heartbeat_at пуст).
       */
      `UPDATE mail_migration_jobs
          SET state = 'failed', secret_enc = NULL, runner = NULL,
              finished_at = now(), updated_at = now(),
              error = COALESCE(error, 'Задание брошено: работник не выходил на связь дольше допустимого. '
                                    || 'Пароли стёрты, продолжить можно новым заданием.')
        WHERE state IN ('queued', 'running')
          AND (
                heartbeat_at < now() - make_interval(hours => $1::int)
                OR (heartbeat_at IS NULL
                    AND created_at < now() - make_interval(hours => $1::int))
              )
        RETURNING id::text`,
      [maxHours],
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
