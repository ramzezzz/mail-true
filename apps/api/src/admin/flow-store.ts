/**
 * Хранилище истории доставки (таблицы миграции 0007).
 *
 * Отдельным модулем, а не методами AdminDb: admin/db.ts — общий файл про
 * ящики, домены и алиасы, и раздел «Почтовый поток» ему ничего не должен.
 * Здесь только свои таблицы, и работает он через открытые методы AdminDb
 * (query/one), то есть через тот же пул соединений — второго подключения
 * к базе ради истории не заводим.
 *
 * Единственный источник этих строк — журнал Postfix: сам Postfix историю
 * обработанных писем нигде не держит (см. flow-collector.ts).
 */
import type { AdminDb } from './db.js';

/** Где остановился разбор журнала. */
export interface FlowCursor {
  source: string;
  fileId: string;
  byteOffset: number;
  startedAt: Date;
}

/** То, что сборщик кладёт в таблицу (см. mail-log.ts: FlowEvent). */
export interface FlowEventInput {
  occurredAt: Date;
  queueId: string | null;
  direction: string;
  status: string;
  sender: string | null;
  recipient: string | null;
  relay: string | null;
  delaySeconds: number | null;
  sizeBytes: number | null;
  dsn: string | null;
  reason: string | null;
}

export interface FlowEventRow {
  id: string;
  occurred_at: Date;
  queue_id: string | null;
  direction: string;
  status: string;
  sender: string | null;
  recipient: string | null;
  relay: string | null;
  delay_seconds: string | null;
  size_bytes: string | null;
  dsn: string | null;
  reason: string | null;
}

export interface FlowFilters {
  from?: Date | undefined;
  to?: Date | undefined;
  statuses?: readonly string[] | undefined;
  direction?: string | undefined;
  search?: string | undefined;
  /** Курсор: строки строго старее этой пары «время + идентификатор». */
  beforeTime?: Date | undefined;
  beforeId?: string | undefined;
  /**
   * Обратный курсор: строки строго НОВЕЕ этой пары. Нужен автообновлению —
   * дочитать появившееся с прошлого раза, не перезапрашивая всё, что человек
   * уже подгрузил прокруткой.
   */
  afterTime?: Date | undefined;
  afterId?: string | undefined;
  limit: number;
}

interface FlowCursorRow {
  source: string;
  file_id: string;
  byte_offset: string;
  started_at: Date;
}

/** Сколько столбцов в одной строке события. */
const EVENT_COLUMNS = 11;

/**
 * Сколько строк кладём одним запросом.
 *
 * Предел не выдуман: в протоколе Postgres число параметров запроса —
 * ДВУХБАЙТОВОЕ, то есть не больше 65535. При одиннадцати столбцах это
 * 5957 строк, а дальше счётчик переполняется, и сервер отвечает
 * «bind message has 11178 parameter formats but 0 parameters» — сообщение,
 * по которому причину не угадать вовсе.
 *
 * Поймано нагрузкой на стенде: после проворота журнала сборщик разбирал
 * порцию в 2 МБ (около 6500 событий), падал на вставке и НЕ ДВИГАЛ курсор —
 * то есть вставал навсегда, повторяя одну и ту же неудачу каждые пять
 * секунд. История переставала пополняться совсем, и в интерфейсе это
 * выглядело как «на сервере ничего не происходит».
 *
 * Тысяча строк — с большим запасом (11 000 параметров) и по-прежнему
 * один оборот до базы на тысячу событий вместо тысячи оборотов.
 */
const MAX_ROWS_PER_INSERT = 1000;

/**
 * Обезвреживает подстановочные знаки LIKE в том, что набрал человек.
 *
 * Для SQL `%` — это «любые символы», `_` — «любой символ». Адрес и имя
 * ящика их вполне содержат (`ivan_petrov@…`), да и в строке поиска они
 * появляются просто от промаха по клавише. Без экранирования поиск по
 * `ivan_petrov` находил бы ещё и `ivanApetrov`, а поиск по строке с `%`
 * из адресной строки браузера (`%40` вместо `@`) не находил бы ничего —
 * ровно это и случилось на стенде.
 *
 * Обратная косая экранируется первой: иначе она испортила бы уже
 * добавленные нами экраны.
 */
