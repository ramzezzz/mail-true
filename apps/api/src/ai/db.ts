/**
 * Доступ к базе для помощника на основе ИИ.
 *
 * Своё подключение к Postgres, как и у админки: почтовый API должен
 * работать и без базы — просто без ИИ. Ни одна таблица почтового стека
 * (virtual_domains / virtual_users / virtual_aliases) не изменяется.
 *
 * Ключ доступа наружу отсюда не отдаётся в открытом виде: расшифровка
 * происходит в service.ts ровно в момент сборки помощника.
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type {
  AiAuditEntry,
  AiAuditFilter,
  AiAuditLog,
  AiAuditTotals,
  AiFeature,
} from '@mail-true/ai';
import { parseFeatureList, type AiUserFeature } from './features.js';

export interface AiDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

/* ------------------------------------------------------------------ */
/* Строки таблиц                                                        */
/* ------------------------------------------------------------------ */

export interface AiDomainSettingsRow {
  domain_id: number;
  domain: string;
  enabled: boolean;
  base_url: string | null;
  chat_path: string;
  api_key_enc: string | null;
  api_key_hint: string | null;
  model: string | null;
  provider_label: string;
  is_local: boolean;
  max_body_chars: number;
  timeout_ms: number;
  max_output_tokens: number;
  period_ms: number;
  /** BIGINT приходит из pg строкой — приводим вручную, чтобы не потерять точность молча. */
  max_tokens_per_period: string | null;
  max_requests_per_period: number | null;
  max_tokens_per_request: number | null;
  features_allowed: unknown;
  updated_at: Date;
}

export interface AiUserSettingsRow {
  account_email: string;
  consent_at: Date | null;
  consent_endpoint: string | null;
  consent_model: string | null;
  features: unknown;
  updated_at: Date;
}

/** Настройки домена в удобном для кода виде. */
export interface AiDomainSettings {
  domainId: number;
  domain: string;
  enabled: boolean;
  baseUrl: string | null;
  chatPath: string;
  apiKeyEnc: string | null;
  apiKeyHint: string | null;
  model: string | null;
  providerLabel: string;
  local: boolean;
  maxBodyChars: number;
  timeoutMs: number;
  maxOutputTokens: number;
  periodMs: number;
  maxTokensPerPeriod: number | null;
  maxRequestsPerPeriod: number | null;
  maxTokensPerRequest: number | null;
  /** null — разрешены все возможности. */
  featuresAllowed: AiUserFeature[] | null;
  updatedAt: string;
}

/** Настройки пользователя. Строки нет — значит согласия нет. */
export interface AiUserSettings {
  accountEmail: string;
  consentAt: string | null;
  consentEndpoint: string | null;
  consentModel: string | null;
  /** null — набор по умолчанию. */
  features: AiUserFeature[] | null;
}

/** Заплатка настроек домена: передаются только изменяемые поля. */
export interface AiDomainSettingsPatch {
  enabled?: boolean;
  baseUrl?: string | null;
  chatPath?: string;
  /** undefined — не трогать; null — стереть ключ; строка — новый шифротекст. */
  apiKeyEnc?: string | null;
  apiKeyHint?: string | null;
  model?: string | null;
  providerLabel?: string;
  local?: boolean;
  maxBodyChars?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  periodMs?: number;
  maxTokensPerPeriod?: number | null;
  maxRequestsPerPeriod?: number | null;
  maxTokensPerRequest?: number | null;
  featuresAllowed?: AiUserFeature[] | null;
}

