/**
 * Хранилище состояния переноса — обеспечивает докачку после обрыва.
 *
 * Хранятся два вида записей:
 *   - «письмо перенесено»: (ящик, папка-приёмник, ключ дедупликации);
 *   - «курсор папки»: (ящик, папка-источник, UIDVALIDITY, последний
 *     обработанный UID) — чтобы при повторном запуске не перечитывать
 *     метаданные уже обработанных писем.
 *
 * Реализации:
 *   - FileStateStore — журнал JSONL (append-only, безопасен при обрыве);
 *   - PgStateStore   — таблицы migrate_messages / migrate_cursors в Postgres.
 *
 * Важно: состояние — это ускорение, а не единственная защита от дублей.
 * Перед переносом каждая папка-приёмник дополнительно сканируется, и её
 * содержимое добавляется в набор дедупликации (см. migrator.ts). Поэтому
 * даже потеря файла состояния не приводит к дублям.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';

/** Курсор папки-источника. */
export interface FolderCursor {
  uidValidity: string;
  lastUid: number;
}

/** Интерфейс хранилища состояния переноса. */
export interface StateStore {
  init(): Promise<void>;
  /** Был ли перенесён ключ в эту папку приёмника этого ящика. */
  wasMigrated(account: string, destFolder: string, key: string): Promise<boolean>;
  /**
   * СКОЛЬКО писем с таким ключом уже перенесено в эту папку приёмника.
   * Ключ дедупликации не уникален (повторно использованный Message-ID,
   * автоуведомления без Message-ID с одинаковыми заголовками), поэтому
   * решение «дубль или нет» принимается по количеству копий, а не по
   * факту «ключ встречался» — иначе второй проход теряет новые письма.
   */
  migratedCount(account: string, destFolder: string, key: string): Promise<number>;
  /**
   * То же самое, но сразу про пачку ключей — ОДНИМ обращением к хранилищу.
   *
   * Поштучный migratedCount стоял внутри цикла по всем письмам папки: на
   * папке в 200 тысяч писем это 200 тысяч запросов в Postgres до того, как
   * будет скопировано хотя бы одно письмо. Человек в это время смотрел на
   * неподвижные счётчики и считал перенос зависшим, а база, из которой
   * Postfix берёт карты доставки, всё это время работала вхолостую.
   *
   * Возвращается карта «ключ → сколько копий»; ключи, которых в хранилище
   * нет, в карту не попадают (это и означает ноль).
   */
  migratedCounts(account: string, destFolder: string, keys: string[]): Promise<Map<string, number>>;
  /** Отметить перенос ещё одной копии письма с этим ключом. */
  markMigrated(account: string, destFolder: string, key: string): Promise<void>;
  getCursor(account: string, sourceFolder: string): Promise<FolderCursor | null>;
  setCursor(account: string, sourceFolder: string, cursor: FolderCursor): Promise<void>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Файловое хранилище (JSONL)                                        */
/* ------------------------------------------------------------------ */

type FileRecord =
  | { t: 'm'; a: string; f: string; k: string }
  | { t: 'c'; a: string; f: string; v: string; u: number };

/**
 * Журнал в формате JSON Lines: каждая запись — отдельная строка,
 * файл только дописывается. При старте журнал прочитывается в память
 * (хранятся лишь ключи, ~100 байт на письмо).
 */
export class FileStateStore implements StateStore {
  /** Ключ → сколько копий перенесено (а не просто «была/не была»). */
  private readonly migrated = new Map<string, number>();
  private readonly cursors = new Map<string, FolderCursor>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(dirname(this.filePath), { recursive: true });
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return; // файла ещё нет — чистое состояние
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: FileRecord;
      try {
        rec = JSON.parse(trimmed) as FileRecord;
      } catch {
        continue; // оборванная последняя строка после сбоя — игнорируем
      }
      if (rec.t === 'm') {
        const setKey = `${rec.a}\u0000${rec.f}\u0000${rec.k}`;
        this.migrated.set(setKey, (this.migrated.get(setKey) ?? 0) + 1);
      } else if (rec.t === 'c') {
        this.cursors.set(`${rec.a}\u0000${rec.f}`, { uidValidity: rec.v, lastUid: rec.u });
      }
    }
  }

  async wasMigrated(account: string, destFolder: string, key: string): Promise<boolean> {
    return (await this.migratedCount(account, destFolder, key)) > 0;
  }

  async migratedCount(account: string, destFolder: string, key: string): Promise<number> {
    return this.migrated.get(`${account}\u0000${destFolder}\u0000${key}`) ?? 0;
  }

  async migratedCounts(
    account: string,
    destFolder: string,
    keys: string[],
  ): Promise<Map<string, number>> {
    // Журнал целиком прочитан в память ещё в init, ходить никуда не нужно:
    // пачка здесь только ради одинакового обращения с обоими хранилищами.
    const result = new Map<string, number>();
    for (const key of keys) {
      const count = await this.migratedCount(account, destFolder, key);
      if (count > 0) result.set(key, count);
    }
    return result;
  }

  async markMigrated(account: string, destFolder: string, key: string): Promise<void> {
    // Каждая перенесённая копия — отдельная запись журнала. Раньше повторная
    // запись с тем же ключом отбрасывалась, и хранилище не умело отличить
    // «перенесли одну копию» от «перенесли три»: из-за этого второй проход
    // объявлял законно новые письма дублями.
    const setKey = `${account}\u0000${destFolder}\u0000${key}`;
    this.migrated.set(setKey, (this.migrated.get(setKey) ?? 0) + 1);
    const rec: FileRecord = { t: 'm', a: account, f: destFolder, k: key };
    await appendFile(this.filePath, JSON.stringify(rec) + '\n', 'utf8');
  }

  async getCursor(account: string, sourceFolder: string): Promise<FolderCursor | null> {
    return this.cursors.get(`${account}\u0000${sourceFolder}`) ?? null;
  }

  async setCursor(account: string, sourceFolder: string, cursor: FolderCursor): Promise<void> {
    this.cursors.set(`${account}\u0000${sourceFolder}`, cursor);
    const rec: FileRecord = {
      t: 'c',
      a: account,
      f: sourceFolder,
      v: cursor.uidValidity,
      u: cursor.lastUid,
    };
    await appendFile(this.filePath, JSON.stringify(rec) + '\n', 'utf8');
  }

  async close(): Promise<void> {
    /* журнал дописывается сразу — закрывать нечего */
  }
}

