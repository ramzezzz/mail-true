/**
 * Хранилище уведомлений: ключи сервера, подписки браузеров и настройки
 * подробности.
 *
 * Своё подключение к Postgres, как у настроек, админки и помощника ИИ:
 * почтовый API обязан работать и без базы — просто без уведомлений при
 * закрытой вкладке. Ни одна таблица почтового стека не изменяется.
 *
 * Главный выключатель «показывать уведомления» ЖИВЁТ НЕ ЗДЕСЬ, а в общих
 * настройках ящика (`mail_user_settings.notify_browser`) — он там был
 * раньше, чем появился этот раздел, и второй такой же выключатель означал
 * бы «включил в одном месте, а работает по другому». Здесь только
 * подробности; сведением того и другого занимается service.ts.
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import { generateVapidKeys, vapidKeysValid, type VapidKeys } from './crypto.js';
import {
  defaultNotificationPrefs,
  isNotificationLevel,
  type NotificationPrefs,
  type PushSubscriptionRecord,
} from './types.js';

export interface PushDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

/** Отсутствующая таблица (42P01) — миграция 0012 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

interface PrefsRow extends QueryResultRow {
  account_email: string;
  level: string;
  push_enabled: boolean;
  push_payload: boolean;
  skip_filtered: boolean;
  quiet_enabled: boolean;
  quiet_from: number;
  quiet_to: number;
  time_zone: string | null;
  updated_at: Date;
}

interface SubscriptionRow extends QueryResultRow {
  id: string;
  account_email: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  client_id: string;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date;
  last_error_at: Date | null;
  last_error: string | null;
}

/** Минуты от полуночи из базы: чужое значение не доверяем даже своему CHECK. */
function minutes(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 1440 ? n : fallback;
}

