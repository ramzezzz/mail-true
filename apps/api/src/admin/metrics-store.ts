/**
 * Хранилище снимков показателей и агрегаты дашборда.
 *
 * Отдельным модулем, а не методами AdminDb: admin/db.ts — общий файл про
 * ящики, домены и алиасы, и наблюдение ему ничего не должно. Работает через
 * открытые методы AdminDb (query/one), то есть тем же пулом соединений —
 * второго подключения к базе ради дашборда не заводим.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ АГРЕГАТЫ СЧИТАЕТ БАЗА, А НЕ СЕРВЕР ПРИЛОЖЕНИЯ
 * ------------------------------------------------------------------
 * В mail_flow_events сотни тысяч строк. Вытащить их в память и сложить
 * циклом — значит прогнать через сеть и через кучу V8 десятки мегабайт
 * ради двух десятков чисел. При потолке кучи в 512 МБ (см. NODE_OPTIONS
 * в docker-compose.yml) это ещё и способ уронить сервер приложения одним
 * открытием дашборда.
 *
 * Поэтому всё считается ГРУППИРОВКОЙ на стороне базы, а окно времени
 * сужается индексом. Под эти запросы в миграции 0011_metrics.sql заведён покрывающий
 * индекс idx_mail_flow_agg: агрегат считается по индексу, не заглядывая
 * в таблицу вовсе. Замерено на 300 000 строк, окно шесть часов (75 000
 * строк): 17–19 мс с ним против 34–48 мс без него, Heap Fetches: 0.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ date_bin, А НЕ date_trunc И НЕ АРИФМЕТИКА ПО epoch
 * ------------------------------------------------------------------
 * date_trunc умеет только фиксированные ступени (час, сутки). График за
 * шесть часов с часовой ступенью — это шесть точек, то есть не график.
 * Нужен ЛЮБОЙ шаг, чтобы один и тот же запрос обслуживал и «час», и
 * «неделю».
 *
 * Первый вариант считал корзину как `floor(epoch / шаг) * шаг`. Работает,
 * но каждая строка проходит через extract, деление в NUMERIC, floor,
 * умножение и обратное to_timestamp. Замер на 300 000 строк: 170 мс.
 * date_bin делает то же самое целочисленной арифметикой над меткой
 * времени — 64 мс на тех же данных, то есть в 2,7 раза быстрее.
 *
 * Опорная точка отсчёта задана явно (2000-01-01) и НЕ зависит от «сейчас»:
 * иначе границы корзин ползли бы с каждым запросом, и одна и та же минута
 * попадала бы то в одну корзину, то в соседнюю — график дрожал бы при
 * каждом автообновлении.
 */
import type { AdminDb } from './db.js';
import { diskUsedPercent } from './metrics-disk.js';

/** Одна строка снимка — то, что кладёт сборщик. */
export interface MetricSampleInput {
  cpuNodePercent: number | null;
  cpuApiPercent: number | null;
  load1: number | null;
  memNodeTotal: number | null;
  memNodeUsed: number | null;
  memApiBytes: number | null;
  diskTotal: number | null;
  diskFree: number | null;
  vmailBytes: number | null;
  mailindexBytes: number | null;
  logsBytes: number | null;
  dbBytes: number | null;
  dbIndexBytes: number | null;
  queueTotal: number | null;
  queueDeferred: number | null;
  queueOldestSeconds: number | null;
}

/** Точка ряда после прореживания. */
export interface MetricPoint {
  at: string;
  cpuNodePercent: number | null;
  cpuApiPercent: number | null;
  load1: number | null;
  memUsedPercent: number | null;
  memApiBytes: number | null;
  diskUsedPercent: number | null;
  vmailBytes: number | null;
  dbBytes: number | null;
  queueTotal: number | null;
  queueDeferred: number | null;
  queueOldestSeconds: number | null;
}

/** Сколько точек рисуем на графике при любом окне. */
export const TARGET_POINTS = 120;

