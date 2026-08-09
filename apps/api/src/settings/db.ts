/**
 * Доступ к базе для настроек ящика, подписей и правил фильтрации.
 *
 * Своё подключение к Postgres, как у админки и помощника ИИ: почтовый API
 * должен работать и без базы — просто без настроек. Ни одна таблица
 * почтового стека (virtual_domains / virtual_users / virtual_aliases)
 * не изменяется.
 *
 * База — источник истины для правил. Файл Sieve в ящике пользователя —
 * производное представление: он переписывается целиком при каждом
 * изменении (см. service.ts).
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { normalizeThemeSetting, normalizeWallpaperChoice } from '@mail-true/shared';
import { errorInfo } from '../log.js';
import { normalizeUndoSeconds } from '../mail/deferred-send.js';
import { isUserLabelKey } from '../mail/labels.js';
import {
  DEFAULT_ACTIONS,
  defaultMailSettings,
  type AfterDelete,
  type FilterActions,
  type FilterCondition,
  type FilterField,
  type FilterOperator,
  type FilterRule,
  type FilterRuleInput,
  type MailSettings,
  type MailSettingsPatch,
  type Signature,
} from './types.js';

export interface SettingsDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

/* ------------------------------------------------------------------ */
/* Строки таблиц                                                        */
/* ------------------------------------------------------------------ */

interface SettingsRow extends QueryResultRow {
  account_email: string;
  sender_name: string | null;
  /**
   * Колонки оформления добавлены миграцией 0009 и объявлены необязательными
   * нарочно: пока её не применили, `SELECT *` вернёт строку без них, и
   * настройки должны продолжать работать (без запомненной темы), а не
   * разваливаться на undefined. Нормализация ниже приводит это к умолчанию.
   */
  theme?: string | null;
  wallpaper?: string | null;
  reply_quote: boolean;
  after_delete: string;
  notify_browser: boolean;
  notify_tab: boolean;
  collect_contacts: boolean;
  /**
   * Добавлена миграцией 0010 и объявлена необязательной по той же причине,
   * что и колонки оформления выше: пока миграцию не применили, `SELECT *`
   * вернёт строку без неё, и настройки обязаны работать дальше — просто
   * без логотипов, то есть ровно как до появления возможности.
   */
  sender_logos?: boolean | null;
  /**
   * Добавлена миграцией 0016 и тоже необязательная. Отсутствие колонки
   * (миграцию не применили) означает НОЛЬ, а не пять: пока настройки нельзя
   * ни прочитать, ни сохранить, задерживать чужие письма мы не вправе —
   * почта обязана вести себя ровно как до появления возможности.
   */
  undo_send_seconds?: number | null;
  /**
   * Добавлена миграцией 0019 и тоже необязательная. Отсутствие колонки
   * (миграцию не применили) означает ВКЛЮЧЕНО — то же, что и в самой
   * миграции: список должен выглядеть одинаково до и после её применения,
   * иначе одно только обновление базы молча переставляло бы человеку
   * привычный вид почты.
   */
  threaded_list?: boolean | null;
  autoreply_enabled: boolean;
  autoreply_subject: string | null;
  autoreply_text: string;
  autoreply_from: Date | null;
  autoreply_until: Date | null;
  autoreply_days: number;
  updated_at: Date;
}

interface SignatureRow extends QueryResultRow {
  id: string;
  name: string;
  body_html: string;
  is_default: boolean;
  position: number;
}

interface FilterRow extends QueryResultRow {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  is_auto: boolean;
  match_mode: string;
  conditions: unknown;
  actions: unknown;
}

/* ------------------------------------------------------------------ */
/* Разбор JSONB                                                         */
/* ------------------------------------------------------------------ */

const FIELDS: FilterField[] = [
  'from',
  'to',
  'subject',
  'cc',
  'resent-from',
  'resent-to',
  'size',
  'body',
  'attachment',
];
const OPERATORS: FilterOperator[] = [
  'contains',
  'not-contains',
  'is',
  'not-is',
  'matches',
  'not-matches',
  'greater',
  'less',
  'has',
  'has-not',
];

/**
 * Условия из JSONB. Мусор молча отбрасывается: в базу он может попасть
 * только правкой в обход API, и разваливать из-за него весь список
 * правил (а значит и файл Sieve) — хуже, чем потерять одно условие.
 */