/* ------------------------------------------------------------------ */
/*  Хранилище в Postgres                                              */
/* ------------------------------------------------------------------ */

/**
 * Сколько соединений держит пул одного хранилища состояния.
 *
 * Четыре, а не умолчание pg (десять). Хранилище заводится на задание
 * переноса, заданий бывает несколько сразу, и все они идут в ТУ ЖЕ базу,
 * из которой Postfix берёт карты доставки, а Dovecot — учётные записи.
 * Пять заданий по десять соединений — это полсотни соединений сверх пулов
 * самого api, и Postgres с его умолчанием max_connections = 100 начинает
 * отвечать «too many clients»: сервер перестаёт принимать почту и пускать
 * людей в ящики. То есть перенос, задуманный как фоновая работа, кладёт
 * почтовый сервер целиком.
 *
 * Четырёх хватает с запасом: обращений к состоянию ровно два вида —
 * отметка перенесённого письма и запись курсора, обе поштучные и короткие,
 * а идут они по числу одновременно переносимых ящиков (MIGRATION_CONCURRENCY,
 * по умолчанию два).
 */
const DEFAULT_POOL_SIZE = 4;

/**
 * Состояние в Postgres — удобно, когда перенос запускается из API
 * и состояние должно переживать перезапуски контейнеров.
 *
 * Таблицы создаются автоматически (IF NOT EXISTS) — и это ОСТАВЛЕНО
 * намеренно, хотя в целом заводить таблицы кодом мимо миграций нельзя.
 * Причина в том, что строка подключения здесь произвольная: `pg:` можно
 * направить на любую базу, в том числе не нашу (так и описано в
 * docs/migration.md), а наших миграций там нет по определению.
 *
 * В НАШЕЙ схеме те же две таблицы объявлены отдельно —
 * infra/postgres/migrations/0021_code_created_tables.sql, слово в слово.
 * Это нужно, чтобы они попадали в план обновления и в проверку схемы
 * install/selfcheck.sh: та берёт список ожидаемых таблиц из файлов
 * миграций, и пропажу таблицы, объявленной только в коде, не заметила бы.
 * Оба описания обязаны совпадать; правка одного без другого — дефект.
 */
export class PgStateStore implements StateStore {
  private readonly pool: pg.Pool;

