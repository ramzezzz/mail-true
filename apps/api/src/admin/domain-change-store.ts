/**
 * Смена домена: всё, что делается в базе.
 *
 * Два разных занятия под одной крышей — и это намеренно:
 *
 *   ПОСЧИТАТЬ  — сколько ящиков, алиасов и строк переедет, что мешает
 *                начать. Ни одного изменения; отсюда берётся план.
 *   ПЕРЕПИСАТЬ — одна транзакция, в которой адреса меняют домен.
 *
 * Обе половины ходят по ОДНОМУ реестру колонок (domain-change.ts). Это не
 * из любви к симметрии: план, который считает по одному списку, а
 * выполнение — по другому, однажды разойдётся, и человек увидит «переедет
 * двенадцать таблиц», а переедет одиннадцать. Реестр один, и его же
 * печатает интерфейс.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ АДРЕС РЕЖЕТСЯ ПО ХВОСТУ, А НЕ LIKE И НЕ РЕГУЛЯРНЫМ ВЫРАЖЕНИЕМ
 * ------------------------------------------------------------------
 * Домен приходит значением параметра. В LIKE значение параметра — это ещё
 * и шаблон, где «_» означает «любой символ», а в регулярном выражении
 * точка означает то же самое. В доменных именах подчёркиваний не бывает,
 * а точки бывают всегда — то есть `email ~ '@mail.local$'` совпал бы и с
 * `mailXlocal`. Сравнение хвоста строки (`right(email, N) = '@домен'`)
 * не имеет шаблонов вовсе: параметр остаётся значением при любом его
 * содержимом.
 */
import type { PoolClient } from 'pg';
import type { AdminDb } from './db.js';
import {
  FREE_TEXT_PLACES,
  OWNER_ADDRESS_COLUMNS,
  normalizeDomain,
  type DomainChangeBlocker,
  type TableMove,
} from './domain-change.js';

/* ================================================================== */
/* Кусочки SQL                                                        */
/* ================================================================== */

/** Условие «адрес в домене». Параметры: $1 = «@домен», $2 = его длина. */
function inDomain(column: string): string {
  return `${column} IS NOT NULL AND lower(right(${column}, $2)) = $1`;
}

/**
 * Выражение «тот же адрес в другом домене».
 * Параметры: $3 = длина исходного домена (без «@»), $4 = целевой домен.
 */
function toDomain(column: string): string {
  return `left(${column}, length(${column}) - $3) || $4`;
}

/** Аргументы для inDomain: [«@домен», длина]. */
function inDomainArgs(domain: string): [string, number] {
  const d = normalizeDomain(domain);
  return [`@${d}`, d.length + 1];
}

/** Аргументы для inDomain + toDomain: [«@из», длина, длина из, в]. */
function rewriteArgs(from: string, to: string): [string, number, number, string] {
  const f = normalizeDomain(from);
  return [`@${f}`, f.length + 1, f.length, normalizeDomain(to)];
}

/**
 * Какие из таблиц реестра вообще есть в этой базе.
 *
 * Проверка обязательна и не сводится к «миграции применены»: разделы
 * продукта включаются миграциями по одной, и сервер, где не применяли
 * 0028, живёт без `disposable_aliases` совершенно законно. Внутри
 * транзакции ошибка «нет такой таблицы» откатила бы ВСЮ смену домена —
 * поэтому список существующих таблиц выясняется заранее, одним запросом.
 */
async function existingTables(db: AdminDb, names: readonly string[]): Promise<Set<string>> {
  const rows = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[...new Set(names)]],
  );
  return new Set(rows.map((r) => r.table_name));
}

function isUndefinedColumnError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42703';
}

/* ================================================================== */
/* Подсчёт для плана                                                  */
/* ================================================================== */

/** Сколько строк с адресом этого домена в каждой таблице реестра. */
export async function countAddressRows(db: AdminDb, domain: string): Promise<TableMove[]> {
  const present = await existingTables(
    db,
    OWNER_ADDRESS_COLUMNS.map((c) => c.table),
  );
  const args = inDomainArgs(domain);
  const out: TableMove[] = [];
  for (const col of OWNER_ADDRESS_COLUMNS) {
    if (!present.has(col.table)) continue;
    try {
      const row = await db.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${col.table}" WHERE ${inDomain(`"${col.column}"`)}`,
        args,
      );
      const rows = Number(row?.n ?? 0);
      if (rows > 0) out.push({ ...col, rows });
    } catch (err) {
      // Колонки может не быть, если раздел на этом сервере старой версии.
      // Ноль честнее исключения: план не должен падать из-за того, чего нет.
      if (!isUndefinedColumnError(err)) throw err;
    }
  }
  return out;
}

