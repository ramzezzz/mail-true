/**
 * Кэш логотипов доменов.
 *
 * ------------------------------------------------------------------
 * Где хранится и почему в базе, а не в томе файлами
 * ------------------------------------------------------------------
 * Логотип входа лежит файлом в томе (admin/branding.ts) — и правильно: он
 * один, его загружает человек, и его надо забрать в резервную копию. Здесь
 * задача другая, и файлы для неё плохи по четырём причинам:
 *
 *   1. Записей тысячи, а не одна, и у каждой есть СРОК и время последнего
 *      обращения. Каталог файлов пришлось бы сопровождать отдельным
 *      указателем — то есть самодельной базой поверх файловой системы.
 *   2. Вытеснение по давности требует упорядочивания. В базе это один
 *      запрос, в каталоге — обход всех файлов.
 *   3. Имя файла пришлось бы делать из доменного имени, пришедшего снаружи.
 *      Это ровно та операция, на которой рождаются выходы из каталога.
 *   4. Экземпляров API может быть несколько (за nginx), и общая база даёт
 *      им общий кэш. Тома у каждого свои.
 *
 * Перезапуск контейнера кэш переживает — это обязательное требование:
 * иначе каждое обновление стека означало бы поход в сеть за всеми
 * логотипами разом.
 *
 * Без базы модуль не отключается, а падает до кэша В ПАМЯТИ: логотипы
 * работают, но переживают только до перезапуска. Это честнее, чем гасить
 * возможность целиком, и соответствует принципу остального API.
 *
 * ------------------------------------------------------------------
 * Сроки
 * ------------------------------------------------------------------
 * Найденный логотип — 30 суток. Знаки меняют раз в несколько лет, а
 * ежедневная перепроверка тысячи доменов — это тысяча запросов в день
 * ни за чем. «Навсегда» тоже неверно: сменивший знак останется со старым.
 *
 * Просроченная запись НЕ выбрасывается, а обновляется в фоне: пока новый
 * логотип не приехал, показать вчерашний лучше, чем букву. Свежесть
 * логотипа — не то свойство, ради которого стоит мигать интерфейсом.
 *
 * «Логотипа нет» — 7 суток: большинство доменов в этом состоянии, и без
 * запоминания ОТКАЗА каждое открытие папки било бы в сеть по всему списку.
 * «Спросить не удалось» — 6 часов: чужой сервер мог полежать полчаса, и
 * наказывать его неделей забвения не за что.
 */
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { LogoConfig } from './config.js';
import type { LogoSource } from './sources.js';

/** Сколько логотипов держим. Дальше вытесняются самые давно не нужные. */
export const LOGO_CACHE_MAX_ENTRIES = 5000;

export interface CachedLogo {
  domain: string;
  /** null — логотипа нет (отрицательный ответ, его тоже помним). */
  source: LogoSource | null;
  mime: string | null;
  bytes: Buffer | null;
  width: number | null;
  height: number | null;
  /** Отпечаток содержимого: попадает в адрес и делает кэш браузера честным. */
  version: string;
  /** Срок годности записи. Просроченную показываем и обновляем в фоне. */
  expiresAt: Date;
}

export function isFresh(entry: CachedLogo, now = new Date()): boolean {
  return entry.expiresAt.getTime() > now.getTime();
}

/** Отпечаток: домен + содержимое. Меняется вместе с картинкой. */
export function logoVersion(domain: string, bytes: Buffer | null): string {
  return createHash('sha256')
    .update(domain)
    .update(bytes ?? Buffer.alloc(0))
    .digest('hex')
    .slice(0, 16);
}

// Описание таблицы sender_logo_cache живёт в
// infra/postgres/migrations/0001_baseline.sql, а не здесь.
// Держать его в двух местах — это схема, которая зависит от того, что
// случилось раньше: миграция или первое обращение кода.

interface Row {
  domain: string;
  source: string | null;
  mime: string | null;
  image: Buffer | null;
  width: number | null;
  height: number | null;
  version: string;
  expires_at: Date;
}

function toEntry(row: Row): CachedLogo {
  return {
    domain: row.domain,
    source: (row.source as LogoSource | null) ?? null,
    mime: row.mime,
    bytes: row.image,
    width: row.width,
    height: row.height,
    version: row.version,
    expiresAt: row.expires_at,
  };
}

/**
 * Кэш: Postgres как долговременное хранилище плюс небольшой слой в памяти.
 *
 * Слой в памяти нужен не «для скорости вообще», а ради конкретного случая:
 * список из пятидесяти писем от десяти доменов открывается заново каждые
 * несколько секунд, и без него это были бы десятки запросов к базе на
 * каждое открытие — за картинками, которые не менялись месяц.
 */