  /**
   * @param connectionString строка подключения к базе состояния
   * @param options.max      сколько соединений держит пул этого хранилища
   */
  constructor(connectionString: string, options: { max?: number } = {}) {
    this.pool = new pg.Pool({ connectionString, max: options.max ?? DEFAULT_POOL_SIZE });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS migrate_messages (
        account     text NOT NULL,
        dest_folder text NOT NULL,
        dedup_key   text NOT NULL,
        -- Сколько копий письма с этим ключом уже перенесено. Ключ
        -- дедупликации не уникален (повторный Message-ID, письма без
        -- Message-ID с одинаковыми заголовками), поэтому храним число.
        copies      integer NOT NULL DEFAULT 1,
        migrated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account, dest_folder, dedup_key)
      );
      ALTER TABLE migrate_messages
        ADD COLUMN IF NOT EXISTS copies integer NOT NULL DEFAULT 1;
      CREATE TABLE IF NOT EXISTS migrate_cursors (
        account       text NOT NULL,
        source_folder text NOT NULL,
        uid_validity  text NOT NULL,
        last_uid      bigint NOT NULL,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account, source_folder)
      );
    `);
  }

  async wasMigrated(account: string, destFolder: string, key: string): Promise<boolean> {
    return (await this.migratedCount(account, destFolder, key)) > 0;
  }

  async migratedCount(account: string, destFolder: string, key: string): Promise<number> {
    const res = await this.pool.query<{ copies: string }>(
      'SELECT copies FROM migrate_messages WHERE account = $1 AND dest_folder = $2 AND dedup_key = $3',
      [account, destFolder, key],
    );
    return Number(res.rows[0]?.copies ?? 0);
  }

  async migratedCounts(
    account: string,
    destFolder: string,
    keys: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (keys.length === 0) return result;
    // Один запрос на всю порцию писем вместо запроса на письмо. На папке
    // в 200 тысяч писем разница — между «перенос пошёл через секунду» и
    // «счётчики не двигаются десятки минут, и всё это время база занята
    // нами, а не доставкой почты».
    const res = await this.pool.query<{ dedup_key: string; copies: string }>(
      `SELECT dedup_key, copies FROM migrate_messages
        WHERE account = $1 AND dest_folder = $2 AND dedup_key = ANY($3::text[])`,
      [account, destFolder, keys],
    );
    for (const row of res.rows) result.set(row.dedup_key, Number(row.copies));
    return result;
  }

  async markMigrated(account: string, destFolder: string, key: string): Promise<void> {
    // Не ON CONFLICT DO NOTHING, а увеличение счётчика: вторая законная
    // копия письма с тем же ключом должна быть видна как вторая.
    await this.pool.query(
      `INSERT INTO migrate_messages (account, dest_folder, dedup_key, copies)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (account, dest_folder, dedup_key)
       DO UPDATE SET copies = migrate_messages.copies + 1, migrated_at = now()`,
      [account, destFolder, key],
    );
  }

  async getCursor(account: string, sourceFolder: string): Promise<FolderCursor | null> {
    const res = await this.pool.query<{ uid_validity: string; last_uid: string }>(
      'SELECT uid_validity, last_uid FROM migrate_cursors WHERE account = $1 AND source_folder = $2',
      [account, sourceFolder],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { uidValidity: row.uid_validity, lastUid: Number(row.last_uid) };
  }

  async setCursor(account: string, sourceFolder: string, cursor: FolderCursor): Promise<void> {
    await this.pool.query(
      `INSERT INTO migrate_cursors (account, source_folder, uid_validity, last_uid, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (account, source_folder)
       DO UPDATE SET uid_validity = EXCLUDED.uid_validity,
                     last_uid = EXCLUDED.last_uid,
                     updated_at = now()`,
      [account, sourceFolder, cursor.uidValidity, cursor.lastUid],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Создать хранилище по строке-описанию:
 *   - `file:/path/to/state.jsonl` или просто путь → FileStateStore;
 *   - `pg:postgres://user:pass@host:5432/db` или `postgres://…` → PgStateStore.
 */
export function createStateStore(spec: string): StateStore {
  if (spec.startsWith('pg:')) return new PgStateStore(spec.slice(3));
  if (spec.startsWith('postgres://') || spec.startsWith('postgresql://')) {
    return new PgStateStore(spec);
  }
  if (spec.startsWith('file:')) return new FileStateStore(spec.slice(5));
  return new FileStateStore(spec);
}