function toDomainSettings(row: AiDomainSettingsRow): AiDomainSettings {
  return {
    domainId: row.domain_id,
    domain: row.domain,
    enabled: row.enabled,
    baseUrl: row.base_url,
    chatPath: row.chat_path,
    apiKeyEnc: row.api_key_enc,
    apiKeyHint: row.api_key_hint,
    model: row.model,
    providerLabel: row.provider_label,
    local: row.is_local,
    maxBodyChars: row.max_body_chars,
    timeoutMs: row.timeout_ms,
    maxOutputTokens: row.max_output_tokens,
    periodMs: row.period_ms,
    maxTokensPerPeriod:
      row.max_tokens_per_period === null ? null : Number(row.max_tokens_per_period),
    maxRequestsPerPeriod: row.max_requests_per_period,
    maxTokensPerRequest: row.max_tokens_per_request,
    featuresAllowed: parseFeatureList(row.features_allowed),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toUserSettings(row: AiUserSettingsRow): AiUserSettings {
  return {
    accountEmail: row.account_email,
    consentAt: row.consent_at?.toISOString() ?? null,
    consentEndpoint: row.consent_endpoint,
    consentModel: row.consent_model,
    features: parseFeatureList(row.features),
  };
}

/** Отсутствующая таблица (42P01) — миграция 0004 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/**
 * Хранилище настроек — ровно то, что нужно сервису и админским маршрутам.
 *
 * Интерфейс, а не класс: благодаря этому разграничение настроек по уровням
 * и поведение при отзыве согласия проверяются юнит-тестами без Postgres.
 * Проверять такие вещи только на живой базе — значит не проверять их вовсе.
 */
export interface AiSettingsStore {
  findDomainSettingsByEmail(email: string): Promise<AiDomainSettings | null>;
  findDomainSettingsById(domainId: number): Promise<AiDomainSettings | null>;
  listDomainSettings(): Promise<AiDomainSettings[]>;
  saveDomainSettings(
    domainId: number,
    patch: AiDomainSettingsPatch,
  ): Promise<AiDomainSettings | null>;
  findUserSettings(email: string): Promise<AiUserSettings | null>;
  grantConsent(
    email: string,
    endpoint: string,
    model: string,
    features: AiUserFeature[],
  ): Promise<AiUserSettings | null>;
  revokeConsent(email: string): Promise<void>;
  saveUserFeatures(email: string, features: AiUserFeature[]): Promise<AiUserSettings | null>;
}

/**
 * Клиент Redis в объёме, нужном помощнику: кэш результатов и учёт расходов.
 * Объявлен интерфейсом по той же причине — чтобы тесты обходились
 * поддельным хранилищем в памяти.
 */
export interface AiRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Столбцы настроек домена — с значениями по умолчанию прямо в запросе.
 *
 * Читаем ВСЕГДА от virtual_domains, а строка ai_domain_settings
 * необязательна. Так было не всегда: раньше запросы начинались с
 * ai_domain_settings и соединялись с доменами, а список ещё и фильтровал
 * по `s.domain_id IS NOT NULL`. Строку же создавала только миграция 0004
 * — для доменов, существовавших на момент её применения. Домен, добавленный
 * позже, в список настроек ИИ не попадал вовсе, а правка отвечала
 * «настройки не найдены»: сохранение (единственное место, где строка
 * создаётся) было недостижимо. Помощника нельзя было настроить ни для
 * одного нового домена — навсегда.
 *
 * Значения по умолчанию совпадают с DEFAULT из миграции 0004: домен без
 * строки настроек выглядит как «помощник выключен», а не как «домена нет».
 */
const DOMAIN_COLUMNS = `d.id AS domain_id, d.name AS domain,
         coalesce(s.enabled, FALSE) AS enabled,
         s.base_url,
         coalesce(s.chat_path, '/chat/completions') AS chat_path,
         s.api_key_enc, s.api_key_hint, s.model,
         coalesce(s.provider_label, 'Сервис ИИ') AS provider_label,
         coalesce(s.is_local, FALSE) AS is_local,
         coalesce(s.max_body_chars, 8000) AS max_body_chars,
         coalesce(s.timeout_ms, 30000) AS timeout_ms,
         coalesce(s.max_output_tokens, 1024) AS max_output_tokens,
         coalesce(s.period_ms, 86400000) AS period_ms,
         s.max_tokens_per_period::text AS max_tokens_per_period,
         s.max_requests_per_period, s.max_tokens_per_request,
         s.features_allowed,
         coalesce(s.updated_at, d.created_at) AS updated_at`;

const DOMAIN_FROM = `FROM virtual_domains d
         LEFT JOIN ai_domain_settings s ON s.domain_id = d.id`;

export class AiDb implements AiSettingsStore {
  readonly #pool: Pool;

  constructor(opts: AiDbOptions) {
    // Своего поля под logger здесь нет намеренно: журналом этого класса
    // занимается один обработчик отказов пула (ниже), а хранить ссылку
    // «на всякий случай» — значит через полгода не понять, пользуется ею
    // кто-нибудь или нет.
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Только суть ошибки: объект pg тянет за собой состояние соединения
    this.#pool.on('error', (err) => opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (ИИ)'));
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

  /** Применена ли миграция 0004. */
  async schemaReady(): Promise<boolean> {
    const row = await this.one<{ ok: boolean }>(
      `SELECT to_regclass('public.ai_domain_settings') IS NOT NULL AS ok`,
    );
    return row?.ok === true;
  }

  /* ---------------------------------------------------------------- */
  /* Уровень «администратор»                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Настройки домена по адресу ящика.
   * Строки нет — значит домена нет или миграция не применена; в обоих
   * случаях ответ null означает «ИИ выключен», а не аварию.
   */
  async findDomainSettingsByEmail(email: string): Promise<AiDomainSettings | null> {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (domain.length === 0) return null;
    const row = await this.one<AiDomainSettingsRow>(
      `SELECT ${DOMAIN_COLUMNS} ${DOMAIN_FROM}
        WHERE lower(d.name) = $1`,
      [domain],
    );
    return row ? toDomainSettings(row) : null;
  }

  async findDomainSettingsById(domainId: number): Promise<AiDomainSettings | null> {
    const row = await this.one<AiDomainSettingsRow>(
      `SELECT ${DOMAIN_COLUMNS} ${DOMAIN_FROM}
        WHERE d.id = $1`,
      [domainId],
    );
    return row ? toDomainSettings(row) : null;
  }

  /** Все домены сервера, а не только те, у кого уже есть строка настроек. */
  async listDomainSettings(): Promise<AiDomainSettings[]> {
    const rows = await this.query<AiDomainSettingsRow>(
      `SELECT ${DOMAIN_COLUMNS} ${DOMAIN_FROM}
        ORDER BY d.name`,
    );
    return rows.map(toDomainSettings);
  }

  /** Создаёт строку настроек для домена, если её ещё нет (всё выключено). */
  async ensureDomainSettings(domainId: number): Promise<void> {
    await this.query(
      `INSERT INTO ai_domain_settings (domain_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [domainId],
    );
  }

  /**
   * Сохраняет настройки домена. Неупомянутые поля не трогаются:
   * администратор, меняющий предел расходов, не должен случайно
   * стереть ключ доступа.
   */
  async saveDomainSettings(
    domainId: number,
    patch: AiDomainSettingsPatch,
  ): Promise<AiDomainSettings | null> {
    await this.ensureDomainSettings(domainId);

    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown, cast = ''): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}${cast}`);
    };

    if (patch.enabled !== undefined) put('enabled', patch.enabled);
    if (patch.baseUrl !== undefined) put('base_url', patch.baseUrl);
    if (patch.chatPath !== undefined) put('chat_path', patch.chatPath);
    if (patch.apiKeyEnc !== undefined) put('api_key_enc', patch.apiKeyEnc);
    if (patch.apiKeyHint !== undefined) put('api_key_hint', patch.apiKeyHint);
    if (patch.model !== undefined) put('model', patch.model);
    if (patch.providerLabel !== undefined) put('provider_label', patch.providerLabel);
    if (patch.local !== undefined) put('is_local', patch.local);
    if (patch.maxBodyChars !== undefined) put('max_body_chars', patch.maxBodyChars);
    if (patch.timeoutMs !== undefined) put('timeout_ms', patch.timeoutMs);
    if (patch.maxOutputTokens !== undefined) put('max_output_tokens', patch.maxOutputTokens);
    if (patch.periodMs !== undefined) put('period_ms', patch.periodMs);
    if (patch.maxTokensPerPeriod !== undefined)
      put('max_tokens_per_period', patch.maxTokensPerPeriod);
    if (patch.maxRequestsPerPeriod !== undefined)
      put('max_requests_per_period', patch.maxRequestsPerPeriod);
    if (patch.maxTokensPerRequest !== undefined)
      put('max_tokens_per_request', patch.maxTokensPerRequest);
    if (patch.featuresAllowed !== undefined) {
      put(
        'features_allowed',
        patch.featuresAllowed === null ? null : JSON.stringify(patch.featuresAllowed),
        '::jsonb',
      );
    }

    if (sets.length > 0) {
      values.push(domainId);
      await this.query(
        `UPDATE ai_domain_settings SET ${sets.join(', ')}, updated_at = now()
          WHERE domain_id = $${String(values.length)}`,
        values,
      );
    }
    return this.findDomainSettingsById(domainId);
  }

  /* ---------------------------------------------------------------- */
  /* Уровень «пользователь»                                             */
  /* ---------------------------------------------------------------- */

  async findUserSettings(email: string): Promise<AiUserSettings | null> {
    const row = await this.one<AiUserSettingsRow>(
      `SELECT account_email, consent_at, consent_endpoint, consent_model, features, updated_at
         FROM ai_user_settings WHERE lower(account_email) = lower($1)`,
      [email],
    );
    return row ? toUserSettings(row) : null;
  }

  /**
   * Записывает согласие вместе с тем, НА ЧТО пользователь соглашался:
   * адрес сервиса и модель на момент нажатия. Смена сервиса
   * администратором обесценивает согласие — спросим заново.
   */
  async grantConsent(
    email: string,
    endpoint: string,
    model: string,
    features: AiUserFeature[],
  ): Promise<AiUserSettings | null> {
    await this.query(
      `INSERT INTO ai_user_settings
         (account_email, consent_at, consent_endpoint, consent_model, features)
       VALUES (lower($1), now(), $2, $3, $4::jsonb)
       ON CONFLICT (account_email) DO UPDATE
          SET consent_at = now(),
              consent_endpoint = EXCLUDED.consent_endpoint,
              consent_model = EXCLUDED.consent_model,
              features = EXCLUDED.features,
              updated_at = now()`,
      [email, endpoint, model, JSON.stringify(features)],
    );
    return this.findUserSettings(email);
  }

  /**
   * Отзывает согласие: строка настроек удаляется целиком.
   * Удаление созданных резюме и меток делает service.ts — они лежат
   * не здесь, а в кэше.
   */
  async revokeConsent(email: string): Promise<void> {
    await this.query(`DELETE FROM ai_user_settings WHERE lower(account_email) = lower($1)`, [
      email,
    ]);
  }

  async saveUserFeatures(email: string, features: AiUserFeature[]): Promise<AiUserSettings | null> {
    await this.query(
      `UPDATE ai_user_settings SET features = $2::jsonb, updated_at = now()
        WHERE lower(account_email) = lower($1)`,
      [email, JSON.stringify(features)],
    );
    return this.findUserSettings(email);
  }
}

/* ------------------------------------------------------------------ */
/* Журнал обращений                                                     */
/* ------------------------------------------------------------------ */

interface AuditRow extends QueryResultRow {
  at: Date;
  account_id: string;
  message_id: string | null;
  feature: string;
  prompt_version: string;
  endpoint: string;
  model: string;
  is_local: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated: boolean;
  cached: boolean;
  outbound_chars: number;
  duration_ms: number;
  ok: boolean;
  error_kind: string | null;
}

function toEntry(row: AuditRow): AiAuditEntry {
  return {
    at: row.at.toISOString(),
    accountId: row.account_id,
    messageId: row.message_id,
    feature: row.feature as AiFeature,
    promptVersion: row.prompt_version,
    endpoint: row.endpoint,
    model: row.model,
    local: row.is_local,
    usage: {
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      estimated: row.estimated,
    },
    cached: row.cached,
    outboundChars: row.outbound_chars,
    durationMs: row.duration_ms,
    ok: row.ok,
    errorKind: row.error_kind as AiAuditEntry['errorKind'],
  };
}

/**
 * Журнал обращений в Postgres.
 *
 * Ошибка записи не ломает основной путь: пользователь получит резюме
 * даже если журнал недоступен, но в лог сервера попадёт предупреждение —
 * молчаливая потеря записей о том, что ушло наружу, недопустима.
 */
export class PgAiAuditLog implements AiAuditLog {
  readonly #db: AiDb;
  readonly #logger: Logger;

  constructor(db: AiDb, logger: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  async record(entry: AiAuditEntry): Promise<void> {
    try {
      await this.#db.query(
        `INSERT INTO ai_audit_log
           (at, account_id, message_id, feature, prompt_version, endpoint, model, is_local,
            prompt_tokens, completion_tokens, total_tokens, estimated,
            cached, outbound_chars, duration_ms, ok, error_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          entry.at,
          entry.accountId,
          entry.messageId,
          entry.feature,
          entry.promptVersion,
          entry.endpoint,
          entry.model,
          entry.local,
          entry.usage.promptTokens,
          entry.usage.completionTokens,
          entry.usage.totalTokens,
          entry.usage.estimated,
          entry.cached,
          entry.outboundChars,
          Math.round(entry.durationMs),
          entry.ok,
          entry.errorKind,
        ],
      );
    } catch (err) {
      this.#logger.warn(errorInfo(err, { feature: entry.feature }), 'Не удалось записать журнал ИИ');
    }
  }

  async list(filter?: AiAuditFilter): Promise<AiAuditEntry[]> {
    const { where, values } = buildAuditWhere(filter);
    values.push(Math.min(filter?.limit ?? 200, 1000));
    try {
      const rows = await this.#db.query<AuditRow>(
        `SELECT at, account_id, message_id, feature, prompt_version, endpoint, model, is_local,
                prompt_tokens, completion_tokens, total_tokens, estimated,
                cached, outbound_chars, duration_ms, ok, error_kind
           FROM ai_audit_log ${where}
          ORDER BY at DESC, id DESC
          LIMIT $${String(values.length)}`,
        values,
      );
      return rows.map(toEntry);
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Не удалось прочитать журнал ИИ');
      return [];
    }
  }

  async totals(filter?: AiAuditFilter): Promise<AiAuditTotals> {
    const { where, values } = buildAuditWhere(filter);
    const empty: AiAuditTotals = {
      requests: 0,
      cachedRequests: 0,
      failedRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      outboundChars: 0,
    };
    try {
      const row = await this.#db.one<Record<string, string>>(
        `SELECT count(*)::text AS requests,
                count(*) FILTER (WHERE cached)::text AS cached_requests,
                count(*) FILTER (WHERE NOT ok)::text AS failed_requests,
                coalesce(sum(prompt_tokens),0)::text AS prompt_tokens,
                coalesce(sum(completion_tokens),0)::text AS completion_tokens,
                coalesce(sum(total_tokens),0)::text AS total_tokens,
                coalesce(sum(outbound_chars),0)::text AS outbound_chars
           FROM ai_audit_log ${where}`,
        values,
      );
      if (!row) return empty;
      const num = (key: string): number => Number(row[key] ?? 0);
      return {
        requests: num('requests'),
        cachedRequests: num('cached_requests'),
        failedRequests: num('failed_requests'),
        promptTokens: num('prompt_tokens'),
        completionTokens: num('completion_tokens'),
        totalTokens: num('total_tokens'),
        outboundChars: num('outbound_chars'),
      };
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Не удалось посчитать итоги журнала ИИ');
      return empty;
    }
  }
}

function buildAuditWhere(filter?: AiAuditFilter): { where: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  if (filter?.accountId !== undefined) {
    values.push(filter.accountId.toLowerCase());
    parts.push(`lower(account_id) = $${String(values.length)}`);
  }
  if (filter?.messageId !== undefined) {
    values.push(filter.messageId);
    parts.push(`message_id = $${String(values.length)}`);
  }
  if (filter?.feature !== undefined) {
    values.push(filter.feature);
    parts.push(`feature = $${String(values.length)}`);
  }
  if (filter?.since !== undefined) {
    values.push(filter.since);
    parts.push(`at >= $${String(values.length)}`);
  }
  return { where: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', values };
}
