/**
 * Хранилище указателя переписки.
 *
 * Своё подключение к Postgres — как у настроек, админки, помощника ИИ и
 * уведомлений. Почта обязана работать и без базы: без неё просто не будет
 * подсказки адреса, а чтение и отправка не пострадают ни в чём.
 *
 * ------------------------------------------------------------------
 * ПРИВАТНОСТЬ ЗДЕСЬ — ЭТО УСТРОЙСТВО, А НЕ ПРОВЕРКА
 * ------------------------------------------------------------------
 * Каждый запрос ниже начинается с `account_email = $1`, и ни у одного нет
 * ветки, где этот столбец можно опустить. Адрес приходит из сессии (см.
 * routes.ts) и не берётся ни из тела запроса, ни из строки адреса — то
 * есть попросить чужой круг общения попросту нечем.
 *
 * Ни одна таблица почтового стека этим модулем не изменяется.
 */
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { FoldedContact } from './observations.js';
import type { ContactRow } from './rank.js';
import { escapeLike, contactTokens, normalizeQuery } from './tokens.js';

export interface ContactsDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

/** Роль папки, из которой собирались адреса. */
export type HarvestRole = 'inbox' | 'sent';

/** Докуда сборщик дошёл в одной папке одного ящика. */
export interface ContactCursor {
  role: HarvestRole;
  uidValidity: number;
  /** Наибольший разобранный UID: всё, что выше, — новая почта. */
  topUid: number;
  /** Наименьший разобранный UID: ниже — старая почта, её добираем в фоне. */
  bottomUid: number;
  backfillDone: boolean;
  scanned: number;
}

/**
 * Сколько строк база отдаёт наверх на один запрос подсказки.
 *
 * Двести — это не «сколько показать» (показываем восемь), а сколько
 * кандидатов взвесить. Отбор по началу слова база делает сама, а порядок
 * считается в rank.ts, и ему нужны кандидаты. Двести хватает с огромным
 * запасом: столько адресов начинается с одних и тех же букв только при
 * вводе одной буквы, а после второй счёт идёт на единицы. Предел стоит
 * ради ящика, где переписка велась с десятью тысячами адресов: без него
 * первая же нажатая буква утащила бы в память весь указатель.
 */
export const CANDIDATE_LIMIT = 200;

interface ContactDbRow extends QueryResultRow {
  address: string;
  display_name: string | null;
  tokens: string;
  sent_count: number;
  recv_count: number;
  last_seen_at: Date;
}

interface CursorDbRow extends QueryResultRow {
  folder_role: string;
  uid_validity: string;
  top_uid: string;
  bottom_uid: string;
  backfill_done: boolean;
  scanned: string;
}

/** Отсутствующая таблица (42P01) — миграция 0017 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

function toContactRow(row: ContactDbRow): ContactRow {
  return {
    address: row.address,
    name: row.display_name,
    sentCount: Number(row.sent_count),
    recvCount: Number(row.recv_count),
    lastSeenAt: row.last_seen_at,
    tokens: row.tokens,
  };
}

/**
 * Какой давностью помечается строка, заведённая СКРЫТИЕМ адреса.
 *
 * Начало эпохи, а не `now()`, и это не мелочь. Убрать из подсказок можно
 * адрес, которого сборщик ещё не видел ни в одном письме (он пришёл в
 * подсказке из памяти окна написания) — строка тогда заводится здесь же,
 * с пустым именем. Позже сборщик доходит до писем этого человека и зовёт
 * `upsert`, а тот обновляет имя и строку поиска ТОЛЬКО письмом более
 * свежим, чем уже учтённое: иначе имя из письма трёхлетней давности
 * затирало бы нынешнее.
 *
 * Письма всегда старше момента скрытия. Значит, с `now()` имя не
 * проставлялось НИКОГДА: человек возвращал контакт из скрытых, а дальше
 * находил его только по адресу и не находил по фамилии — притом что
 * переписка с этим человеком в ящике лежит.
 *
 * Начало эпохи старше любого письма, поэтому первое же настоящее письмо
 * заполняет имя, как и должно.
 */
export const HIDDEN_PLACEHOLDER_SEEN_AT = new Date(0);

/**
 * Запрос скрытия (или возврата) адреса.
 *
 * Вынесен из метода отдельно, чтобы его можно было проверить без живой
 * базы: беда была не в схеме, а в ЗНАЧЕНИЯХ, которые уходят в запрос, —
 * см. HIDDEN_PLACEHOLDER_SEEN_AT.
 */