export function likeEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class FlowStore {
  constructor(private readonly db: AdminDb) {}

  /** Применена ли миграция 0007 (без неё истории нет). */
  async schemaReady(): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT to_regclass('public.mail_flow_events') IS NOT NULL AS ok`,
    );
    return row?.ok === true;
  }

  async getCursor(source: string): Promise<FlowCursor | null> {
    const row = await this.db.one<FlowCursorRow>(
      `SELECT source, file_id, byte_offset::text, started_at
         FROM mail_flow_cursor WHERE source = $1`,
      [source],
    );
    if (!row) return null;
    return {
      source: row.source,
      fileId: row.file_id,
      byteOffset: Number(row.byte_offset),
      startedAt: row.started_at,
    };
  }

  async setCursor(source: string, fileId: string, byteOffset: number): Promise<void> {
    await this.db.query(
      `INSERT INTO mail_flow_cursor (source, file_id, byte_offset)
            VALUES ($1, $2, $3)
       ON CONFLICT (source) DO UPDATE
            SET file_id = EXCLUDED.file_id,
                byte_offset = EXCLUDED.byte_offset,
                updated_at = now()`,
      [source, fileId, byteOffset],
    );
  }

  /**
   * Пакетная вставка разобранных событий.
   *
   * Одним запросом на всю порцию, а не построчно: порция после проворота
   * журнала бывает в тысячи строк, и тысяча отдельных вставок — это тысяча
   * оборотов до базы и заметная пауза у всех остальных запросов.
   */
  async insertEvents(events: readonly FlowEventInput[]): Promise<number> {
    if (events.length === 0) return 0;
    // Порциями: одним запросом больше 65535 параметров Postgres не примет
    // (см. MAX_ROWS_PER_INSERT).
    for (let from = 0; from < events.length; from += MAX_ROWS_PER_INSERT) {
      await this.insertBatch(events.slice(from, from + MAX_ROWS_PER_INSERT));
    }
    return events.length;
  }

  private async insertBatch(events: readonly FlowEventInput[]): Promise<void> {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const event of events) {
      const base = values.length;
      const holes = Array.from({ length: EVENT_COLUMNS }, (_, i) => `$${base + i + 1}`);
      tuples.push(`(${holes.join(',')})`);
      values.push(
        event.occurredAt,
        event.queueId,
        event.direction,
        event.status,
        event.sender,
        event.recipient,
        event.relay,
        event.delaySeconds,
        event.sizeBytes,
        event.dsn,
        event.reason,
      );
    }
    await this.db.query(
      `INSERT INTO mail_flow_events
         (occurred_at, queue_id, direction, status, sender, recipient, relay,
          delay_seconds, size_bytes, dsn, reason)
       VALUES ${tuples.join(',')}`,
      values,
    );
  }

  /**
   * Страница истории.
   *
   * Листание идёт КЛЮЧОМ (время и идентификатор последней показанной
   * строки), а не OFFSET. Разница принципиальная: при OFFSET база
   * пересчитывает и выбрасывает всё, что лежит перед страницей, поэтому
   * пятисотая страница обходится в пятьсот раз дороже первой — а ленивая
   * подгрузка ровно из таких страниц и состоит. С ключом каждая страница
   * стоит одинаково, и отдаёт её индекс (occurred_at DESC, id DESC).
   *
   * Второе свойство ключа не менее важное: между подгрузками в таблицу
   * дописываются новые строки. При OFFSET они сдвинули бы окно, и часть
   * записей человек увидел бы дважды, а часть не увидел бы вовсе.
   */
  async listEvents(filters: FlowFilters): Promise<FlowEventRow[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (filters.from) add('occurred_at >= ?', filters.from);
    if (filters.to) add('occurred_at <= ?', filters.to);
    if (filters.statuses && filters.statuses.length > 0) add('status = ANY(?)', filters.statuses);
    if (filters.direction) add('direction = ?', filters.direction);
    if (filters.search) {
      values.push(`%${likeEscape(filters.search.toLowerCase())}%`);
      const p = `$${values.length}`;
      where.push(
        `(lower(coalesce(recipient,'')) LIKE ${p} ESCAPE '\\'` +
          ` OR lower(coalesce(sender,'')) LIKE ${p} ESCAPE '\\')`,
      );
    }
    if (filters.beforeTime && filters.beforeId) {
      values.push(filters.beforeTime, filters.beforeId);
      where.push(`(occurred_at, id) < ($${values.length - 1}, $${values.length}::bigint)`);
    }
    if (filters.afterTime && filters.afterId) {
      values.push(filters.afterTime, filters.afterId);
      where.push(`(occurred_at, id) > ($${values.length - 1}, $${values.length}::bigint)`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    values.push(filters.limit);
    return this.db.query<FlowEventRow>(
      `SELECT id::text, occurred_at, queue_id, direction, status, sender, recipient,
              relay, delay_seconds::text, size_bytes::text, dsn, reason
         FROM mail_flow_events ${whereSql}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${values.length}`,
      values,
    );
  }

  /**
   * Сводка по окну времени и границы имеющихся данных.
   *
   * Счётчики намеренно ограничены окном: `count(*)` по всей таблице на
   * полумиллионе строк — это секунды ожидания на экране, который открывают
   * как раз тогда, когда всё горит.
   */
  async stats(
    from: Date,
    to: Date,
  ): Promise<{
    counts: Record<string, number>;
    total: number;
    oldest: Date | null;
    newest: Date | null;
  }> {
    const rows = await this.db.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
         FROM mail_flow_events
        WHERE occurred_at >= $1 AND occurred_at <= $2
        GROUP BY status`,
      [from, to],
    );
    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      counts[row.status] = Number(row.count);
      total += Number(row.count);
    }
    const edges = await this.db.one<{ oldest: Date | null; newest: Date | null }>(
      `SELECT min(occurred_at) AS oldest, max(occurred_at) AS newest FROM mail_flow_events`,
    );
    return { counts, total, oldest: edges?.oldest ?? null, newest: edges?.newest ?? null };
  }

  /**
   * Вытеснение старой истории: по сроку и по числу строк сразу.
   *
   * Оба предела нужны вместе. Только срок — и ночная рассылка на сто тысяч
   * адресов займёт диск, нужный письмам. Только число строк — и на тихом
   * сервере в таблице окажется «история за три года», в которой давно нет
   * ни одного письма из журнала, то есть обещание, которого никто не даёт.
   */
  async prune(retentionDays: number, maxRows: number): Promise<number> {
    let removed = 0;
    if (retentionDays > 0) {
      const byAge = await this.db.one<{ count: string }>(
        `WITH gone AS (
           DELETE FROM mail_flow_events
                 WHERE occurred_at < now() - ($1 || ' days')::interval
             RETURNING 1
         ) SELECT count(*)::text AS count FROM gone`,
        [String(retentionDays)],
      );
      removed += Number(byAge?.count ?? 0);
    }
    if (maxRows > 0) {
      const byCount = await this.db.one<{ count: string }>(
        `WITH gone AS (
           DELETE FROM mail_flow_events
                 WHERE id IN (
                   SELECT id FROM mail_flow_events
                    ORDER BY occurred_at DESC, id DESC
                    OFFSET $1
                 )
             RETURNING 1
         ) SELECT count(*)::text AS count FROM gone`,
        [maxRows],
      );
      removed += Number(byCount?.count ?? 0);
    }
    return removed;
  }
}