/**
 * Шаг корзины под запрошенное окно.
 *
 * Точек всегда примерно TARGET_POINTS, каким бы ни было окно. Причина не в
 * красоте: линия из 10 000 точек — это 10 000 узлов в SVG, которые браузер
 * честно разложит и отрисует, а глаз всё равно не различит соседние точки
 * шириной в треть пикселя. Прореживание делает база — там оно стоит одного
 * прохода по индексу, а не пересылки всех строк.
 *
 * Шаг не меньше шага съёмки: усреднять то, чего не измеряли, бессмысленно.
 */
export function bucketSeconds(windowSeconds: number, minStep = 60): number {
  const raw = Math.ceil(windowSeconds / TARGET_POINTS);
  return Math.max(minStep, raw);
}

interface SampleRow {
  bucket: Date;
  cpu_node: string | null;
  cpu_api: string | null;
  load1: string | null;
  mem_total: string | null;
  mem_used: string | null;
  mem_api: string | null;
  disk_total: string | null;
  disk_free: string | null;
  vmail: string | null;
  db_bytes: string | null;
  queue_total: string | null;
  queue_deferred: string | null;
  queue_oldest: string | null;
}

const num = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Агрегат почтового потока в одной корзине времени. */
export interface FlowBucket {
  at: string;
  counts: Record<string, number>;
}

/** Сводка размеров писем за окно. */
export interface SizeSummary {
  messages: number;
  totalBytes: number;
  avgBytes: number | null;
  medianBytes: number | null;
  maxBytes: number | null;
}

/** Строка таблицы «кто сколько отправил и получил». */
export interface UserTrafficRow {
  id: number;
  email: string;
  active: boolean;
  quotaBytes: number;
  sentMessages: number;
  sentBytes: number;
  receivedMessages: number;
  receivedBytes: number;
}

export type UserTrafficSort =
  | 'sentMessages'
  | 'sentBytes'
  | 'receivedMessages'
  | 'receivedBytes'
  | 'totalMessages'
  | 'totalBytes';

const SORT_SQL: Readonly<Record<UserTrafficSort, string>> = {
  sentMessages: 'sent_messages',
  sentBytes: 'sent_bytes',
  receivedMessages: 'recv_messages',
  receivedBytes: 'recv_bytes',
  totalMessages: '(sent_messages + recv_messages)',
  totalBytes: '(sent_bytes + recv_bytes)',
};

export function isUserTrafficSort(value: unknown): value is UserTrafficSort {
  return typeof value === 'string' && value in SORT_SQL;
}

/**
 * Признак «отбито как спам» — по ТЕКСТУ отказа.
 *
 * Отдельного поля «спам» в журнале Postfix нет: rspamd отвечает обычным
 * отказом SMTP, и единственное, что от него остаётся, — формулировка. Она
 * же попадает в reason. Поэтому доля спама здесь честно называется «по
 * тексту отказа»: это не показания антиспама, а их след в журнале.
 *
 * Регистр не учитываем (~*): формулировки у разных версий rspamd и правил
 * milter отличаются регистром слова Spam.
 */
const SPAM_REASON_SQL = `reason ~* '(spam|rspamd|gtube|blocked using|dnsbl|spamhaus|barracuda)'`;

export class MetricsStore {
  constructor(private readonly db: AdminDb) {}