export function setHiddenStatement(
  accountEmail: string,
  address: string,
  hidden: boolean,
): { text: string; values: unknown[] } {
  return {
    text: `INSERT INTO mail_contacts
         (account_email, address, display_name, tokens, hidden,
          first_seen_at, last_seen_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $5, now())
       ON CONFLICT (account_email, address)
       DO UPDATE SET hidden = EXCLUDED.hidden, updated_at = now()`,
    values: [
      accountEmail,
      address,
      contactTokens(null, address),
      hidden,
      HIDDEN_PLACEHOLDER_SEEN_AT,
    ],
  };
}

export class ContactsDb {
  readonly #pool: Pool;
  readonly #logger: Logger;

  constructor(opts: ContactsDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      // Немного: подсказка — короткие запросы по индексу, а сборщик ходит
      // сюда порциями раз в несколько секунд.
      max: opts.max ?? 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#logger = opts.logger;
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (адресная книга)'),
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(text, values);
    return result.rows;
  }

  /** Применена ли миграция 0017. */
  async schemaReady(): Promise<boolean> {
    const rows = await this.#query<{ ok: boolean }>(
      `SELECT to_regclass('public.mail_contacts') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  /* ---------------------------------------------------------------- */
  /* Пополнение                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Дописывает порцию наблюдений.
   *
   * Одним запросом на всю порцию, через unnest, а не строкой за строкой:
   * порция сборщика — до тысячи писем, и тысяча отдельных запросов заняла
   * бы больше времени, чем сама выборка конвертов у Dovecot.
   *
   * Что делает `ON CONFLICT DO UPDATE` и, главное, чего НЕ делает:
   *
   *   * счётчики складываются — указатель пополняется, а не переписывается;
   *   * имя и строка поиска обновляются ТОЛЬКО письмом более свежим, чем
   *     уже учтённое: сборщик идёт от новых писем к старым, и без этого
   *     условия имя из письма трёхлетней давности затирало бы нынешнее;
   *   * `hidden` не трогается вовсе. Это главное свойство всей записи:
   *     адрес, убранный человеком из подсказок, обязан остаться убранным,
   *     хотя письмо, из которого он взят, никуда не делось и встречается
   *     сборщику снова и снова.
   *
   * Возвращает число затронутых строк.
   */
  async upsert(accountEmail: string, folded: readonly FoldedContact[]): Promise<number> {
    if (folded.length === 0) return 0;
    const addresses: string[] = [];
    const names: (string | null)[] = [];
    const tokens: string[] = [];
    const sent: number[] = [];
    const recv: number[] = [];
    const seen: string[] = [];
    for (const item of folded) {
      addresses.push(item.address);
      names.push(item.name);
      tokens.push(contactTokens(item.name, item.address));
      sent.push(item.sentDelta);
      recv.push(item.recvDelta);
      seen.push(item.lastSeenAt.toISOString());
    }

    const result = await this.#pool.query(
      `INSERT INTO mail_contacts
         (account_email, address, display_name, tokens,
          sent_count, recv_count, first_seen_at, last_seen_at, updated_at)
       SELECT $1, x.address, x.name, x.tokens, x.sent, x.recv, x.seen, x.seen, now()
         FROM unnest($2::text[], $3::text[], $4::text[],
                     $5::int[], $6::int[], $7::timestamptz[])
              AS x(address, name, tokens, sent, recv, seen)
       ON CONFLICT (account_email, address) DO UPDATE SET
         sent_count   = mail_contacts.sent_count + EXCLUDED.sent_count,
         recv_count   = mail_contacts.recv_count + EXCLUDED.recv_count,
         display_name = CASE
                          WHEN EXCLUDED.last_seen_at >= mail_contacts.last_seen_at
                               AND EXCLUDED.display_name IS NOT NULL
                          THEN EXCLUDED.display_name
                          ELSE mail_contacts.display_name
                        END,
         tokens       = CASE
                          WHEN EXCLUDED.last_seen_at >= mail_contacts.last_seen_at
                               AND EXCLUDED.display_name IS NOT NULL
                          THEN EXCLUDED.tokens
                          ELSE mail_contacts.tokens
                        END,
         last_seen_at = GREATEST(mail_contacts.last_seen_at, EXCLUDED.last_seen_at),
         updated_at   = now()`,
      [accountEmail, addresses, names, tokens, sent, recv, seen],
    );
    return result.rowCount ?? 0;
  }

  /* ---------------------------------------------------------------- */
  /* Подсказка                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Кандидаты по началу слова.
   *
   * Два условия LIKE — это «строка поиска начинается с запроса» и «какое-то
   * слово внутри начинается с запроса». Именно так человек и вспоминает
   * корреспондента: по имени, по фамилии, по началу адреса или по домену
   * (см. contactTokens).
   *
   * Порядок здесь — грубый, только чтобы отсечь лишних при пределе:
   * настоящий порядок считает rank.ts, ему нужна давность с затуханием,
   * а такое выражение в ORDER BY нечем проверить без поднятой базы.
   */
  async suggest(
    accountEmail: string,
    rawQuery: string,
    exclude: readonly string[] = [],
    limit: number = CANDIDATE_LIMIT,
  ): Promise<ContactRow[]> {
    const query = normalizeQuery(rawQuery);
    if (query === '') return [];
    const like = escapeLike(query);
    const rows = await this.#query<ContactDbRow>(
      `SELECT address, display_name, tokens, sent_count, recv_count, last_seen_at
         FROM mail_contacts
        WHERE account_email = $1
          AND NOT hidden
          AND (tokens LIKE $2 ESCAPE '\\' OR tokens LIKE $3 ESCAPE '\\')
          AND address <> ALL($4::text[])
        ORDER BY (3 * sent_count + recv_count) DESC, last_seen_at DESC
        LIMIT $5`,
      [accountEmail, `${like}%`, `% ${like}%`, [...exclude], limit],
    );
    return rows.map(toContactRow);
  }

  /**
   * Убирает адрес из подсказок (или возвращает обратно).
   *
   * Признак, а не удаление строки, — см. пояснение в миграции 0017:
   * письмо с этим адресом в ящике осталось, и удалённая строка вернулась
   * бы следующим же проходом сборщика.
   *
   * Строка заводится, даже если её ещё нет: человек может убрать адрес,
   * который пришёл в подсказке из кэша браузера, а в базе к этому моменту
   * уже перезаписан. Отказ «нечего убирать» выглядел бы как поломка.
   */
  async setHidden(accountEmail: string, address: string, hidden: boolean): Promise<void> {
    const statement = setHiddenStatement(accountEmail, address, hidden);
    await this.#pool.query(statement.text, statement.values);
  }

  /** Сколько адресов в указателе ящика (без скрытых). */
  async count(accountEmail: string): Promise<number> {
    const rows = await this.#query<{ n: string }>(
      `SELECT count(*)::text AS n FROM mail_contacts
        WHERE account_email = $1 AND NOT hidden`,
      [accountEmail],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /* ---------------------------------------------------------------- */
  /* Отметки сборщика                                                  */
  /* ---------------------------------------------------------------- */

  async cursors(accountEmail: string): Promise<ContactCursor[]> {
    const rows = await this.#query<CursorDbRow>(
      `SELECT folder_role, uid_validity, top_uid, bottom_uid, backfill_done, scanned
         FROM mail_contact_cursors WHERE account_email = $1`,
      [accountEmail],
    );
    return rows
      .filter((row) => row.folder_role === 'inbox' || row.folder_role === 'sent')
      .map((row) => ({
        role: row.folder_role as HarvestRole,
        uidValidity: Number(row.uid_validity),
        topUid: Number(row.top_uid),
        bottomUid: Number(row.bottom_uid),
        backfillDone: row.backfill_done,
        scanned: Number(row.scanned),
      }));
  }

  async saveCursor(accountEmail: string, cursor: ContactCursor): Promise<void> {
    await this.#pool.query(
      `INSERT INTO mail_contact_cursors
         (account_email, folder_role, uid_validity, top_uid, bottom_uid,
          backfill_done, scanned, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (account_email, folder_role) DO UPDATE SET
         uid_validity  = EXCLUDED.uid_validity,
         top_uid       = EXCLUDED.top_uid,
         bottom_uid    = EXCLUDED.bottom_uid,
         backfill_done = EXCLUDED.backfill_done,
         scanned       = EXCLUDED.scanned,
         updated_at    = now()`,
      [
        accountEmail,
        cursor.role,
        cursor.uidValidity,
        cursor.topUid,
        cursor.bottomUid,
        cursor.backfillDone,
        cursor.scanned,
      ],
    );
  }

  /**
   * Убирает указатель ящика целиком.
   *
   * Нужен не только уборке после удаления ящика (её делает AdminDb, чтобы
   * всё удаление ящика оставалось одной операцией), но и здесь: сборщик
   * зовёт это, когда у папки сменился UIDVALIDITY при пустом ящике, —
   * и тому, кто захочет «начать подсказки с чистого листа».
   */
  async purge(accountEmail: string): Promise<number> {
    let removed = 0;
    for (const sql of [
      `DELETE FROM mail_contacts WHERE account_email = $1`,
      `DELETE FROM mail_contact_cursors WHERE account_email = $1`,
    ]) {
      const result = await this.#pool.query(sql, [accountEmail]);
      removed += result.rowCount ?? 0;
    }
    this.#logger.debug({ removed }, 'Указатель переписки очищен');
    return removed;
  }
}
