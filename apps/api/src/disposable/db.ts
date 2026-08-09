/**
 * Хранилище одноразовых адресов.
 *
 * Работает с ДВУМЯ таблицами сразу, и это главное, что нужно про него
 * понимать:
 *
 *   * `virtual_aliases` — контракт с Postfix. Сам адрес, куда он ведёт и
 *     работает ли. Эту таблицу читает карта virtual_alias_maps напрямую,
 *     поэтому изменения действуют сразу, без перезапуска и без обновления
 *     каких-либо файлов.
 *   * `disposable_aliases` (миграция 0028) — пристройка: чей адрес, кому
 *     выдан, когда выключен.
 *
 * Второго механизма адресов здесь нет и быть не должно: Postfix знает
 * ровно одну карту алиасов, и одноразовый адрес — обычная её строка.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЗАПИСЬ ИДЁТ ТРАНЗАКЦИЕЙ
 * ------------------------------------------------------------------
 * Строка в virtual_aliases без строки в disposable_aliases — это адрес,
 * который РАБОТАЕТ (Postfix уже носит на него почту), но которого владелец
 * не видит в своём разделе и, значит, не может выключить. Обратная половина
 * безобидна, а эта — нет. Поэтому обе строки пишутся в одной транзакции.
 *
 * Наружу торчит интерфейс, а не класс: маршруты общаются с хранилищем
 * только через него, и проверки подставляют хранилище в памяти.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { BadRequestError } from '../errors.js';
import { errorInfo } from '../log.js';

/**
 * Адрес, который человек пытается включить, уже занят настоящим ящиком.
 *
 * Отдельная ошибка, а не общий отказ: человеку надо объяснить, почему
 * его собственный адрес вдруг «нельзя», — иначе это выглядит поломкой.
 */
export class DisposableAddressTakenError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'DisposableAddressTakenError';
  }
}

/** Строка адреса, как она лежит в базе (обе таблицы разом). */
export interface DisposableRow {
  id: number;
  address: string;
  destination: string;
  active: boolean;
  note: string;
  createdAt: Date;
  disabledAt: Date | null;
}

export interface DisposableStore {
  /** Применены ли миграции 0001 (virtual_aliases) и 0028. */
  schemaReady(): Promise<boolean>;
  /** Адреса ящика, свежие первыми. Считая выключенные. */
  list(ownerEmail: string): Promise<DisposableRow[]>;
  /** Сколько адресов уже занято ящиком — против предела. */
  count(ownerEmail: string): Promise<number>;
  /**
   * Занят ли адрес хоть чем-нибудь: ящиком, чужим алиасом, своим.
   * Смотрит ОБЕ таблицы — см. пояснение в `taken`.
   */
  taken(address: string): Promise<boolean>;
  /** Есть ли такой домен у сервера. Заводить адреса в чужом нельзя. */
  domainId(domain: string): Promise<number | null>;
  create(params: {
    domainId: number;
    address: string;
    ownerEmail: string;
    note: string;
  }): Promise<DisposableRow>;
  /** Включить/выключить. Возвращает null, если адрес не этого ящика. */
  setActive(ownerEmail: string, id: number, active: boolean): Promise<DisposableRow | null>;
  /** Переименовать пометку «кому выдан». */
  setNote(ownerEmail: string, id: number, note: string): Promise<DisposableRow | null>;
  /** Удалить совсем. Возвращает удалённое или null. */
  remove(ownerEmail: string, id: number): Promise<DisposableRow | null>;
  shutdown(): Promise<void>;
}

/** Отсутствующая таблица (42P01) — миграция не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/** Нарушение уникальности (23505) — адрес заняли между проверкой и записью. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

interface RowRaw extends QueryResultRow {
  id: number;
  address: string;
  destination: string;
  active: boolean;
  note: string;
  created_at: Date;
  disabled_at: Date | null;
}

const toRow = (r: RowRaw): DisposableRow => ({
  id: Number(r.id),
  address: r.address,
  destination: r.destination,
  active: r.active,
  note: r.note ?? '',
  createdAt: r.created_at,
  disabledAt: r.disabled_at,
});

/*
 * Общий кусок выборки. Соединение внутреннее (INNER JOIN) намеренно:
 * алиас без строки в disposable_aliases — это алиас АДМИНИСТРАТОРА, и
 * владельцу ящика он не показывается, даже если ведёт на его ящик.
 * Иначе человек смог бы выключить служебный support@, просто потому что
 * тот пересылается ему.
 */