/** В скольких текстах (подписи, шаблоны, автоответы) встречается старый домен. */
export async function countFreeTextHits(
  db: AdminDb,
  domain: string,
): Promise<{ what: string; rows: number }[]> {
  const present = await existingTables(
    db,
    FREE_TEXT_PLACES.map((p) => p.table),
  );
  const needle = `%@${normalizeDomain(domain)}%`;
  const out: { what: string; rows: number }[] = [];
  for (const place of FREE_TEXT_PLACES) {
    if (!present.has(place.table)) continue;
    try {
      const row = await db.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${place.table}" WHERE "${place.column}" ILIKE $1`,
        [needle],
      );
      const rows = Number(row?.n ?? 0);
      if (rows > 0) out.push({ what: place.what, rows });
    } catch (err) {
      if (!isUndefinedColumnError(err)) throw err;
    }
  }
  return out;
}

export interface DomainCounts {
  domainId: number | null;
  mailboxes: number;
  aliases: number;
  disposableAliases: number;
  /** Фильтры, в условиях или действиях которых встречается старый домен. */
  filters: number;
}

/** Ящики, алиасы и прочие объекты домена. */
export async function countDomainObjects(db: AdminDb, domain: string): Promise<DomainCounts> {
  const row = await db.one<{ id: number; users: string; aliases: string }>(
    `SELECT d.id,
            (SELECT count(*) FROM virtual_users u   WHERE u.domain_id = d.id)::text AS users,
            (SELECT count(*) FROM virtual_aliases a WHERE a.domain_id = d.id)::text AS aliases
       FROM virtual_domains d
      WHERE lower(d.name) = lower($1)`,
    [domain],
  );
  const disposable = await countOrNull(
    db,
    `SELECT count(*)::text AS n
       FROM disposable_aliases da
       JOIN virtual_aliases a ON a.id = da.alias_id
       JOIN virtual_domains d ON d.id = a.domain_id
      WHERE lower(d.name) = lower($1)`,
    [domain],
  );
  const filters = await countOrNull(
    db,
    `SELECT count(*)::text AS n FROM mail_filters
      WHERE conditions::text ILIKE $1 OR actions::text ILIKE $1`,
    [`%@${normalizeDomain(domain)}%`],
  );
  return {
    domainId: row?.id ?? null,
    mailboxes: Number(row?.users ?? 0),
    aliases: Number(row?.aliases ?? 0),
    disposableAliases: disposable ?? 0,
    filters: filters ?? 0,
  };
}

/** count(*) или null, если таблицы нет (раздел не установлен). */
async function countOrNull(db: AdminDb, sql: string, args: unknown[] = []): Promise<number | null> {
  try {
    const row = await db.one<{ n: string }>(sql, args);
    return Number(row?.n ?? 0);
  } catch {
    return null;
  }
}

/* ================================================================== */
/* Препятствия                                                        */
/* ================================================================== */

/**
 * Почему нельзя начинать.
 *
 * Не «предупреждения», а именно отказ. Каждое из этих условий означает,
 * что прямо сейчас кто-то другой пишет в те же ящики, которые мы
 * собираемся переименовать: перенос почты с чужого сервера кладёт письма
 * по СТАРОМУ адресу, выгрузка ящика читает старый каталог. Дать им
 * доработать — минуты; разбирать потом полуперенесённый ящик — часы.
 */