export class LogoStore {
  readonly #pool: Pool | null;
  readonly #logger: Logger;
  readonly #config: LogoConfig;
  readonly #memory = new Map<string, CachedLogo>();
  #schemaOk: boolean | null = null;
  #writesSinceEviction = 0;

  constructor(init: { config: LogoConfig; logger: Logger }) {
    this.#config = init.config;
    this.#logger = init.logger;
    this.#pool = init.config.databaseUrl
      ? new Pool({ connectionString: init.config.databaseUrl, max: 4 })
      : null;
    if (this.#pool === null) {
      init.logger.warn(
        'Кэш логотипов отправителей — только в памяти: не задано подключение к базе. ' +
          'После перезапуска сервер будет искать логотипы заново.',
      );
    }
  }

  get persistent(): boolean {
    return this.#pool !== null;
  }

  /**
   * Подключение к базе — то же самое, что использует хранилище ручных
   * решений. Одно подключение на весь раздел: держать два пула к одной
   * базе ради двух таблиц незачем.
   */
  get pool(): Pool | null {
    return this.#pool;
  }

  /**
   * Забыть домен в слое памяти.
   *
   * Нужен, когда решение поменяли ВНЕ этого кэша — администратор загрузил
   * свою картинку или поставил запрет. Без этого слой памяти отдавал бы
   * прежний ответ до перезапуска, и ручная загрузка выглядела бы
   * неработающей — самая обидная разновидность поломки.
   */
  forget(domain: string): void {
    this.#memory.delete(domain);
  }

  /**
   * Проверяет, что таблица кэша есть в базе.
   *
   * Раньше этот метод её СОЗДАВАЛ — с доводом «это кэш, а не данные,
   * ради него не стоит заводить файл миграции». Довод про ценность строк
   * верен, вывод из него — нет: таблицы, объявленной в коде, не существует
   * для всего, что разбирает схему. install/selfcheck.sh берёт список
   * ожидаемых таблиц из файлов миграций и пропажи этой не заметил бы;
   * в план обновления она тоже не попадала. Теперь таблицу заводит
   * миграция 0021_code_created_tables.sql, а здесь только проверка.
   *
   * Отсутствие таблицы — не авария: логотипы просто не показываются,
   * почта работает как обычно. Поэтому предупреждение, а не отказ, —
   * но с прямым указанием, что делать.
   */
  async ready(): Promise<boolean> {
    if (this.#pool === null) return false;
    if (this.#schemaOk !== null) return this.#schemaOk;
    try {
      const res = await this.#pool.query<{ present: boolean }>(
        `SELECT to_regclass('public.sender_logo_cache') IS NOT NULL AS present`,
      );
      this.#schemaOk = res.rows[0]?.present === true;
      if (!this.#schemaOk) {
        this.#logger.warn(
          'Нет таблицы sender_logo_cache — логотипы отправителей показываться не будут. ' +
            'Примените infra/postgres/migrations/0001_baseline.sql ' +
            '(это делает install/install.sh).',
        );
      }
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Не удалось проверить таблицу кэша логотипов');
      this.#schemaOk = false;
    }
    return this.#schemaOk;
  }

  /** Читает то, что уже известно. Отсутствующие домены просто не в ответе. */
  async read(domains: readonly string[]): Promise<Map<string, CachedLogo>> {
    const out = new Map<string, CachedLogo>();
    const missing: string[] = [];
    for (const domain of domains) {
      const cached = this.#memory.get(domain);
      if (cached) out.set(domain, cached);
      else missing.push(domain);
    }
    if (missing.length === 0 || !(await this.ready()) || this.#pool === null) return out;

    try {
      const res = await this.#pool.query<Row>(
        `SELECT domain, source, mime, image, width, height, version, expires_at
           FROM sender_logo_cache WHERE domain = ANY($1::text[])`,
        [missing],
      );
      for (const row of res.rows) {
        const entry = toEntry(row);
        this.#memory.set(entry.domain, entry);
        out.set(entry.domain, entry);
      }
      // Отметка «этим пользовались» — по ней потом вытесняются забытые.
      // Отдельным запросом и без ожидания: держать из-за неё ответ незачем.
      void this.#pool
        .query(`UPDATE sender_logo_cache SET last_used_at = now() WHERE domain = ANY($1::text[])`, [
          res.rows.map((r) => r.domain),
        ])
        .catch(() => undefined);
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Не удалось прочитать кэш логотипов');
    }
    return out;
  }