export function parseConditions(raw: unknown): FilterCondition[] {
  if (!Array.isArray(raw)) return [];
  const out: FilterCondition[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const field = rec['field'];
    const op = rec['op'];
    const value = rec['value'];
    if (typeof field !== 'string' || !FIELDS.includes(field as FilterField)) continue;
    if (typeof op !== 'string' || !OPERATORS.includes(op as FilterOperator)) continue;
    out.push({
      field: field as FilterField,
      op: op as FilterOperator,
      // Только строка и число: значение условия приезжает из JSON в базе,
      // и объект в String() дал бы условие «поле содержит [object Object]» —
      // правило, которое не сработает никогда и объяснить это не сможет.
      value: typeof value === 'string' || typeof value === 'number' ? String(value) : '',
    });
  }
  return out;
}

/**
 * Действия из JSONB с подстановкой значений по умолчанию.
 *
 * Правила, записанные до появления меток и удаления, лежат в базе без этих
 * полей — и обязаны читаться как раньше. Отсюда `DEFAULT_ACTIONS` в основе:
 * отсутствующее поле означает «действия нет», а не «поле сломано».
 */
export function parseActions(raw: unknown): FilterActions {
  const base: FilterActions = { ...DEFAULT_ACTIONS, forwardTo: [], labels: [] };
  if (!raw || typeof raw !== 'object') return base;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['folder'] === 'string' && rec['folder'] !== '') base.folder = rec['folder'];
  if (typeof rec['markRead'] === 'boolean') base.markRead = rec['markRead'];
  if (typeof rec['flag'] === 'boolean') base.flag = rec['flag'];
  if (Array.isArray(rec['labels'])) {
    // Проверка ключа — здесь, а не только в маршруте: в базу правило может
    // попасть и мимо API, а из базы собирается файл Sieve, где `addflag`
    // примет любое слово, включая `\Deleted`. См. mail/labels.ts.
    base.labels = rec['labels'].filter(
      (k): k is string => typeof k === 'string' && isUserLabelKey(k),
    );
  }
  if (rec['deleteMessage'] === 'trash' || rec['deleteMessage'] === 'purge') {
    base.deleteMessage = rec['deleteMessage'];
  }
  if (Array.isArray(rec['forwardTo'])) {
    base.forwardTo = rec['forwardTo'].filter((a): a is string => typeof a === 'string');
  }
  const ar = rec['autoReply'];
  if (ar && typeof ar === 'object') {
    const arRec = ar as Record<string, unknown>;
    const text = typeof arRec['text'] === 'string' ? arRec['text'] : '';
    if (text !== '') {
      base.autoReply = {
        subject: typeof arRec['subject'] === 'string' ? arRec['subject'] : null,
        text,
        days: typeof arRec['days'] === 'number' ? arRec['days'] : 7,
      };
    }
  }
  if (typeof rec['applyToSpam'] === 'boolean') base.applyToSpam = rec['applyToSpam'];
  if (typeof rec['continueFiltering'] === 'boolean') {
    base.continueFiltering = rec['continueFiltering'];
  }
  return base;
}