export async function collectBlockers(
  db: AdminDb,
  oldDomain: string,
  newDomain: string,
): Promise<DomainChangeBlocker[]> {
  const blockers: DomainChangeBlocker[] = [];
  const nd = normalizeDomain(newDomain);
  const args = inDomainArgs(nd);

  /* --- новый домен должен быть свободен ---------------------------- */

  const taken = await db.one<{ id: number }>(
    `SELECT id FROM virtual_domains WHERE lower(name) = $1`,
    [nd],
  );
  if (taken) {
    blockers.push({
      id: 'domain-taken',
      message: `Домен ${nd} уже заведён на этом сервере.`,
      fix:
        'Смена домена заводит новый домен сама. Если этот домен здесь уже обслуживается — ' +
        'выберите другое имя или уберите существующий домен в разделе «Домены».',
    });
  }

  const users = await db.one<{ n: string; sample: string | null }>(
    `SELECT count(*)::text AS n, min(email) AS sample
       FROM virtual_users WHERE ${inDomain('email')}`,
    args,
  );
  if (Number(users?.n ?? 0) > 0) {
    blockers.push({
      id: 'mailboxes-in-new-domain',
      message:
        `В базе уже есть ${String(users?.n)} ящик(ов) с адресом в домене ${nd} ` +
        `(например ${users?.sample ?? ''}).`,
      fix: 'Переезд перезаписал бы их. Удалите или переименуйте эти ящики и повторите.',
    });
  }

  const aliases = await db.one<{ n: string; sample: string | null }>(
    `SELECT count(*)::text AS n, min(source) AS sample
       FROM virtual_aliases WHERE ${inDomain('source')}`,
    args,
  );
  if (Number(aliases?.n ?? 0) > 0) {
    blockers.push({
      id: 'aliases-in-new-domain',
      message:
        `В базе уже есть ${String(aliases?.n)} алиас(ов) с адресом в домене ${nd} ` +
        `(например ${aliases?.sample ?? ''}).`,
      fix: 'Переезд столкнулся бы с ними. Удалите их в разделе «Алиасы» и повторите.',
    });
  }

  /* --- старый домен должен существовать ---------------------------- */

  const source = await db.one<{ id: number }>(
    `SELECT id FROM virtual_domains WHERE lower(name) = lower($1)`,
    [oldDomain],
  );
  if (!source) {
    blockers.push({
      id: 'old-domain-missing',
      message: `Домен ${normalizeDomain(oldDomain)} в базе не найден — переносить нечего.`,
      fix:
        'Похоже, основной домен сервера и домены в базе разошлись. Проверьте раздел «Домены» ' +
        'и настройку MAIL_DOMAIN.',
    });
  }

  blockers.push(...(await liveJobBlockers(db)));
  return blockers;
}

/** Идущие прямо сейчас переносы, выгрузки и импорты. Проверяется дважды. */
export async function liveJobBlockers(db: AdminDb): Promise<DomainChangeBlocker[]> {
  const blockers: DomainChangeBlocker[] = [];

  const migrations = await countOrNull(
    db,
    `SELECT count(*)::text AS n FROM mail_migration_jobs WHERE state IN ('queued','running')`,
  );
  if (migrations !== null && migrations > 0) {
    blockers.push({
      id: 'migration-running',
      message: `Идёт перенос почты с другого сервера (${String(migrations)} задание(й)).`,
      fix:
        'Перенос кладёт письма по прежним адресам — начатая сейчас смена домена разложила бы ' +
        'их мимо ящиков. Дождитесь окончания в разделе «Перенос почты» или остановите его.',
    });
  }

  const exports = await countOrNull(
    db,
    `SELECT count(*)::text AS n FROM mailbox_export_jobs WHERE state IN ('queued','running')`,
  );
  if (exports !== null && exports > 0) {
    blockers.push({
      id: 'export-running',
      message: `Идёт выгрузка ящика (${String(exports)} задание(й)).`,
      fix:
        'Выгрузка читает почту по прежнему пути и оборвётся на середине, отдав человеку ' +
        'неполный архив. Дождитесь окончания — обычно это минуты.',
    });
  }

  const imports = await countOrNull(
    db,
    `SELECT count(*)::text AS n FROM user_import_jobs WHERE state IN ('queued','running')`,
  );
  if (imports !== null && imports > 0) {
    blockers.push({
      id: 'import-running',
      message: `Идёт массовое заведение ящиков (${String(imports)} задание(й)).`,
      fix: 'Новые ящики попадали бы в старый домен уже после переезда. Дождитесь окончания.',
    });
  }

  const already = await countOrNull(
    db,
    `SELECT count(*)::text AS n FROM domain_change_jobs WHERE state = 'running'`,
  );
  if (already !== null && already > 0) {
    blockers.push({
      id: 'change-running',
      message: 'Смена домена уже выполняется.',
      fix: 'Дождитесь её окончания — двух одновременных смен домена быть не может.',
    });
  }

  return blockers;
}

/* ================================================================== */
/* Выполнение                                                         */
/* ================================================================== */

/**
 * Заводит новый домен ДО точки невозврата.
 *
 * Отдельно от переписывания адресов, потому что делается раньше и
 * отменяется бесплатно: домен без ящиков — это одна строка в
 * `virtual_domains`. Postfix начнёт принимать для него почту и тут же
 * отбивать её как «нет такого ящика» — ровно то же, что было бы и без
 * этой строки. Зато к моменту переезда домен уже настроен, ключ DKIM
 * привязан, и запись DNS человек мог опубликовать заранее.
 */