  /**
   * Применена ли миграция 0011_metrics.sql (без неё истории показателей нет).
   *
   * Номер здесь и в тексте для человека (routes/overview.ts) обязан быть
   * ОДИН. Раньше здесь стояло «0010», в панели — «миграция 0010», а файл
   * называется 0011_metrics.sql: администратор получал имя файла, которого
   * нет, и искал его в install/.
   */
  async schemaReady(): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT to_regclass('public.server_metric_samples') IS NOT NULL AS ok`,
    );
    return row?.ok === true;
  }

  /**
   * Применена ли миграция 0007_mail_flow.sql — та, где живёт разобранный
   * почтовый журнал.
   *
   * Проверка отдельная от schemaReady: таблицы приезжают РАЗНЫМИ миграциями,
   * и раздел «Почтовый поток» дашборда без 0007 падал сырой ошибкой SQL,
   * то есть «Внутренняя ошибка сервера» на весь экран, — при том что
   * соседний график ресурсов в такой же ситуации честно объясняет, чего
   * не хватает.
   */
  async flowSchemaReady(): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT to_regclass('public.mail_flow_events') IS NOT NULL AS ok`,
    );
    return row?.ok === true;
  }

  async insertSample(sample: MetricSampleInput): Promise<void> {
    await this.db.query(
      `INSERT INTO server_metric_samples
         (cpu_node_percent, cpu_api_percent, load1, mem_node_total, mem_node_used,
          mem_api_bytes, disk_total, disk_free, vmail_bytes, mailindex_bytes,
          logs_bytes, db_bytes, db_index_bytes, queue_total, queue_deferred,
          queue_oldest_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        sample.cpuNodePercent,
        sample.cpuApiPercent,
        sample.load1,
        sample.memNodeTotal,
        sample.memNodeUsed,
        sample.memApiBytes,
        sample.diskTotal,
        sample.diskFree,
        sample.vmailBytes,
        sample.mailindexBytes,
        sample.logsBytes,
        sample.dbBytes,
        sample.dbIndexBytes,
        sample.queueTotal,
        sample.queueDeferred,
        sample.queueOldestSeconds,
      ],
    );
  }

  /**
   * Ряд показателей за окно, прореженный до TARGET_POINTS точек.
   *
   * Занятость памяти и диска отдаём процентами, а не парой «всего/занято»:
   * объём памяти узла за окно не меняется, и таскать его в каждой точке —
   * это лишние килобайты в ответе на ровном месте. Абсолютные величины
   * отдаются отдельно, текущим состоянием.
   */
  async history(fromIso: Date, toIso: Date, step: number): Promise<MetricPoint[]> {
    const rows = await this.db.query<SampleRow>(
      `SELECT date_bin(make_interval(secs => $3), taken_at, TIMESTAMPTZ '2000-01-01') AS bucket,
              avg(cpu_node_percent)::text  AS cpu_node,
              avg(cpu_api_percent)::text   AS cpu_api,
              avg(load1)::text             AS load1,
              max(mem_node_total)::text    AS mem_total,
              avg(mem_node_used)::text     AS mem_used,
              avg(mem_api_bytes)::text     AS mem_api,
              max(disk_total)::text        AS disk_total,
              avg(disk_free)::text         AS disk_free,
              avg(vmail_bytes)::text       AS vmail,
              avg(db_bytes)::text          AS db_bytes,
              -- Очередь усредняем, но возраст самого старого письма берём
              -- МАКСИМУМОМ: среднее сгладило бы ровно тот всплеск, ради
              -- которого этот показатель и нужен.
              avg(queue_total)::text       AS queue_total,
              avg(queue_deferred)::text    AS queue_deferred,
              max(queue_oldest_seconds)::text AS queue_oldest
         FROM server_metric_samples
        WHERE taken_at >= $1 AND taken_at <= $2
        GROUP BY 1
        ORDER BY 1`,
      [fromIso, toIso, step],
    );
    return rows.map((row) => {
      const memTotal = num(row.mem_total);
      const memUsed = num(row.mem_used);
      const diskTotal = num(row.disk_total);
      const diskFree = num(row.disk_free);
      return {
        at: row.bucket.toISOString(),
        cpuNodePercent: round2(num(row.cpu_node)),
        cpuApiPercent: round2(num(row.cpu_api)),
        load1: round2(num(row.load1)),
        memUsedPercent:
          memTotal && memUsed !== null && memTotal > 0 ? round2((memUsed / memTotal) * 100) : null,
        memApiBytes: roundInt(num(row.mem_api)),
        // Формула общая с разделом «Наблюдение» (см. diskUsedPercent в
        // metrics-disk.ts): считать занятость двумя способами значило
        // показывать один и тот же диск на 5 % полнее в одном месте, чем
        // в другом, — ровно на резерв root.
        diskUsedPercent: round2(diskUsedPercent(diskTotal, diskFree)),
        vmailBytes: roundInt(num(row.vmail)),
        dbBytes: roundInt(num(row.db_bytes)),
        queueTotal: roundInt(num(row.queue_total)),
        queueDeferred: roundInt(num(row.queue_deferred)),
        queueOldestSeconds: roundInt(num(row.queue_oldest)),
      };
    });
  }

  /**
   * Вытеснение старых снимков: по сроку и по числу строк сразу.
   *
   * Оба предела нужны вместе, ровно по тем же причинам, что у истории
   * доставки (см. flow-store.ts): один только срок не защищает от учащённой
   * съёмки, одно только число строк обещает «историю за год» там, где её
   * нет.
   */
  async prune(retentionDays: number, maxRows: number): Promise<number> {
    let removed = 0;
    if (retentionDays > 0) {
      const byAge = await this.db.one<{ count: string }>(
        `WITH gone AS (
           DELETE FROM server_metric_samples
                 WHERE taken_at < now() - ($1 || ' days')::interval
             RETURNING 1
         ) SELECT count(*)::text AS count FROM gone`,
        [String(retentionDays)],
      );
      removed += Number(byAge?.count ?? 0);
    }
    if (maxRows > 0) {
      const byCount = await this.db.one<{ count: string }>(
        `WITH gone AS (
           DELETE FROM server_metric_samples
                 WHERE id IN (
                   SELECT id FROM server_metric_samples ORDER BY taken_at DESC OFFSET $1
                 )
             RETURNING 1
         ) SELECT count(*)::text AS count FROM gone`,
        [maxRows],
      );
      removed += Number(byCount?.count ?? 0);
    }
    return removed;
  }

  /* ---------------------------------------------------------------- */
  /* Размеры базы                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Сколько занимает база и её индексы.
   *
   * Это единственный разрез диска, который берётся НЕ с файловой системы:
   * каталог Postgres в контейнер api не смонтирован, зато сама база про
   * свой размер знает и отвечает мгновенно.
   */
  async databaseSize(): Promise<{
    totalBytes: number;
    indexBytes: number;
    tables: Array<{ name: string; bytes: number }>;
  }> {
    const row = await this.db.one<{ total: string; indexes: string }>(
      `SELECT pg_database_size(current_database())::text AS total,
              (SELECT coalesce(sum(pg_indexes_size(c.oid)), 0)
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'm')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema'))::text AS indexes`,
    );
    // Крупнейшие таблицы: когда база неожиданно раздулась, вопрос всегда
    // «какая именно», и десяти строк на него хватает.
    const tables = await this.db.query<{ name: string; bytes: string }>(
      `SELECT n.nspname || '.' || c.relname AS name,
              pg_total_relation_size(c.oid)::text AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'm')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 10`,
    );
    return {
      totalBytes: Number(row?.total ?? 0),
      indexBytes: Number(row?.indexes ?? 0),
      tables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes) })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Агрегаты почтового потока                                         */
  /* ---------------------------------------------------------------- */

  /** Поток во времени: по корзинам и состояниям. */
  async flowByBucket(from: Date, to: Date, step: number): Promise<FlowBucket[]> {
    const rows = await this.db.query<{ bucket: Date; status: string; count: string }>(
      `SELECT date_bin(make_interval(secs => $3), occurred_at, TIMESTAMPTZ '2000-01-01') AS bucket,
              status, count(*)::text AS count
         FROM mail_flow_events
        WHERE occurred_at >= $1 AND occurred_at <= $2
        GROUP BY 1, 2
        ORDER BY 1`,
      [from, to, step],
    );
    const byBucket = new Map<string, FlowBucket>();
    for (const row of rows) {
      const at = row.bucket.toISOString();
      let bucket = byBucket.get(at);
      if (!bucket) {
        bucket = { at, counts: {} };
        byBucket.set(at, bucket);
      }
      bucket.counts[row.status] = Number(row.count);
    }
    return [...byBucket.values()];
  }

  /** Сколько чего за окно: по состояниям, по направлениям и по письмам. */
  async flowTotals(
    from: Date,
    to: Date,
  ): Promise<{
    byStatus: Record<string, number>;
    byDirection: Record<string, number>;
    spamRejected: number;
    /** Различных писем за окно — знаменатель доли спама, см. ниже. */
    messages: number;
  }> {
    const rows = await this.db.query<{ status: string; direction: string; count: string }>(
      `SELECT status, direction, count(*)::text AS count
         FROM mail_flow_events
        WHERE occurred_at >= $1 AND occurred_at <= $2
        GROUP BY 1, 2`,
      [from, to],
    );
    const byStatus: Record<string, number> = {};
    const byDirection: Record<string, number> = {};
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + Number(row.count);
      byDirection[row.direction] = (byDirection[row.direction] ?? 0) + Number(row.count);
    }
    /*
     * Спам — ОТДЕЛЬНЫМ запросом, хотя соблазн посчитать его тут же,
     * отбором внутри count(*) FILTER, велик: это сэкономило бы один проход.
     *
     * Так делать нельзя. Текста отказа (reason) нет в покрывающем индексе
     * idx_mail_flow_agg, и стоит добавить его в условие — запрос выше
     * перестаёт считаться по индексу и лезет в таблицу за каждой строкой.
     * То есть экономия одного прохода покупается потерей Index Only Scan
     * на ГЛАВНОМ запросе раздела, который выполняется всегда.
     *
     * Отдельный же запрос сужается по idx_mail_flow_status до одних
     * отбитых: на 300 000 строк это 37 000 строк и 39 мс.
     */
    const spam = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM mail_flow_events
        WHERE occurred_at >= $1 AND occurred_at <= $2
          AND status = 'rejected' AND ${SPAM_REASON_SQL}`,
      [from, to],
    );

    /*
     * РАЗЛИЧНЫЕ ПИСЬМА — знаменатель доли спама.
     *
     * ------------------------------------------------------------------
     * ПОЧЕМУ НЕ count(*) ПО ВСЕМ СТРОКАМ
     * ------------------------------------------------------------------
     * Строка таблицы — это ПОПЫТКА доставки, а не письмо. Письмо, которое
     * чужой сервер отложил трижды, оставляет четыре строки (три `deferred`
     * и одну `sent`), и в знаменателе оно считалось за четыре письма.
     * Отбитый спам при этом попыток не имеет вовсе: отказ на приёме
     * случается один раз и повториться не может.
     *
     * То есть знаменатель рос от чужих неполадок связи, а числитель — нет,
     * и доля спама тем сильнее занижалась, чем хуже работала сеть. На
     * живом стенде это давало 6,7 % вместо 20,0 % — то есть говорило
     * «спама почти нет» ровно в тот день, когда его была пятая часть.
     *
     * Письмо здесь — это (очередь, адресат): одна очередь на трёх адресатов
     * — три доставки, и складывать их в одну нельзя, иначе исчезнут два
     * настоящих письма. У отказа на приёме очереди нет (NOQUEUE), поэтому
     * каждая такая строка — своё письмо, что и есть правда.
     */
    const messages = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM (
           SELECT DISTINCT coalesce(queue_id, '#' || id::text) AS envelope, recipient
             FROM mail_flow_events
            WHERE occurred_at >= $1 AND occurred_at <= $2
         ) t`,
      [from, to],
    );
    return {
      byStatus,
      byDirection,
      spamRejected: Number(spam?.count ?? 0),
      messages: Number(messages?.count ?? 0),
    };
  }

  /**
   * Главные причины отбраковки и отсрочки.
   *
   * Текст отказа группируется НЕ дословно: в нём стоят адреса, номера в
   * очереди и имена узлов, из-за которых каждая строка уникальна и никакого
   * «топа причин» не получается вовсе — выходит список из тысячи причин по
   * одному разу. Поэтому переменные части заменяются заглушками прямо в
   * запросе (regexp_replace), и одинаковые по сути отказы сходятся в одну
   * строку.
   */
  async topReasons(
    from: Date,
    to: Date,
    statuses: readonly string[],
    limit = 8,
  ): Promise<Array<{ reason: string; count: number }>> {
    const rows = await this.db.query<{ reason: string; count: string }>(
      `SELECT left(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(coalesce(reason, 'причина не записана'),
                                   '<[^>]*>', '<адрес>', 'g'),
                    '[0-9]{1,3}(\\.[0-9]{1,3}){3}', 'IP', 'g'),
                  '[0-9]{4,}', 'N', 'g'),
                90) AS reason,
              count(*)::text AS count
         FROM mail_flow_events
        WHERE occurred_at >= $1 AND occurred_at <= $2 AND status = ANY($3)
        GROUP BY 1
        ORDER BY count(*) DESC
        LIMIT $4`,
      [from, to, statuses, limit],
    );
    return rows.map((r) => ({ reason: r.reason, count: Number(r.count) }));
  }

  /**
   * Размеры писем за окно.
   *
   * Среднее СЧИТАЕТСЯ ВМЕСТЕ С МЕДИАНОЙ намеренно. Одно письмо с вложением
   * на 20 МБ среди тысячи писем по 5 КБ поднимает среднее в четыре раза, и
   * администратор, глядя на среднее, будет планировать диск не под ту
   * нагрузку. Медиана показывает типичное письмо, среднее — расход места.
   * Расхождение между ними само по себе полезный сигнал.
   *
   * Считаем по РАЗЛИЧНЫМ письмам (queue_id), а не по строкам: письмо на
   * трёх адресатов даёт три строки одинакового размера, и по строкам его
   * объём утроился бы.
   */
  async sizeSummary(from: Date, to: Date): Promise<SizeSummary> {
    const row = await this.db.one<{
      messages: string;
      total: string;
      avg: string | null;
      median: string | null;
      max: string | null;
    }>(
      `WITH msg AS (
         SELECT DISTINCT ON (queue_id) queue_id, size_bytes
           FROM mail_flow_events
          WHERE occurred_at >= $1 AND occurred_at <= $2
            AND queue_id IS NOT NULL AND size_bytes IS NOT NULL AND size_bytes > 0
          ORDER BY queue_id, id
       )
       SELECT count(*)::text AS messages,
              coalesce(sum(size_bytes), 0)::text AS total,
              avg(size_bytes)::text AS avg,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY size_bytes)::text AS median,
              max(size_bytes)::text AS max
         FROM msg`,
      [from, to],
    );
    return {
      messages: Number(row?.messages ?? 0),
      totalBytes: Number(row?.total ?? 0),
      avgBytes: roundInt(num(row?.avg ?? null)),
      medianBytes: roundInt(num(row?.median ?? null)),
      maxBytes: roundInt(num(row?.max ?? null)),
    };
  }

  /**
   * Пиковые часы: сколько писем приходится на каждый час суток.
   *
   * ------------------------------------------------------------------
   * ЧАС — В ПОЯСЕ СМОТРЯЩЕГО, А НЕ СЕРВЕРА
   * ------------------------------------------------------------------
   * Раньше час брался «в поясе сервера»: `extract(hour FROM occurred_at)`
   * без указания пояса считает его по TimeZone сеанса, а у контейнера это
   * UTC. Соседний график того же экрана («Что происходило с письмами»)
   * подписан временем БРАУЗЕРА. То есть на одной странице два графика об
   * одних и тех же письмах жили в разных поясах: в Москве вечерний пик
   * рассылки стоял в 09 на одном и в 12 на другом, и «пиковый час»
   * приходилось пересчитывать в уме — а обслуживание планируют как раз
   * по нему.
   *
   * Пояс приходит от браузера (IANA-имя вроде Europe/Moscow) и уходит
   * прямо в `AT TIME ZONE`: Postgres знает и переходы на летнее время, и
   * их историю, а вычитание постоянного смещения — нет.
   *
   * Имя проверяется по pg_timezone_names ДО запроса. Не ради обхода
   * подстановки (значение и так уходит параметром), а ради ответа:
   * неизвестное имя иначе роняло бы весь раздел ошибкой SQL, тогда как
   * правильное поведение — показать часы по UTC и сказать об этом.
   *
   * Возвращается и пояс, в котором посчитано: подпись «часы по Europe/Moscow»
   * — единственное, что отличает верный график от сдвинутого на три часа.
   */
  async hourlyProfile(
    from: Date,
    to: Date,
    timeZone?: string | undefined,
  ): Promise<{ timeZone: string; hours: Array<{ hour: number; count: number }> }> {
    const zone = (await this.resolveTimeZone(timeZone)) ?? 'UTC';
    const rows = await this.db.query<{ hour: string; count: string }>(
      `SELECT extract(hour FROM occurred_at AT TIME ZONE $3)::int::text AS hour,
              count(*)::text AS count
         FROM mail_flow_events
        WHERE occurred_at >= $1 AND occurred_at <= $2
        GROUP BY 1
        ORDER BY 1`,
      [from, to, zone],
    );
    const byHour = new Map<number, number>();
    for (const row of rows) byHour.set(Number(row.hour), Number(row.count));
    return {
      timeZone: zone,
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: byHour.get(hour) ?? 0 })),
    };
  }

  /**
   * Знает ли Postgres такой пояс. null — не знает (или его не прислали).
   *
   * Список поясов у Postgres свой (pg_timezone_names) и от списка браузера
   * отличается: устаревшие имена вроде «Asia/Calcutta» браузер шлёт, а
   * сборка Postgres может не знать. Спросить дешевле, чем ловить ошибку
   * запроса, который к тому же считает весь раздел.
   */
  private async resolveTimeZone(name: string | undefined): Promise<string | null> {
    if (name === undefined || name === '' || name.length > 64) return null;
    // Форма имени проверяется до похода в базу: остальное отсекает сам
    // список поясов, но гонять в него мусор незачем.
    if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/u.test(name)) return null;
    const row = await this.db
      .one<{ name: string }>(`SELECT name FROM pg_timezone_names WHERE name = $1`, [name])
      .catch(() => null);
    return row?.name ?? null;
  }

  /**
   * Кто сколько отправил и получил за окно.
   *
   * ОТПРАВЛЕНО считается по РАЗЛИЧНЫМ письмам: письмо на трёх адресатов —
   * это одно отправленное письмо, а не три. ПОЛУЧЕНО — по строкам: там
   * строка и есть «письмо, доставленное в этот ящик».
   *
   * Список строится ОТ ЯЩИКОВ (virtual_users), а не от адресов в журнале.
   * Разница существенная: в журнале полно чужих адресов (внешние
   * отправители, отбойники, рассылки), и «статистика по пользователям», в
   * которой первым идёт noreply@чужой-домен, отвечает не на тот вопрос.
   * Заодно так в таблице видны и МОЛЧАЩИЕ ящики — с нулями, а не отсутствием
   * строки; именно они и нужны, когда спрашивают «кто не пользуется».
   */
  async userTraffic(
    from: Date,
    to: Date,
    sort: UserTrafficSort,
    limit: number,
    offset = 0,
  ): Promise<{ rows: UserTrafficRow[]; total: number; silent: number }> {
    const order = SORT_SQL[sort];
    const rows = await this.db.query<{
      id: number;
      email: string;
      active: boolean;
      quota_bytes: string;
      sent_messages: string;
      sent_bytes: string;
      recv_messages: string;
      recv_bytes: string;
      total_count: string;
      silent_count: string;
    }>(
      `WITH sent AS (
         SELECT addr, count(*)::bigint AS messages, coalesce(sum(size_bytes), 0)::bigint AS bytes
           FROM (
             SELECT DISTINCT ON (queue_id) lower(sender) AS addr, size_bytes
               FROM mail_flow_events
              WHERE occurred_at >= $1 AND occurred_at <= $2
                AND status = 'sent' AND queue_id IS NOT NULL
                AND sender IS NOT NULL AND sender <> ''
              ORDER BY queue_id, id
           ) s
          GROUP BY addr
       ), received AS (
         SELECT lower(recipient) AS addr, count(*)::bigint AS messages,
                coalesce(sum(size_bytes), 0)::bigint AS bytes
           FROM mail_flow_events
          WHERE occurred_at >= $1 AND occurred_at <= $2
            AND status = 'sent' AND direction = 'in'
            AND recipient IS NOT NULL AND recipient <> ''
          GROUP BY 1
       ), joined AS (
         SELECT u.id, u.email, u.active, u.quota_bytes,
                coalesce(s.messages, 0) AS sent_messages,
                coalesce(s.bytes, 0)    AS sent_bytes,
                coalesce(r.messages, 0) AS recv_messages,
                coalesce(r.bytes, 0)    AS recv_bytes
           FROM virtual_users u
           LEFT JOIN sent s     ON s.addr = lower(u.email)
           LEFT JOIN received r ON r.addr = lower(u.email)
       )
       SELECT id, email, active, quota_bytes::text,
              sent_messages::text, sent_bytes::text,
              recv_messages::text, recv_bytes::text,
              count(*) OVER ()::text AS total_count,
              -- Молчавшие считаются ЗДЕСЬ, по всем ящикам, а не по
              -- отданной странице. Панель считала их сама по 25 строкам,
              -- отсортированным по трафику убыванию: молчащие стоят в
              -- хвосте и в первую страницу не попадают никогда, поэтому
              -- подпись под таблицей на сервере со 143 ящиками честно
              -- сообщала «Молчали за период: 0».
              count(*) FILTER (
                WHERE sent_messages = 0 AND recv_messages = 0
              ) OVER ()::text AS silent_count
         FROM joined
        ORDER BY ${order} DESC, email ASC
        LIMIT $3 OFFSET $4`,
      [from, to, limit, offset],
    );
    return {
      rows: rows.map((r) => ({
        id: r.id,
        email: r.email,
        active: r.active,
        quotaBytes: Number(r.quota_bytes),
        sentMessages: Number(r.sent_messages),
        sentBytes: Number(r.sent_bytes),
        receivedMessages: Number(r.recv_messages),
        receivedBytes: Number(r.recv_bytes),
      })),
      total: Number(rows[0]?.total_count ?? 0),
      silent: Number(rows[0]?.silent_count ?? 0),
    };
  }

  /**
   * Сколько ящиков подавало признаки жизни за окно.
   *
   * «Активен» здесь означает «за окно был хотя бы один отправленный или
   * полученный конверт», а не «заходил в почту»: журнал Postfix про входы
   * ничего не знает. Названо на экране именно так, чтобы число не читали
   * как посещаемость.
   */
  async activityCounts(from: Date, to: Date): Promise<{ total: number; active: number }> {
    const row = await this.db.one<{ total: string; active: string }>(
      `WITH touched AS (
         SELECT DISTINCT lower(sender) AS addr
           FROM mail_flow_events
          WHERE occurred_at >= $1 AND occurred_at <= $2 AND sender IS NOT NULL
         UNION
         SELECT DISTINCT lower(recipient)
           FROM mail_flow_events
          WHERE occurred_at >= $1 AND occurred_at <= $2 AND recipient IS NOT NULL
       )
       SELECT (SELECT count(*) FROM virtual_users)::text AS total,
              (SELECT count(*) FROM virtual_users u
                WHERE lower(u.email) IN (SELECT addr FROM touched))::text AS active`,
      [from, to],
    );
    return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0) };
  }

  /** Границы имеющейся истории: с какого момента вообще есть данные. */
  async flowEdges(): Promise<{ oldest: string | null; newest: string | null }> {
    const row = await this.db.one<{ oldest: Date | null; newest: Date | null }>(
      `SELECT min(occurred_at) AS oldest, max(occurred_at) AS newest FROM mail_flow_events`,
    );
    return {
      oldest: row?.oldest?.toISOString() ?? null,
      newest: row?.newest?.toISOString() ?? null,
    };
  }
}

function round2(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function roundInt(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