  /** Записывает результат поиска (в том числе отрицательный). */
  async write(
    domain: string,
    result: {
      source: LogoSource | null;
      mime: string | null;
      bytes: Buffer | null;
      width: number | null;
      height: number | null;
      ttlHours: number;
    },
  ): Promise<CachedLogo> {
    const entry: CachedLogo = {
      domain,
      source: result.source,
      mime: result.mime,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      version: logoVersion(domain, result.bytes),
      expiresAt: new Date(Date.now() + result.ttlHours * 3600_000),
    };
    this.#memory.set(domain, entry);

    if (await this.ready()) {
      try {
        await this.#pool?.query(
          `INSERT INTO sender_logo_cache
               (domain, source, mime, image, width, height, version, fetched_at, expires_at, last_used_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, now())
           ON CONFLICT (domain) DO UPDATE
               SET source = EXCLUDED.source,
                   mime = EXCLUDED.mime,
                   image = EXCLUDED.image,
                   width = EXCLUDED.width,
                   height = EXCLUDED.height,
                   version = EXCLUDED.version,
                   fetched_at = now(),
                   expires_at = EXCLUDED.expires_at,
                   last_used_at = now()`,
          [
            domain,
            entry.source,
            entry.mime,
            entry.bytes,
            entry.width,
            entry.height,
            entry.version,
            entry.expiresAt,
          ],
        );
      } catch (err) {
        this.#logger.warn(errorInfo(err, { domain }), 'Не удалось записать кэш логотипа');
      }
      this.#writesSinceEviction += 1;
      // Считать записи дешевле, чем считать строки: полная проверка раз в
      // сотню записей держит таблицу в берегах и ничего не стоит остальным.
      if (this.#writesSinceEviction >= 100) {
        this.#writesSinceEviction = 0;
        void this.evict().catch(() => undefined);
      }
    }

    // Слой в памяти намеренно мал: он ускоряет повторное открытие списка,
    // а не заменяет базу. Лишнее выбрасывается по порядку добавления.
    if (this.#memory.size > 512) {
      const oldest = this.#memory.keys().next();
      if (!oldest.done) this.#memory.delete(oldest.value);
    }

    return entry;
  }

  /**
   * Убирает лишнее: сначала совсем протухшие отрицательные ответы, затем —
   * если записей всё ещё больше предела — самые давно не нужные.
   *
   * Вытесняются первыми именно ЗАБЫТЫЕ домены, а не самые старые по дате
   * добавления: логотип «Госуслуг», найденный год назад и нужный каждый
   * день, ценнее вчерашнего логотипа домена, письмо от которого пришло
   * однажды.
   */
  async evict(): Promise<number> {
    if (!(await this.ready()) || this.#pool === null) return 0;
    let removed = 0;
    try {
      const stale = await this.#pool.query(
        `DELETE FROM sender_logo_cache
          WHERE image IS NULL AND expires_at < now() - interval '30 days'`,
      );
      removed += stale.rowCount ?? 0;

      const extra = await this.#pool.query(
        `DELETE FROM sender_logo_cache
          WHERE domain IN (
              SELECT domain FROM sender_logo_cache
               ORDER BY last_used_at DESC
              OFFSET $1
          )`,
        [LOGO_CACHE_MAX_ENTRIES],
      );
      removed += extra.rowCount ?? 0;
      if (removed > 0) {
        this.#memory.clear();
        this.#logger.info({ removed }, 'Кэш логотипов подчищен');
      }
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Не удалось подчистить кэш логотипов');
    }
    return removed;
  }

  /** Сколько записей и сколько из них с картинкой — для отчёта и проверки. */
  async stats(): Promise<{ total: number; withImage: number } | null> {
    if (!(await this.ready()) || this.#pool === null) return null;
    try {
      const res = await this.#pool.query<{ total: string; with_image: string }>(
        `SELECT count(*)::text AS total,
                count(image)::text AS with_image
           FROM sender_logo_cache`,
      );
      const row = res.rows[0];
      if (!row) return null;
      return { total: Number(row.total), withImage: Number(row.with_image) };
    } catch {
      return null;
    }
  }

  /** Сроки в часах для каждого исхода поиска. */
  ttlHoursFor(kind: 'found' | 'none' | 'error'): number {
    switch (kind) {
      case 'found':
        return this.#config.SENDER_LOGO_TTL_HOURS;
      case 'none':
        return this.#config.SENDER_LOGO_MISS_TTL_HOURS;
      case 'error':
        return this.#config.SENDER_LOGO_ERROR_TTL_HOURS;
    }
  }

  async close(): Promise<void> {
    await this.#pool?.end();
  }
}
