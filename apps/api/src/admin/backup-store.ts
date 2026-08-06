/**
 * Чтение и запись настроек для резервной копии.
 *
 * Отдельно от backup-format.ts намеренно: там формат файла и правила, тут
 * SQL. Формат проверяется обычными тестами без базы, а SQL — на живой базе.
 *
 * Ни одна таблица здесь не обязана существовать: миграции 0004 (ИИ) и 0005
 * (настройки пользователей) применяют не всегда. Отсутствие таблицы — это
 * «раздела нет», а не отказ всей выгрузки: копия без помощника ИИ полезнее,
 * чем отсутствие копии.
 */
import type { PoolClient } from 'pg';
import type { AdminDb } from './db.js';
import { isUndefinedTable } from './db.js';
import type { BrandingStore } from './branding.js';
import {
  buildSettingsBackup,
  type AiEntry,
  type AliasEntry,
  type AdminEntry,
  type BackupSection,
  type CurrentSnapshot,
  type DomainEntry,
  type MailboxEntry,
  type SettingsBackupFile,
  type UserSettingsEntry,
} from './backup-format.js';

/** Запрос, для которого отсутствие таблицы — пустой ответ, а не ошибка. */
async function optional<T extends Record<string, unknown>>(
  db: AdminDb,
  sql: string,
): Promise<T[]> {
  try {
    return (await db.query(sql)) as T[];
  } catch (err) {
    if (isUndefinedTable(err)) return [];
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Выгрузка                                                             */
/* ------------------------------------------------------------------ */

export async function exportSettings(
  db: AdminDb,
  branding: BrandingStore,
  source: { hostname: string; domain: string },
): Promise<SettingsBackupFile> {
  const domains = (
    await optional<{
      name: string;
      dkim_selector: string | null;
      dkim_public_key: string | null;
      dkim_dns_record: string | null;
      notes: string | null;
    }>(
      db,
      `SELECT d.name, s.dkim_selector, s.dkim_public_key, s.dkim_dns_record, s.notes
         FROM virtual_domains d
         LEFT JOIN domain_settings s ON s.domain_id = d.id
        ORDER BY d.name`,
    )
  ).map<DomainEntry>((row) => ({
    name: row.name,
    dkimSelector: row.dkim_selector,
    dkimPublicKey: row.dkim_public_key,
    dkimDnsRecord: row.dkim_dns_record,
    notes: row.notes,
  }));

  // Хэш пароля едет намеренно — см. шапку backup-format.ts.
  const mailboxes = (
    await optional<{
      email: string;
      display_name: string | null;
      quota_bytes: string | number;
      active: boolean;
      password: string;
    }>(
      db,
      `SELECT email, display_name, quota_bytes, active, password
         FROM virtual_users ORDER BY email`,
    )
  ).map<MailboxEntry>((row) => ({
    email: row.email,
    displayName: row.display_name,
    quotaBytes: Number(row.quota_bytes),
    active: row.active,
    passwordHash: row.password,
  }));

  const aliases = (
    await optional<{ source: string; destination: string; active: boolean }>(
      db,
      `SELECT source, destination, active FROM virtual_aliases ORDER BY source, destination`,
    )
  ).map<AliasEntry>((row) => ({
    source: row.source,
    destination: row.destination,
    active: row.active,
  }));

  // totp_secret не выбирается вовсе: второй фактор файлом не возят.
  const admins = (
    await optional<{
      login: string;
      display_name: string | null;
      role: string;
      active: boolean;
      password_hash: string;
    }>(
      db,
      `SELECT login, display_name, role, active, password_hash
         FROM admin_users ORDER BY login`,
    )
  ).map<AdminEntry>((row) => ({
    login: row.login,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    passwordHash: row.password_hash,
  }));

  const userSettings = await exportUserSettings(db);

  // api_key_enc не выбирается: он зашифрован ключом из infra/.env, а .env
  // в копию не входит — на другой установке такой ключ не расшифруется.
  const ai = (
    await optional<{
      domain: string;
      enabled: boolean;
      base_url: string | null;
      chat_path: string;
      model: string | null;
      provider_label: string;
      is_local: boolean;
      max_body_chars: number;
      timeout_ms: number;
      max_output_tokens: number;
      has_key: boolean;
    }>(
      db,
      `SELECT d.name AS domain, a.enabled, a.base_url, a.chat_path, a.model,
              a.provider_label, a.is_local, a.max_body_chars, a.timeout_ms,
              a.max_output_tokens, (a.api_key_enc IS NOT NULL) AS has_key
         FROM ai_domain_settings a
         JOIN virtual_domains d ON d.id = a.domain_id
        ORDER BY d.name`,
    )
  ).map<AiEntry>((row) => ({
    domain: row.domain,
    enabled: row.enabled,
    baseUrl: row.base_url,
    chatPath: row.chat_path,
    model: row.model,
    providerLabel: row.provider_label,
    isLocal: row.is_local,
    maxBodyChars: Number(row.max_body_chars),
    timeoutMs: Number(row.timeout_ms),
    maxOutputTokens: Number(row.max_output_tokens),
    apiKeyPresent: row.has_key,
  }));

  const brandingSnapshot = await branding.exportSnapshot();

  return buildSettingsBackup({
    source,
    data: { domains, mailboxes, aliases, admins, userSettings, ai, branding: brandingSnapshot },
  });
}

async function exportUserSettings(db: AdminDb): Promise<UserSettingsEntry[]> {
  const settings = await optional<Record<string, unknown>>(
    db,
    `SELECT * FROM mail_user_settings ORDER BY account_email`,
  );
  const signatures = await optional<{
    account_email: string;
    name: string;
    body_html: string;
    is_default: boolean;
    position: number;
  }>(
    db,
    `SELECT account_email, name, body_html, is_default, position
       FROM mail_signatures ORDER BY account_email, position, id`,
  );
  const filters = await optional<{
    account_email: string;
    name: string;
    position: number;
    enabled: boolean;
    is_auto: boolean;
    match_mode: string;
    conditions: unknown;
    actions: unknown;
  }>(
    db,
    `SELECT account_email, name, position, enabled, is_auto, match_mode, conditions, actions
       FROM mail_filters ORDER BY account_email, position, id`,
  );

  const byEmail = new Map<string, UserSettingsEntry>();
  const entry = (email: string): UserSettingsEntry => {
    const key = email.toLowerCase();
    let found = byEmail.get(key);
    if (!found) {
      found = { accountEmail: email, settings: null, signatures: [], filters: [] };
      byEmail.set(key, found);
    }
    return found;
  };

  for (const row of settings) {
    const email = String(row.account_email ?? '');
    if (email === '') continue;
    // Строку кладём как есть: набор колонок задаёт миграция 0005, и
    // перечислять их здесь — значит забыть новую при следующей правке.
    // Из копии обратно едут только известные колонки (см. restore ниже).
    entry(email).settings = row;
  }
  for (const row of signatures) {
    entry(row.account_email).signatures.push({
      name: row.name,
      bodyHtml: row.body_html,
      isDefault: row.is_default,
      position: Number(row.position),
    });
  }
  for (const row of filters) {
    entry(row.account_email).filters.push({
      name: row.name,
      position: Number(row.position),
      enabled: row.enabled,
      isAuto: row.is_auto,
      matchMode: row.match_mode === 'any' ? 'any' : 'all',
      conditions: row.conditions ?? [],
      actions: row.actions ?? {},
    });
  }
  return [...byEmail.values()];
}

/* ------------------------------------------------------------------ */
/* Что есть сейчас — для плана восстановления                           */
/* ------------------------------------------------------------------ */

export async function readCurrentSnapshot(
  db: AdminDb,
  branding: BrandingStore,
): Promise<CurrentSnapshot> {
  const domains = (await optional<{ name: string }>(db, `SELECT name FROM virtual_domains`)).map(
    (r) => r.name,
  );
  const mailboxes = (await optional<{ email: string }>(db, `SELECT email FROM virtual_users`)).map(
    (r) => r.email,
  );
  const aliases = (
    await optional<{ source: string; destination: string }>(
      db,
      `SELECT source, destination FROM virtual_aliases`,
    )
  ).map((r) => `${r.source} → ${r.destination}`);
  const admins = (await optional<{ login: string }>(db, `SELECT login FROM admin_users`)).map(
    (r) => r.login,
  );
  const ai = (
    await optional<{ domain: string }>(
      db,
      `SELECT d.name AS domain FROM ai_domain_settings a JOIN virtual_domains d ON d.id = a.domain_id`,
    )
  ).map((r) => r.domain);

  const counts = await optional<{ account_email: string; filters: string; signatures: string }>(
    db,
    `SELECT account_email,
            sum(filters) AS filters,
            sum(signatures) AS signatures
       FROM (
         SELECT lower(account_email) AS account_email, count(*) AS filters, 0 AS signatures
           FROM mail_filters GROUP BY 1
         UNION ALL
         SELECT lower(account_email) AS account_email, 0 AS filters, count(*) AS signatures
           FROM mail_signatures GROUP BY 1
       ) t
      GROUP BY account_email`,
  );
  const userSettings = new Map<string, { filters: number; signatures: number }>();
  for (const row of counts) {
    userSettings.set(row.account_email, {
      filters: Number(row.filters),
      signatures: Number(row.signatures),
    });
  }

  const state = await branding.read();
  return { domains, mailboxes, aliases, admins, ai, userSettings, brandingLogo: state.logo !== null };
}

/* ------------------------------------------------------------------ */
/* Восстановление                                                       */
/* ------------------------------------------------------------------ */

export interface RestoreOutcome {
  /** Сколько объектов создано и сколько перезаписано, по разделам. */
  applied: Record<string, { created: number; updated: number }>;
  /** Ящики, чей файл правил нужно пересобрать (делает вызывающий). */
  resyncSieve: string[];
  /**
   * Почему не применилось оформление; null — применилось или его не просили.
   *
   * Отказ здесь НЕ бросается наружу, и это принципиально. Оформление
   * применяется последним и вне транзакции, то есть к этому моменту пароли
   * ящиков и учётные записи администраторов уже записаны. Брошенное
   * исключение уводило маршрут мимо записи в журнал аудита — и
   * восстановление, сменившее пароль администратора, не оставляло следа
   * вообще. Логотип из копии не стоит потерянной записи аудита: о нём
   * сообщаем текстом, ровно как о непересобранных правилах Sieve.
   */
  brandingError: string | null;
}

/**
 * Применяет копию.
 *
 * Одной транзакцией: половина восстановленных настроек хуже, чем ни одной —
 * при обрыве получилось бы состояние, которого не было никогда, и понять,
 * что доехало, а что нет, было бы уже нельзя.
 *
 * НИЧЕГО НЕ УДАЛЯЕТ, кроме правил и подписей тех ящиков, которые есть в
 * копии: эти два списка — упорядоченные наборы без устойчивых ключей,
 * и «дополнить» их означало бы удвоить правила при каждом восстановлении.
 */
export async function applyRestore(
  db: AdminDb,
  branding: BrandingStore,
  file: SettingsBackupFile,
  sections: readonly BackupSection[],
): Promise<RestoreOutcome> {
  const want = new Set(sections);
  const applied: RestoreOutcome['applied'] = {};
  const resyncSieve: string[] = [];
  const note = (id: string, key: 'created' | 'updated'): void => {
    const row = (applied[id] ??= { created: 0, updated: 0 });
    row[key] += 1;
  };

  await db.transaction(async (client) => {
    /* --- домены --- */
    if (want.has('domains')) {
      for (const domain of file.data.domains) {
        const created = await upsertDomain(client, domain);
        note('domains', created ? 'created' : 'updated');
      }
    }

    /* --- ящики --- */
    if (want.has('mailboxes')) {
      for (const box of file.data.mailboxes) {
        const domainName = box.email.split('@')[1] ?? '';
        if (domainName === '') continue;
        // Домен под ящик заводим молча только потому, что план уже
        // предупредил об этом человека (см. buildRestorePlan).
        const domainId = await ensureDomain(client, domainName);
        const existing = await client.query<{ id: number }>(
          `SELECT id FROM virtual_users WHERE lower(email) = lower($1)`,
          [box.email],
        );
        if (existing.rows.length > 0) {
          await client.query(
            `UPDATE virtual_users
                SET domain_id = $2, password = $3, display_name = $4,
                    quota_bytes = $5, active = $6, updated_at = now()
              WHERE id = $1`,
            [
              existing.rows[0]?.id,
              domainId,
              box.passwordHash,
              box.displayName,
              box.quotaBytes,
              box.active,
            ],
          );
          note('mailboxes', 'updated');
        } else {
          await client.query(
            `INSERT INTO virtual_users (domain_id, email, password, display_name, quota_bytes, active)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [domainId, box.email, box.passwordHash, box.displayName, box.quotaBytes, box.active],
          );
          note('mailboxes', 'created');
        }
      }
    }

    /* --- алиасы --- */
    if (want.has('aliases')) {
      for (const alias of file.data.aliases) {
        const domainName = alias.source.split('@')[1] ?? '';
        if (domainName === '') continue;
        const domainId = await ensureDomain(client, domainName);
        const updated = await client.query(
          `UPDATE virtual_aliases SET active = $3, domain_id = $4
            WHERE lower(source) = lower($1) AND lower(destination) = lower($2)`,
          [alias.source, alias.destination, alias.active, domainId],
        );
        if ((updated.rowCount ?? 0) > 0) {
          note('aliases', 'updated');
        } else {
          await client.query(
            `INSERT INTO virtual_aliases (domain_id, source, destination, active)
             VALUES ($1, $2, $3, $4) ON CONFLICT (source, destination) DO NOTHING`,
            [domainId, alias.source, alias.destination, alias.active],
          );
          note('aliases', 'created');
        }
      }
    }

    /* --- администраторы --- */
    if (want.has('admins')) {
      for (const admin of file.data.admins) {
        const updated = await client.query(
          `UPDATE admin_users
              SET password_hash = $2, display_name = $3, role = $4, active = $5, updated_at = now()
            WHERE lower(login) = lower($1)`,
          [admin.login, admin.passwordHash, admin.displayName, admin.role, admin.active],
        );
        if ((updated.rowCount ?? 0) > 0) {
          note('admins', 'updated');
        } else {
          await client.query(
            `INSERT INTO admin_users (login, password_hash, display_name, role, active)
             VALUES ($1, $2, $3, $4, $5)`,
            [admin.login, admin.passwordHash, admin.displayName, admin.role, admin.active],
          );
          note('admins', 'created');
        }
      }
    }

    /* --- настройки, подписи и правила пользователей --- */
    if (want.has('userSettings')) {
      for (const entry of file.data.userSettings) {
        await restoreUserSettings(client, entry);
        note('userSettings', 'updated');
        resyncSieve.push(entry.accountEmail);
      }
    }

    /* --- помощник ИИ --- */
    if (want.has('ai')) {
      for (const item of file.data.ai) {
        const domain = await client.query<{ id: number }>(
          `SELECT id FROM virtual_domains WHERE lower(name) = lower($1)`,
          [item.domain],
        );
        const domainId = domain.rows[0]?.id;
        if (domainId === undefined) continue;
        // api_key_enc не трогаем ни при создании, ни при обновлении:
        // в копии его нет, а затирать действующий ключ пустотой — значит
        // выключить помощника у того, кто ключ уже ввёл.
        const updated = await client.query(
          `UPDATE ai_domain_settings
              SET enabled = $2, base_url = $3, chat_path = $4, model = $5,
                  provider_label = $6, is_local = $7, max_body_chars = $8,
                  timeout_ms = $9, max_output_tokens = $10
            WHERE domain_id = $1`,
          [
            domainId,
            item.enabled,
            item.baseUrl,
            item.chatPath,
            item.model,
            item.providerLabel,
            item.isLocal,
            item.maxBodyChars,
            item.timeoutMs,
            item.maxOutputTokens,
          ],
        );
        if ((updated.rowCount ?? 0) > 0) note('ai', 'updated');
        else {
          await client.query(
            `INSERT INTO ai_domain_settings
               (domain_id, enabled, base_url, chat_path, model, provider_label,
                is_local, max_body_chars, timeout_ms, max_output_tokens)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              domainId,
              item.enabled,
              item.baseUrl,
              item.chatPath,
              item.model,
              item.providerLabel,
              item.isLocal,
              item.maxBodyChars,
              item.timeoutMs,
              item.maxOutputTokens,
            ],
          );
          note('ai', 'created');
        }
      }
    }
  });

  /* --- оформление --- */
  // Вне транзакции: это файлы в томе, а не строки в базе. Порядок такой,
  // чтобы битый логотип из копии не откатывал уже применённые настройки.
  let brandingError: string | null = null;
  if (want.has('branding') && file.data.branding) {
    try {
      await branding.importSnapshot(file.data.branding);
      applied.branding = { created: 0, updated: 1 };
    } catch (err) {
      // См. пояснение у RestoreOutcome.brandingError: наружу не бросаем,
      // иначе теряется запись аудита об уже перезаписанных паролях.
      brandingError = err instanceof Error ? err.message : String(err);
    }
  }

  return { applied, resyncSieve, brandingError };
}

/** Домен по имени; заводит, если его нет. Возвращает id. */
async function ensureDomain(client: PoolClient, name: string): Promise<number> {
  const found = await client.query<{ id: number }>(
    `SELECT id FROM virtual_domains WHERE lower(name) = lower($1)`,
    [name],
  );
  const id = found.rows[0]?.id;
  if (id !== undefined) return id;
  const created = await client.query<{ id: number }>(
    `INSERT INTO virtual_domains (name) VALUES (lower($1)) RETURNING id`,
    [name],
  );
  const newId = created.rows[0]?.id;
  if (newId === undefined) throw new Error(`не удалось создать домен ${name}`);
  await client.query(
    `INSERT INTO domain_settings (domain_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [newId],
  );
  return newId;
}

/** Домен и его настройки подписи. true — домена не было. */
async function upsertDomain(client: PoolClient, domain: DomainEntry): Promise<boolean> {
  const before = await client.query<{ id: number }>(
    `SELECT id FROM virtual_domains WHERE lower(name) = lower($1)`,
    [domain.name],
  );
  const created = before.rows.length === 0;
  const id = await ensureDomain(client, domain.name);
  await client.query(
    `INSERT INTO domain_settings (domain_id, dkim_selector, dkim_public_key, dkim_dns_record, notes)
     VALUES ($1, COALESCE($2, 'mail'), $3, $4, $5)
     ON CONFLICT (domain_id) DO UPDATE
        SET dkim_selector = COALESCE(EXCLUDED.dkim_selector, 'mail'),
            dkim_public_key = EXCLUDED.dkim_public_key,
            dkim_dns_record = EXCLUDED.dkim_dns_record,
            notes = EXCLUDED.notes,
            updated_at = now()`,
    [id, domain.dkimSelector, domain.dkimPublicKey, domain.dkimDnsRecord, domain.notes],
  );
  return created;
}

/** Колонки mail_user_settings, которые восстанавливаем. Список явный: */
/* чужой файл не должен уметь вписать что попало в незнакомую колонку.  */
const USER_SETTINGS_COLUMNS = [
  'sender_name',
  'reply_quote',
  'after_delete',
  'notify_browser',
  'notify_tab',
  'collect_contacts',
  'autoreply_enabled',
  'autoreply_subject',
  'autoreply_text',
  'autoreply_from',
  'autoreply_until',
  'autoreply_days',
] as const;

async function restoreUserSettings(client: PoolClient, entry: UserSettingsEntry): Promise<void> {
  const email = entry.accountEmail;

  if (entry.settings) {
    const values = USER_SETTINGS_COLUMNS.map((col) => (entry.settings as Record<string, unknown>)[col] ?? null);
    const placeholders = USER_SETTINGS_COLUMNS.map((_, i) => `$${i + 2}`).join(', ');
    const updates = USER_SETTINGS_COLUMNS.map((col) => `${col} = EXCLUDED.${col}`).join(', ');
    await client.query(
      `INSERT INTO mail_user_settings (account_email, ${USER_SETTINGS_COLUMNS.join(', ')})
       VALUES ($1, ${placeholders})
       ON CONFLICT (account_email) DO UPDATE SET ${updates}, updated_at = now()`,
      [email, ...values],
    );
  }

  // Подписи и правила — упорядоченные наборы без устойчивых ключей.
  // Поэтому замена целиком, о чём план предупреждает отдельной строкой.
  await client.query(`DELETE FROM mail_signatures WHERE lower(account_email) = lower($1)`, [email]);
  for (const sig of entry.signatures) {
    await client.query(
      `INSERT INTO mail_signatures (account_email, name, body_html, is_default, position)
       VALUES ($1, $2, $3, $4, $5)`,
      [email, sig.name, sig.bodyHtml, sig.isDefault, sig.position],
    );
  }

  await client.query(`DELETE FROM mail_filters WHERE lower(account_email) = lower($1)`, [email]);
  for (const rule of entry.filters) {
    await client.query(
      `INSERT INTO mail_filters
         (account_email, name, position, enabled, is_auto, match_mode, conditions, actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
      [
        email,
        rule.name,
        rule.position,
        rule.enabled,
        rule.isAuto,
        rule.matchMode,
        JSON.stringify(rule.conditions ?? []),
        JSON.stringify(rule.actions ?? {}),
      ],
    );
  }
}