function toPrefs(row: PrefsRow): NotificationPrefs {
  const defaults = defaultNotificationPrefs();
  return {
    // Главный выключатель приходит из общих настроек — сюда его
    // подставляет service.ts. По умолчанию считаем «выключено»: молчание
    // безопаснее, чем уведомления, которых не просили.
    enabled: false,
    // Неизвестный уровень (правка в обход API, откат версии) приводим
    // к безопасному, а не разваливаем на нём весь раздел.
    level: isNotificationLevel(row.level) ? row.level : defaults.level,
    push: row.push_enabled,
    pushPayload: row.push_payload,
    skipFiltered: row.skip_filtered,
    quietHours: {
      enabled: row.quiet_enabled,
      fromMinutes: minutes(row.quiet_from, defaults.quietHours.fromMinutes),
      toMinutes: minutes(row.quiet_to, defaults.quietHours.toMinutes),
    },
    timeZone: row.time_zone,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSubscription(row: SubscriptionRow): PushSubscriptionRecord {
  return {
    id: Number(row.id),
    accountEmail: row.account_email,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    clientId: row.client_id,
    userAgent: row.user_agent,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    lastErrorAt: row.last_error_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

/** Заплатка настроек: передаются только изменяемые поля. */
export interface NotificationPrefsPatch {
  level?: NotificationPrefs['level'] | undefined;
  push?: boolean | undefined;
  pushPayload?: boolean | undefined;
  skipFiltered?: boolean | undefined;
  quietEnabled?: boolean | undefined;
  quietFrom?: number | undefined;
  quietTo?: number | undefined;
  timeZone?: string | null | undefined;
}

export class PushDb {
  readonly #pool: Pool;
  readonly #logger: Logger;

  constructor(opts: PushDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#logger = opts.logger;
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (уведомления)'),
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(text, values);
    return result.rows;
  }

  /** Применена ли миграция 0012. */
  async schemaReady(): Promise<boolean> {
    const rows = await this.#query<{ ok: boolean }>(
      `SELECT to_regclass('public.push_subscriptions') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  /* ---------------------------------------------------------------- */
  /* Ключи VAPID                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Ключи сервера: читает существующие, а при их отсутствии создаёт пару
   * и записывает.
   *
   * `ON CONFLICT DO NOTHING` с последующим чтением, а не «проверить и
   * вставить»: два процесса сервера, стартующих одновременно, иначе
   * записали бы РАЗНЫЕ пары, и половина подписок оказалась бы выдана под
   * ключ, которого больше нет. Проверить это на глаз нельзя — оно
   * проявляется только под нагрузкой при перезапуске.
   */
  async ensureVapidKeys(): Promise<VapidKeys> {
    const existing = await this.#readVapidKeys();
    if (existing) return existing;

    const created = generateVapidKeys();
    await this.#query(
      `INSERT INTO push_vapid_keys (id, public_key, private_key) VALUES (1, $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [created.publicKey, created.privateKey],
    );
    const stored = await this.#readVapidKeys();
    if (!stored) throw new Error('Не удалось сохранить ключи VAPID');
    return stored;
  }

  async #readVapidKeys(): Promise<VapidKeys | null> {
    const rows = await this.#query<{ public_key: string; private_key: string }>(
      `SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const keys = { publicKey: row.public_key, privateKey: row.private_key };
    if (!vapidKeysValid(keys)) {
      // Испорченная пара хуже отсутствующей: подписки будут выдаваться,
      // а уведомления молча не доходить. Говорим вслух и работаем без push.
      this.#logger.error(
        'Ключи VAPID в базе не сходятся между собой. Уведомления при закрытой вкладке ' +
          'работать не будут. Удалите строку из push_vapid_keys — сервер создаст новую пару ' +
          '(все выданные подписки при этом придётся оформить заново).',
      );
      return null;
    }
    return keys;
  }

  /* ---------------------------------------------------------------- */
  /* Подписки                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Сохраняет подписку браузера.
   *
   * Ключ согласования — адрес службы доставки: браузер выдаёт на подписку
   * ровно один адрес, и повторный вызов должен ОБНОВИТЬ строку, а не
   * добавить вторую. Иначе на одно письмо уходило бы N одинаковых
   * уведомлений — по числу перезагрузок страницы.
   *
   * Ящик тоже обновляется: за одним браузером может войти другой человек,
   * и уведомления обязаны уйти вслед за ним, а не остаться у прежнего.
   */
  async saveSubscription(input: {
    accountEmail: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    clientId: string;
    userAgent: string | null;
  }): Promise<PushSubscriptionRecord> {
    const rows = await this.#query<SubscriptionRow>(
      `INSERT INTO push_subscriptions
         (account_email, endpoint, p256dh, auth, client_id, user_agent)
       VALUES (lower($1), $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET
         account_email = EXCLUDED.account_email,
         p256dh        = EXCLUDED.p256dh,
         auth          = EXCLUDED.auth,
         client_id     = EXCLUDED.client_id,
         user_agent    = EXCLUDED.user_agent,
         last_seen_at  = now(),
         last_error_at = NULL,
         last_error    = NULL
       RETURNING *`,
      [
        input.accountEmail,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.clientId,
        input.userAgent,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось сохранить подписку на уведомления');
    return toSubscription(row);
  }

  async listSubscriptions(accountEmail: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.#query<SubscriptionRow>(
      `SELECT * FROM push_subscriptions WHERE lower(account_email) = lower($1)
        ORDER BY created_at`,
      [accountEmail],
    );
    return rows.map(toSubscription);
  }

  /**
   * Удаляет подписку. Ящик в условии обязателен: адрес службы доставки
   * приходит из запроса, и без него один вошедший мог бы отписать другого.
   */
  async deleteSubscription(accountEmail: string, endpoint: string): Promise<boolean> {
    const rows = await this.#query<{ id: string }>(
      `DELETE FROM push_subscriptions
        WHERE endpoint = $1 AND lower(account_email) = lower($2) RETURNING id`,
      [endpoint, accountEmail],
    );
    return rows.length > 0;
  }

  /**
   * Удаляет подписку, от которой отказалась сама служба доставки
   * (404/410). Ящик здесь не проверяется намеренно: отказ пришёл не от
   * пользователя, а от службы, и означает он «этой подписки больше нет
   * ни у кого».
   */
  async forgetEndpoint(endpoint: string): Promise<void> {
    await this.#query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
  }

  /** Запоминает отказ, не удаляя подписку: временная ошибка — не приговор. */
  async recordFailure(endpoint: string, error: string): Promise<void> {
    await this.#query(
      `UPDATE push_subscriptions SET last_error_at = now(), last_error = $2 WHERE endpoint = $1`,
      [endpoint, error.slice(0, 500)],
    );
  }

  async touchSubscription(endpoint: string): Promise<void> {
    await this.#query(
      `UPDATE push_subscriptions SET last_seen_at = now(), last_error_at = NULL, last_error = NULL
        WHERE endpoint = $1`,
      [endpoint],
    );
  }

  /* ---------------------------------------------------------------- */
  /* Настройки подробности                                              */
  /* ---------------------------------------------------------------- */

  /** Настройки ящика. Строки нет — значения по умолчанию. */
  async getPrefs(accountEmail: string): Promise<NotificationPrefs> {
    const rows = await this.#query<PrefsRow>(
      `SELECT * FROM mail_notification_prefs WHERE lower(account_email) = lower($1)`,
      [accountEmail],
    );
    const row = rows[0];
    return row ? toPrefs(row) : defaultNotificationPrefs();
  }

  /** Сохраняет только переданные поля: смена уровня не трогает тихие часы. */
  async savePrefs(accountEmail: string, patch: NotificationPrefsPatch): Promise<NotificationPrefs> {
    await this.#query(
      `INSERT INTO mail_notification_prefs (account_email) VALUES (lower($1))
       ON CONFLICT (account_email) DO NOTHING`,
      [accountEmail],
    );

    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}`);
    };
    if (patch.level !== undefined) put('level', patch.level);
    if (patch.push !== undefined) put('push_enabled', patch.push);
    if (patch.pushPayload !== undefined) put('push_payload', patch.pushPayload);
    if (patch.skipFiltered !== undefined) put('skip_filtered', patch.skipFiltered);
    if (patch.quietEnabled !== undefined) put('quiet_enabled', patch.quietEnabled);
    if (patch.quietFrom !== undefined) put('quiet_from', patch.quietFrom);
    if (patch.quietTo !== undefined) put('quiet_to', patch.quietTo);
    if (patch.timeZone !== undefined) put('time_zone', patch.timeZone);

    if (sets.length > 0) {
      values.push(accountEmail);
      await this.#query(
        `UPDATE mail_notification_prefs SET ${sets.join(', ')}, updated_at = now()
          WHERE lower(account_email) = lower($${String(values.length)})`,
        values,
      );
    }
    return this.getPrefs(accountEmail);
  }
}