export async function createTargetDomain(
  db: AdminDb,
  newDomain: string,
  dkim: { selector: string; publicKey: string; record: string },
): Promise<number> {
  return db.transaction(async (client) => {
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO virtual_domains (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [normalizeDomain(newDomain)],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('Не удалось завести новый домен');
    await client.query(
      `INSERT INTO domain_settings (domain_id, dkim_selector, dkim_public_key, dkim_dns_record)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain_id) DO UPDATE
          SET dkim_selector   = EXCLUDED.dkim_selector,
              dkim_public_key = EXCLUDED.dkim_public_key,
              dkim_dns_record = EXCLUDED.dkim_dns_record,
              updated_at = now()`,
      [id, dkim.selector, dkim.publicKey, dkim.record],
    );
    return id;
  });
}

/**
 * Убирает заведённый домен, если человек передумал до точки невозврата.
 *
 * Только пустой: если в домене уже что-то появилось, удаление унесло бы
 * это каскадом (`ON DELETE CASCADE` в 0001_baseline.sql). Такого быть не
 * должно — но «не должно» это не проверка.
 */
export async function dropTargetDomain(db: AdminDb, newDomain: string): Promise<boolean> {
  const rows = await db.query<{ id: number }>(
    `DELETE FROM virtual_domains d
      WHERE lower(d.name) = lower($1)
        AND NOT EXISTS (SELECT 1 FROM virtual_users   u WHERE u.domain_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM virtual_aliases a WHERE a.domain_id = d.id)
      RETURNING d.id`,
    [normalizeDomain(newDomain)],
  );
  return rows.length > 0;
}

export interface RewriteOutcome {
  tables: TableMove[];
  mailboxes: number;
  aliases: number;
  /** Заведено алиасов «старый адрес → новый». */
  legacyAliases: number;
  /** Удалено алиасов, которые после переезда оказались бы дублями. */
  duplicatesRemoved: number;
}

/**
 * Переписывает адреса. ОДНА транзакция — точка невозврата внутри неё.
 *
 * Порядок важен ровно в одном месте: алиасы «старый адрес → новый»
 * заводятся ПОСЛЕ переименования, потому что до него новых адресов ещё не
 * существует. Всё остальное независимо — внешних ключей на строку адреса
 * в схеме нет ни одного, и это проверено обходом всех миграций.
 */
export async function rewriteAddresses(
  db: AdminDb,
  input: {
    oldDomain: string;
    newDomain: string;
    oldDomainId: number;
    newDomainId: number;
    mailRoot: string;
  },
): Promise<RewriteOutcome> {
  const { oldDomainId, newDomainId } = input;
  const oldDomain = normalizeDomain(input.oldDomain);
  const newDomain = normalizeDomain(input.newDomain);
  /** «Из старого в новый» — для всего, что переезжает. */
  const fwd = rewriteArgs(oldDomain, newDomain);
  /** «Из нового в старый» — для построения прежнего адреса у алиасов. */
  const back = rewriteArgs(newDomain, oldDomain);

  const present = await existingTables(db, [
    ...OWNER_ADDRESS_COLUMNS.map((c) => c.table),
    'mailbox_deletions',
  ]);

  return db.transaction(async (client) => {
    const tables: TableMove[] = [];

    /* --- 1. Ящики ------------------------------------------------- */
    //
    // Условие двойное: и по домену-владельцу, и по хвосту самого адреса.
    // `virtual_aliases.domain_id` схемой с адресом не связан — теоретически
    // строка может лежать «не в своём» домене, и переименовать чужой адрес
    // хуже, чем оставить один странный на месте.
    const users = await client.query(
      `UPDATE virtual_users
          SET email = ${toDomain('email')},
              domain_id = $5,
              updated_at = now()
        WHERE domain_id = $6 AND ${inDomain('email')}`,
      [...fwd, newDomainId, oldDomainId],
    );
    const mailboxes = users.rowCount ?? 0;

    /* --- 2. Алиасы: сначала цели, потом источники ------------------ */

    // Дубли, которые получились бы после переписывания цели, убираем
    // заранее: UPDATE не умеет ON CONFLICT, а нарушение UNIQUE(source,
    // destination) откатило бы ВСЮ смену домена из-за одной строки,
    // которая и так стала бы копией соседней.
    const dupes = await client.query(
      `DELETE FROM virtual_aliases a
        WHERE ${inDomain('a.destination')}
          AND EXISTS (SELECT 1 FROM virtual_aliases b
                       WHERE b.source = a.source
                         AND b.id <> a.id
                         AND lower(b.destination) = lower(${toDomain('a.destination')}))`,
      fwd,
    );

    await client.query(
      `UPDATE virtual_aliases
          SET destination = ${toDomain('destination')}
        WHERE ${inDomain('destination')}`,
      fwd,
    );

    const moved = await client.query(
      `UPDATE virtual_aliases
          SET source = ${toDomain('source')},
              domain_id = $5
        WHERE domain_id = $6 AND ${inDomain('source')}`,
      [...fwd, newDomainId, oldDomainId],
    );
    const aliases = moved.rowCount ?? 0;

    /* --- 3. Старый домен продолжает принимать --------------------- */
    //
    // Алиас на каждый переехавший ящик и на каждый переехавший алиас.
    // Postfix раскрывает virtual_alias_maps рекурсивно, поэтому цепочка
    // «старый алиас → новый алиас → ящик» разрешается сама, и городить
    // прямые ссылки на конечный ящик не нужно.
    //
    // Строка заводится в СТАРОМ домене ($5): она принадлежит ему и вместе
    // с ним однажды будет удалена, когда старый домен решат отпустить.
    const legacyBoxes = await client.query(
      `INSERT INTO virtual_aliases (domain_id, source, destination, active)
       SELECT $5, ${toDomain('u.email')}, u.email, TRUE
         FROM virtual_users u
        WHERE u.domain_id = $6 AND ${inDomain('u.email')}
       ON CONFLICT (source, destination) DO NOTHING`,
      [...back, oldDomainId, newDomainId],
    );

    const legacyAliases = await client.query(
      `INSERT INTO virtual_aliases (domain_id, source, destination, active)
       SELECT $5, ${toDomain('a.source')}, a.source, TRUE
         FROM virtual_aliases a
        WHERE a.domain_id = $6 AND ${inDomain('a.source')}
       ON CONFLICT (source, destination) DO NOTHING`,
      [...back, oldDomainId, newDomainId],
    );

    /* --- 4. Таблицы продукта -------------------------------------- */
    for (const col of OWNER_ADDRESS_COLUMNS) {
      if (!present.has(col.table)) continue;
      let rows = 0;
      try {
        const result = await client.query(
          `UPDATE "${col.table}"
              SET "${col.column}" = ${toDomain(`"${col.column}"`)}
            WHERE ${inDomain(`"${col.column}"`)}`,
          fwd,
        );
        rows = result.rowCount ?? 0;
      } catch (err) {
        // Колонки нет — раздел старой версии. Своей колонки у него нет,
        // значит и адресов в ней нет; пропускаем, не роняя транзакцию.
        if (!isUndefinedColumnError(err)) throw err;
        continue;
      }
      if (rows > 0) tables.push({ ...col, rows });
    }

    /* --- 5. Пути ящиков, ждущих уборки ---------------------------- */
    //
    // Каталог удалённого ящика лежит в карантине до истечения отсрочки
    // (ADMIN_MAILBOX_PURGE_DELAY_MINUTES — до месяца). Путь записан строкой
    // и после переименования каталога домена указывает в пустоту: уборщик
    // десять раз не найдёт каталог, сдастся, и письма удалённого ящика
    // останутся на диске навсегда. Это не история, а действующее указание
    // уборщику, поэтому переписываем.
    if (present.has('mailbox_deletions')) {
      const oldPrefix = `${input.mailRoot}/${oldDomain}/`;
      const newPrefix = `${input.mailRoot}/${newDomain}/`;
      await client.query(
        `UPDATE mailbox_deletions
            SET quarantine_path = CASE
                    WHEN quarantine_path LIKE $1 || '%'
                    THEN $2 || substring(quarantine_path from length($1) + 1)
                    ELSE quarantine_path END,
                maildir_path = CASE
                    WHEN maildir_path LIKE $1 || '%'
                    THEN $2 || substring(maildir_path from length($1) + 1)
                    ELSE maildir_path END
          WHERE state = 'pending'
            AND (quarantine_path LIKE $1 || '%' OR maildir_path LIKE $1 || '%')`,
        [oldPrefix, newPrefix],
      );
    }

    return {
      tables,
      mailboxes,
      aliases,
      legacyAliases: (legacyBoxes.rowCount ?? 0) + (legacyAliases.rowCount ?? 0),
      duplicatesRemoved: dupes.rowCount ?? 0,
    };
  });
}

/** Идентификатор домена по имени; null — такого домена нет. */
export async function domainIdOf(db: AdminDb | PoolClient, domain: string): Promise<number | null> {
  const sql = `SELECT id FROM virtual_domains WHERE lower(name) = lower($1)`;
  if ('one' in db) {
    const row = await db.one<{ id: number }>(sql, [domain]);
    return row?.id ?? null;
  }
  const result = await db.query<{ id: number }>(sql, [domain]);
  return result.rows[0]?.id ?? null;
}