function toSettings(row: SettingsRow): MailSettings {
  return {
    accountEmail: row.account_email,
    senderName: row.sender_name,
    theme: normalizeThemeSetting(row.theme),
    wallpaper: normalizeWallpaperChoice(row.wallpaper),
    replyQuote: row.reply_quote,
    afterDelete: row.after_delete === 'next' ? 'next' : 'list',
    notifyBrowser: row.notify_browser,
    notifyTab: row.notify_tab,
    collectContacts: row.collect_contacts,
    // `?? false` — это и значение по умолчанию, и поведение до миграции 0010.
    senderLogos: row.sender_logos ?? false,
    // `?? 0` — поведение до миграции 0016: письмо уходит сразу. Само же
    // умолчание возможности (пять секунд) проставляет колонке миграция.
    undoSendSeconds: normalizeUndoSeconds(row.undo_send_seconds ?? 0),
    // `?? true` — и умолчание, и поведение до миграции 0019: список
    // группируется, как в привычных почтовых интерфейсах.
    threadedList: row.threaded_list ?? true,
    autoReply: {
      enabled: row.autoreply_enabled,
      subject: row.autoreply_subject,
      text: row.autoreply_text,
      from: row.autoreply_from?.toISOString() ?? null,
      until: row.autoreply_until?.toISOString() ?? null,
      days: row.autoreply_days,
    },
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSignature(row: SignatureRow): Signature {
  return {
    id: Number(row.id),
    name: row.name,
    bodyHtml: row.body_html,
    isDefault: row.is_default,
    position: row.position,
  };
}

function toRule(row: FilterRow): FilterRule {
  return {
    id: Number(row.id),
    name: row.name,
    position: row.position,
    enabled: row.enabled,
    auto: row.is_auto,
    matchMode: row.match_mode === 'any' ? 'any' : 'all',
    conditions: parseConditions(row.conditions),
    actions: parseActions(row.actions),
  };
}

/** Отсутствующая таблица (42P01) — миграция 0005 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/**
 * Отсутствующая колонка (42703) — миграция 0009 не применена.
 *
 * Отличать от отсутствующей таблицы приходится: таблицы настроек есть,
 * работает всё, кроме запоминания оформления, и подсказка тут другая —
 * применить 0009, а не 0005. Пока код был один, человек шёл применять
 * миграцию, которая уже применена, и упирался в тупик.
 */
export function isUndefinedColumn(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42703');
}

/* ------------------------------------------------------------------ */
/* Хранилище                                                            */
/* ------------------------------------------------------------------ */

export class SettingsDb {
  readonly #pool: Pool;

  constructor(opts: SettingsDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Только суть ошибки: объект pg тянет за собой состояние соединения
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (настройки)'),
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

  /** Применена ли миграция 0005. */
  async schemaReady(): Promise<boolean> {
    const row = await this.one<{ ok: boolean }>(
      `SELECT to_regclass('public.mail_filters') IS NOT NULL AS ok`,
    );
    return row?.ok === true;
  }

  /* ---------------------------------------------------------------- */
  /* Общие настройки                                                    */
  /* ---------------------------------------------------------------- */

  async getSettings(email: string): Promise<MailSettings> {
    const row = await this.one<SettingsRow>(
      `SELECT * FROM mail_user_settings WHERE lower(account_email) = lower($1)`,
      [email],
    );
    return row ? toSettings(row) : defaultMailSettings(email.toLowerCase());
  }

  /**
   * Сохраняет общие настройки. Неупомянутые поля не трогаются: смена
   * имени отправителя не должна стирать текст автоответчика.
   */
  async saveSettings(email: string, patch: MailSettingsPatch): Promise<MailSettings> {
    await this.query(
      `INSERT INTO mail_user_settings (account_email) VALUES (lower($1))
       ON CONFLICT (account_email) DO NOTHING`,
      [email],
    );

    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}`);
    };

    if (patch.senderName !== undefined) put('sender_name', patch.senderName);
    // Оформление правится отдельным маршрутом и отдельной заплаткой:
    // смена темы не должна ни трогать, ни требовать остальную форму
    // настроек (см. appearance.ts).
    if (patch.theme !== undefined) put('theme', patch.theme);
    if (patch.wallpaper !== undefined) put('wallpaper', patch.wallpaper);
    if (patch.replyQuote !== undefined) put('reply_quote', patch.replyQuote);
    if (patch.afterDelete !== undefined)
      put('after_delete', patch.afterDelete satisfies AfterDelete);
    if (patch.notifyBrowser !== undefined) put('notify_browser', patch.notifyBrowser);
    if (patch.notifyTab !== undefined) put('notify_tab', patch.notifyTab);
    if (patch.collectContacts !== undefined) put('collect_contacts', patch.collectContacts);
    if (patch.senderLogos !== undefined) put('sender_logos', patch.senderLogos);
    if (patch.undoSendSeconds !== undefined) {
      // Приводим к разрешённому и здесь: в базу должно попадать только то,
      // что интерфейс умеет показать обратно
      put('undo_send_seconds', normalizeUndoSeconds(patch.undoSendSeconds));
    }
    if (patch.threadedList !== undefined) put('threaded_list', patch.threadedList);
    if (patch.autoReply) {
      const ar = patch.autoReply;
      if (ar.enabled !== undefined) put('autoreply_enabled', ar.enabled);
      if (ar.subject !== undefined) put('autoreply_subject', ar.subject);
      if (ar.text !== undefined) put('autoreply_text', ar.text);
      if (ar.from !== undefined) put('autoreply_from', ar.from);
      if (ar.until !== undefined) put('autoreply_until', ar.until);
      if (ar.days !== undefined) put('autoreply_days', ar.days);
    }

    if (sets.length > 0) {
      values.push(email);
      await this.query(
        `UPDATE mail_user_settings SET ${sets.join(', ')}, updated_at = now()
          WHERE lower(account_email) = lower($${String(values.length)})`,
        values,
      );
    }
    return this.getSettings(email);
  }

  /* ---------------------------------------------------------------- */
  /* Подписи                                                            */
  /* ---------------------------------------------------------------- */

  async listSignatures(email: string): Promise<Signature[]> {
    const rows = await this.query<SignatureRow>(
      `SELECT id, name, body_html, is_default, position
         FROM mail_signatures WHERE lower(account_email) = lower($1)
        ORDER BY position, id`,
      [email],
    );
    return rows.map(toSignature);
  }

  async createSignature(
    email: string,
    input: { name: string; bodyHtml: string; isDefault: boolean },
  ): Promise<Signature[]> {
    if (input.isDefault) await this.clearDefaultSignature(email);
    await this.query(
      `INSERT INTO mail_signatures (account_email, name, body_html, is_default, position)
       VALUES (lower($1), $2, $3, $4,
               coalesce((SELECT max(position) + 1 FROM mail_signatures
                          WHERE lower(account_email) = lower($1)), 0))`,
      [email, input.name, input.bodyHtml, input.isDefault],
    );
    await this.ensureOneDefaultSignature(email);
    return this.listSignatures(email);
  }

  /**
   * Заменяет ВСЕ подписи ящика одной — целиком или никак.
   *
   * Нужна массовой раскладке подписей из панели: там режим «заменить»
   * сносил прежние подписи по одной и только потом заводил новую, каждый
   * запрос отдельно. Любой обрыв между ними (перезапуск контейнера из
   * панели — поддерживаемое действие, а раскладка по сотням ящиков идёт
   * минуты) оставлял ящик БЕЗ ЕДИНОЙ подписи, а текста стёртых не
   * оставалось нигде: запись в журнал делается только после успеха.
   *
   * Рядом, у переcтановки правил фильтрации, транзакция стоит с тем же
   * обоснованием — «половина переставленного списка означала бы
   * непредсказуемое поведение». Здесь цена выше: пропадает написанный
   * человеком текст.
   */
  async replaceSignatures(
    email: string,
    input: { name: string; bodyHtml: string; isDefault: boolean },
  ): Promise<Signature[]> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM mail_signatures WHERE lower(account_email) = lower($1)`, [
        email,
      ]);
      await client.query(
        `INSERT INTO mail_signatures (account_email, name, body_html, is_default, position)
         VALUES (lower($1), $2, $3, $4, 0)`,
        [email, input.name, input.bodyHtml, input.isDefault],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    // Ровно одна подпись — она же и по умолчанию, если так просили.
    await this.ensureOneDefaultSignature(email);
    return this.listSignatures(email);
  }

  async updateSignature(
    email: string,
    id: number,
    patch: {
      name?: string | undefined;
      bodyHtml?: string | undefined;
      isDefault?: boolean | undefined;
      position?: number | undefined;
    },
  ): Promise<Signature[]> {
    if (patch.isDefault === true) await this.clearDefaultSignature(email);
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}`);
    };
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.bodyHtml !== undefined) put('body_html', patch.bodyHtml);
    if (patch.isDefault !== undefined) put('is_default', patch.isDefault);
    if (patch.position !== undefined) put('position', patch.position);
    if (sets.length > 0) {
      values.push(id, email);
      await this.query(
        `UPDATE mail_signatures SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${String(values.length - 1)}
            AND lower(account_email) = lower($${String(values.length)})`,
        values,
      );
    }
    await this.ensureOneDefaultSignature(email);
    return this.listSignatures(email);
  }

  async deleteSignature(email: string, id: number): Promise<Signature[]> {
    await this.query(
      `DELETE FROM mail_signatures WHERE id = $1 AND lower(account_email) = lower($2)`,
      [id, email],
    );
    await this.ensureOneDefaultSignature(email);
    return this.listSignatures(email);
  }

  private async clearDefaultSignature(email: string): Promise<void> {
    await this.query(
      `UPDATE mail_signatures SET is_default = FALSE
        WHERE lower(account_email) = lower($1) AND is_default`,
      [email],
    );
  }

  /**
   * Если подписи есть, но ни одна не помечена как основная, помечаем первую.
   * Интерфейс всегда должен знать, какую подпись подставлять в новое письмо.
   */
  private async ensureOneDefaultSignature(email: string): Promise<void> {
    await this.query(
      `UPDATE mail_signatures SET is_default = TRUE
        WHERE id = (SELECT id FROM mail_signatures
                     WHERE lower(account_email) = lower($1)
                     ORDER BY position, id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM mail_signatures
                           WHERE lower(account_email) = lower($1) AND is_default)`,
      [email],
    );
  }

  /* ---------------------------------------------------------------- */
  /* Правила фильтрации                                                 */
  /* ---------------------------------------------------------------- */

  async listFilters(email: string): Promise<FilterRule[]> {
    const rows = await this.query<FilterRow>(
      `SELECT id, name, position, enabled, is_auto, match_mode, conditions, actions
         FROM mail_filters WHERE lower(account_email) = lower($1)
        ORDER BY position, id`,
      [email],
    );
    return rows.map(toRule);
  }

  async getFilter(email: string, id: number): Promise<FilterRule | null> {
    const row = await this.one<FilterRow>(
      `SELECT id, name, position, enabled, is_auto, match_mode, conditions, actions
         FROM mail_filters WHERE id = $1 AND lower(account_email) = lower($2)`,
      [id, email],
    );
    return row ? toRule(row) : null;
  }

  async createFilter(email: string, input: FilterRuleInput): Promise<FilterRule> {
    const row = await this.one<FilterRow>(
      `INSERT INTO mail_filters
         (account_email, name, position, enabled, is_auto, match_mode, conditions, actions)
       VALUES (lower($1), $2,
               coalesce($3, (SELECT coalesce(max(position) + 1, 0) FROM mail_filters
                              WHERE lower(account_email) = lower($1))),
               $4, $5, $6, $7::jsonb, $8::jsonb)
       RETURNING id, name, position, enabled, is_auto, match_mode, conditions, actions`,
      [
        email,
        input.name,
        input.position ?? null,
        input.enabled,
        input.auto,
        input.matchMode,
        JSON.stringify(input.conditions),
        JSON.stringify(input.actions),
      ],
    );
    if (!row) throw new Error('Не удалось создать правило фильтрации');
    return toRule(row);
  }

  async updateFilter(
    email: string,
    id: number,
    patch: Partial<FilterRuleInput>,
  ): Promise<FilterRule | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown, cast = ''): void => {
      values.push(value);
      sets.push(`${column} = $${String(values.length)}${cast}`);
    };
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.position !== undefined) put('position', patch.position);
    if (patch.enabled !== undefined) put('enabled', patch.enabled);
    if (patch.auto !== undefined) put('is_auto', patch.auto);
    if (patch.matchMode !== undefined) put('match_mode', patch.matchMode);
    if (patch.conditions !== undefined)
      put('conditions', JSON.stringify(patch.conditions), '::jsonb');
    if (patch.actions !== undefined) put('actions', JSON.stringify(patch.actions), '::jsonb');
    if (sets.length > 0) {
      values.push(id, email);
      await this.query(
        `UPDATE mail_filters SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${String(values.length - 1)}
            AND lower(account_email) = lower($${String(values.length)})`,
        values,
      );
    }
    return this.getFilter(email, id);
  }

  async deleteFilter(email: string, id: number): Promise<boolean> {
    const rows = await this.query<{ id: string }>(
      `DELETE FROM mail_filters WHERE id = $1 AND lower(account_email) = lower($2) RETURNING id`,
      [id, email],
    );
    return rows.length > 0;
  }

  /**
   * Переставляет правила в порядке переданных идентификаторов.
   * Порядок правил — это порядок их применения, поэтому запись идёт
   * одной транзакцией: половина переставленного списка означала бы
   * непредсказуемое поведение фильтров.
   */
  async reorderFilters(email: string, ids: number[]): Promise<FilterRule[]> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ids.length; i += 1) {
        await client.query(
          `UPDATE mail_filters SET position = $1, updated_at = now()
            WHERE id = $2 AND lower(account_email) = lower($3)`,
          [i, ids[i], email],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.listFilters(email);
  }
}