const SELECT = `
  SELECT a.id,
         a.source      AS address,
         a.destination AS destination,
         a.active      AS active,
         d.note        AS note,
         d.created_at  AS created_at,
         d.disabled_at AS disabled_at
    FROM disposable_aliases d
    JOIN virtual_aliases a ON a.id = d.alias_id
`;

export class DisposableDb implements DisposableStore {
  private readonly pool: Pool;
  private readonly logger: Logger;

  constructor(opts: { connectionString: string; logger: Logger }) {
    this.pool = new Pool({ connectionString: opts.connectionString, max: 2 });
    this.logger = opts.logger;
    this.pool.on('error', (err) => {
      this.logger.error(errorInfo(err), 'Сбой соединения с базой одноразовых адресов');
    });
  }

  async schemaReady(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1 FROM disposable_aliases LIMIT 1');
      await this.pool.query('SELECT 1 FROM virtual_aliases LIMIT 1');
      return true;
    } catch (err) {
      if (isUndefinedTable(err)) return false;
      throw err;
    }
  }

  async list(ownerEmail: string): Promise<DisposableRow[]> {
    const { rows } = await this.pool.query<RowRaw>(
      `${SELECT} WHERE d.owner_email = $1 ORDER BY d.created_at DESC, a.id DESC`,
      [ownerEmail],
    );
    return rows.map(toRow);
  }

  async count(ownerEmail: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM disposable_aliases WHERE owner_email = $1',
      [ownerEmail],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Занятость адреса.
   *
   * Смотрится ТРИ места, и каждое по своей причине:
   *   1. virtual_users — живой ящик. Алиас поверх ящика уводит всю его
   *      входящую почту в сторону (карта алиасов разбирается раньше карты
   *      ящиков), см. admin/alias-check.ts.
   *   2. virtual_aliases — любой алиас, включая ВЫКЛЮЧЕННЫЕ. Выключенный
   *      адрес обязан оставаться занятым: освободить имя значит отдать
   *      чужому человеку почту, которую магазин ещё шлёт на старый адрес.
   *   3. Регистр. Адреса сравниваются в нижнем регистре: `Shop@` и `shop@`
   *      для Postfix одно и то же, и «свободно» по одному из них было бы
   *      ложью.
   */
  async taken(address: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT 1 FROM virtual_users   WHERE lower(email)  = $1
         UNION ALL
         SELECT 1 FROM virtual_aliases WHERE lower(source) = $1
       ) AS t`,
      [address.toLowerCase()],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async domainId(domain: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ id: number }>(
      'SELECT id FROM virtual_domains WHERE lower(name) = $1',
      [domain.toLowerCase()],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  async create(params: {
    domainId: number;
    address: string;
    ownerEmail: string;
    note: string;
  }): Promise<DisposableRow> {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO virtual_aliases (domain_id, source, destination, active)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id`,
        [params.domainId, params.address, params.ownerEmail],
      );
      const aliasId = Number(rows[0]!.id);
      const { rows: made } = await client.query<RowRaw>(
        `INSERT INTO disposable_aliases (alias_id, owner_email, note)
         VALUES ($1, $2, $3)
         RETURNING $2::text AS destination, note, created_at, disabled_at`,
        [aliasId, params.ownerEmail, params.note],
      );
      const row = made[0]!;
      return {
        id: aliasId,
        address: params.address,
        destination: params.ownerEmail,
        active: true,
        note: row.note ?? '',
        createdAt: row.created_at,
        disabledAt: row.disabled_at,
      };
    });
  }

  /**
   * Включение и выключение.
   *
   * Правится `virtual_aliases.active` — то самое поле, по которому карта
   * алиасов отвечает Postfix. Здесь же проставляется `disabled_at`, и обе
   * правки идут одной транзакцией: разойдясь, они дали бы адрес, который
   * в интерфейсе «выключен», а почту носит.
   *
   * Отбор по owner_email — не украшение: без него любой владелец ящика
   * выключал бы чужие адреса по номеру.
   */
  /**
   * Включение проверяет, не занят ли адрес — как при заведении.
   *
   * ------------------------------------------------------------------
   * ЧТО БЫЛО
   * ------------------------------------------------------------------
   * Занятость проверялась ТОЛЬКО при заведении адреса, а включение было
   * голым переключением поля. При этом поиск занятости смотрит на
   * действующие записи (`AND active`), то есть выключенной строки не
   * видит вовсе, а Postfix разбирает карту алиасов раньше карты ящиков.
   *
   * Отсюда захват чужой почты в три шага: владелец заранее заводит
   * ivan@company.ru и выключает его; администратор, не видя препятствий,
   * создаёт настоящий ящик Ивана; владелец включает адрес обратно — и
   * вся входящая почта Ивана, включая письма восстановления паролей,
   * уходит постороннему. Ящик Ивана при этом открывается и выглядит
   * исправным, так что искать причину он будет где угодно, только не
   * здесь.
   *
   * Проверка идёт ВНУТРИ той же транзакции и с блокировкой строки ящика:
   * иначе между проверкой и записью успевает вклиниться создание ящика.
   */
  async setActive(ownerEmail: string, id: number, active: boolean): Promise<DisposableRow | null> {
    return this.tx(async (client) => {
      if (active) {
        const { rows: mine } = await client.query<{ source: string }>(
          `SELECT a.source
             FROM virtual_aliases a
             JOIN disposable_aliases d ON d.alias_id = a.id
            WHERE a.id = $1 AND d.owner_email = $2`,
          [id, ownerEmail],
        );
        const source = mine[0]?.source;
        if (source === undefined) return null;
        /*
         * Без агрегата: `FOR UPDATE` вместе с `count(*)` Postgres
         * запрещает («FOR UPDATE is not allowed with aggregate
         * functions»), и такой запрос отвечал бы не отказом, а внутренней
         * ошибкой — то есть человек видел бы «что-то сломалось» вместо
         * объяснения, почему адрес занят. Найдено живой проверкой на
         * сервере: тесты этого не ловят, там заглушка вместо Postgres.
         */
        const { rows: busy } = await client.query<{ id: number }>(
          `SELECT id FROM virtual_users WHERE lower(email) = lower($1) LIMIT 1 FOR UPDATE`,
          [source],
        );
        if (busy.length > 0) {
          throw new DisposableAddressTakenError(
            `Адрес ${source} теперь занят настоящим почтовым ящиком. ` +
              'Включить его снова нельзя: письма уходили бы не тому, кому их пишут.',
          );
        }
      }
      const { rowCount } = await client.query(
        `UPDATE virtual_aliases a
            SET active = $3
           FROM disposable_aliases d
          WHERE d.alias_id = a.id AND a.id = $2 AND d.owner_email = $1`,
        [ownerEmail, id, active],
      );
      if (!rowCount) return null;
      await client.query(
        `UPDATE disposable_aliases SET disabled_at = ${active ? 'NULL' : 'now()'}
          WHERE alias_id = $1 AND owner_email = $2`,
        [id, ownerEmail],
      );
      return this.one(client, ownerEmail, id);
    });
  }

  async setNote(ownerEmail: string, id: number, note: string): Promise<DisposableRow | null> {
    const { rowCount } = await this.pool.query(
      'UPDATE disposable_aliases SET note = $3 WHERE alias_id = $2 AND owner_email = $1',
      [ownerEmail, id, note],
    );
    if (!rowCount) return null;
    return this.one(this.pool, ownerEmail, id);
  }

  /**
   * Удаление.
   *
   * Достаточно удалить строку virtual_aliases: строка disposable_aliases
   * уйдёт следом по ON DELETE CASCADE. В обратную сторону это не работает
   * и работать не должно — удалив только пристройку, мы оставили бы живой
   * алиас, которого никто уже не видит.
   */
  async remove(ownerEmail: string, id: number): Promise<DisposableRow | null> {
    const before = await this.one(this.pool, ownerEmail, id);
    if (!before) return null;
    await this.pool.query(
      `DELETE FROM virtual_aliases a
        USING disposable_aliases d
        WHERE d.alias_id = a.id AND a.id = $2 AND d.owner_email = $1`,
      [ownerEmail, id],
    );
    return before;
  }

  private async one(
    q: Pool | PoolClient,
    ownerEmail: string,
    id: number,
  ): Promise<DisposableRow | null> {
    const { rows } = await q.query<RowRaw>(`${SELECT} WHERE d.owner_email = $1 AND a.id = $2`, [
      ownerEmail,
      id,
    ]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

  async shutdown(): Promise<void> {
    await this.pool.end();
  }
}
