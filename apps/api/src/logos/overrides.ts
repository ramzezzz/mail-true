/**
 * Ручное управление логотипами доменов: своя картинка и запрет.
 *
 * ------------------------------------------------------------------
 * Чем это отличается от кэша и почему лежит отдельно
 * ------------------------------------------------------------------
 * Кэш (store.ts) — производное от сети: его можно выбросить целиком, и он
 * восстановится сам. Здесь же лежит РЕШЕНИЕ ЧЕЛОВЕКА, и восстановить его
 * неоткуда: исходник картинки остался у администратора, а «этому домену
 * логотип не показывать» не выводится ниоткуда вовсе.
 *
 * Отсюда три следствия, из-за которых это отдельная таблица, а не колонки
 * в кэше:
 *   * её нельзя чистить вытеснением по давности, а кэш — можно и нужно;
 *   * она обязана попадать в резервную копию, а кэш там только мешает
 *     (install/backup.sh снимает pg_dump всей базы, и данные кэша из него
 *     исключены отдельной строкой — см. комментарий там же);
 *   * её заводит МИГРАЦИЯ (0010), а не код при первом обращении: потеря
 *     таблицы настроек должна быть заметна, а не молча исправлена.
 *
 * ------------------------------------------------------------------
 * Что важнее чего
 * ------------------------------------------------------------------
 *   1. ЗАПРЕТ. Сильнее всего: администратор сказал «здесь логотипа не
 *      будет». Ни ручная картинка, ни найденная в сети его не отменяют.
 *   2. РУЧНАЯ КАРТИНКА. Сильнее найденной автоматически — иначе очередное
 *      обновление кэша молча вернуло бы картинку из сети, и администратор
 *      решил бы, что загрузка не работает.
 *   3. Найденное автоматически (BIMI, значок сайта, подсказка ИИ).
 *
 * Запрет и ручная картинка живут в ОДНОЙ строке, но независимо: снять
 * запрет — не то же самое, что удалить картинку, и наоборот. Заказчик
 * назвал это отдельным требованием, и он прав: «выключить на время» и
 * «убрать то, что я загрузил» — разные намерения.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { LogoSource } from './sources.js';

/** Ручная картинка домена и/или запрет на логотип. */
export interface LogoOverride {
  domain: string;
  /** Логотипа у этого домена не будет ни при каких источниках. */
  blocked: boolean;
  mime: string | null;
  bytes: Buffer | null;
  width: number | null;
  height: number | null;
  /** Отпечаток ручной картинки; пусто, когда картинки нет. */
  version: string;
  updatedAt: Date;
  /** Кто изменил — для списка в панели и для разбора «кто это поставил». */
  updatedBy: string | null;
}

interface Row {
  domain: string;
  blocked: boolean;
  mime: string | null;
  image: Buffer | null;
  width: number | null;
  height: number | null;
  version: string;
  updated_at: Date;
  updated_by: string | null;
}

function toOverride(row: Row): LogoOverride {
  return {
    domain: row.domain,
    blocked: row.blocked,
    mime: row.mime,
    bytes: row.image,
    width: row.width,
    height: row.height,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Отпечаток ручной картинки: попадает в адрес, поэтому кэш браузера не врёт. */
export function overrideVersion(domain: string, bytes: Buffer | null): string {
  return createHash('sha256')
    .update('manual')
    .update(domain)
    .update(bytes ?? Buffer.alloc(0))
    .digest('hex')
    .slice(0, 16);
}

/** Строка списка в панели: что известно про домен и откуда это взялось. */
export interface DomainLogoRow {
  domain: string;
  /** blocked — запрещён; manual — своя картинка; auto — найдено в сети; none — не найдено. */
  state: 'blocked' | 'manual' | 'auto' | 'none';
  /** Откуда взята автоматическая картинка, если она есть. */
  autoSource: LogoSource | null;
  /** Есть ли своя картинка (даже когда домен запрещён и она не видна). */
  hasManual: boolean;
  width: number | null;
  height: number | null;
  /** Отпечаток ДЕЙСТВУЮЩЕЙ картинки — для предпросмотра в панели. */
  version: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export class LogoOverrideStore {
  readonly #pool: Pool | null;
  readonly #logger: Logger;

  constructor(init: { pool: Pool | null; logger: Logger }) {
    this.#pool = init.pool;
    this.#logger = init.logger;
  }

  get available(): boolean {
    return this.#pool !== null;
  }

  /** Ручные решения по перечисленным доменам. Отсутствующих в ответе нет. */
  async read(domains: readonly string[]): Promise<Map<string, LogoOverride>> {
    const out = new Map<string, LogoOverride>();
    if (this.#pool === null || domains.length === 0) return out;
    try {
      const res = await this.#pool.query<Row>(
        `SELECT domain, blocked, mime, image, width, height, version, updated_at, updated_by
           FROM sender_logo_overrides WHERE domain = ANY($1::text[])`,
        [domains],
      );
      for (const row of res.rows) out.set(row.domain, toOverride(row));
    } catch (err) {
      // Нет таблицы — значит миграция 0010 не применена. Ручные решения
      // просто не действуют; автоматические логотипы при этом работают.
      this.#logger.warn(errorInfo(err), 'Не удалось прочитать ручные логотипы доменов');
    }
    return out;
  }

  async get(domain: string): Promise<LogoOverride | null> {
    return (await this.read([domain])).get(domain) ?? null;
  }

  /** Сохраняет ручную картинку домена (создаёт строку, если её не было). */
  async setImage(
    domain: string,
    image: { mime: string; bytes: Buffer; width: number; height: number },
    by: string | null,
  ): Promise<void> {
    if (this.#pool === null) return;
    await this.#pool.query(
      `INSERT INTO sender_logo_overrides
           (domain, blocked, mime, image, width, height, version, updated_at, updated_by)
       VALUES ($1, false, $2, $3, $4, $5, $6, now(), $7)
       ON CONFLICT (domain) DO UPDATE
           SET mime = EXCLUDED.mime,
               image = EXCLUDED.image,
               width = EXCLUDED.width,
               height = EXCLUDED.height,
               version = EXCLUDED.version,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by`,
      [
        domain,
        image.mime,
        image.bytes,
        image.width,
        image.height,
        overrideVersion(domain, image.bytes),
        by,
      ],
    );
  }

  /**
   * Убирает ручную картинку — домен возвращается к автоматически найденной.
   * Запрет при этом НЕ снимается: это отдельное решение.
   */
  async clearImage(domain: string, by: string | null): Promise<void> {
    if (this.#pool === null) return;
    await this.#pool.query(
      `UPDATE sender_logo_overrides
          SET mime = NULL, image = NULL, width = NULL, height = NULL,
              version = '', updated_at = now(), updated_by = $2
        WHERE domain = $1`,
      [domain, by],
    );
    await this.#dropEmpty(domain);
  }

  /** Запрещает или разрешает логотип домена. */
  async setBlocked(domain: string, blocked: boolean, by: string | null): Promise<void> {
    if (this.#pool === null) return;
    await this.#pool.query(
      `INSERT INTO sender_logo_overrides
           (domain, blocked, version, updated_at, updated_by)
       VALUES ($1, $2, '', now(), $3)
       ON CONFLICT (domain) DO UPDATE
           SET blocked = EXCLUDED.blocked, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [domain, blocked, by],
    );
    await this.#dropEmpty(domain);
  }

  /**
   * Убирает строку, в которой не осталось решения.
   *
   * Иначе в таблице настроек копились бы пустышки от каждого «загрузил и
   * передумал», а список в панели показывал бы домены, про которые никто
   * ничего не решал.
   */
  async #dropEmpty(domain: string): Promise<void> {
    if (this.#pool === null) return;
    await this.#pool.query(
      `DELETE FROM sender_logo_overrides WHERE domain = $1 AND blocked = false AND image IS NULL`,
      [domain],
    );
  }

  /**
   * Список доменов для панели: всё, что мы про них знаем.
   *
   * Объединяются две таблицы: кэш (какие домены вообще встречались в письмах
   * и что для них нашлось) и ручные решения. Полным объединением, а не
   * присоединением к кэшу: домен могли запретить ещё до того, как письмо от
   * него пришло, и он обязан остаться в списке — иначе снять запрет будет
   * негде.
   */
  async list(options: {
    query?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ items: DomainLogoRow[]; total: number }> {
    if (this.#pool === null) return { items: [], total: 0 };
    const like = options.query ? `%${options.query.toLowerCase()}%` : null;

    const base = `
      FROM (
          SELECT domain FROM sender_logo_cache
          UNION
          SELECT domain FROM sender_logo_overrides
      ) d
      LEFT JOIN sender_logo_cache     c ON c.domain = d.domain
      LEFT JOIN sender_logo_overrides o ON o.domain = d.domain
      WHERE ($1::text IS NULL OR d.domain LIKE $1::text)`;

    try {
      const totalRes = await this.#pool.query<{ n: string }>(
        `SELECT count(*)::text AS n ${base}`,
        [like],
      );

      const res = await this.#pool.query<{
        domain: string;
        blocked: boolean | null;
        manual: boolean;
        manual_version: string | null;
        manual_width: number | null;
        manual_height: number | null;
        auto_source: string | null;
        auto_version: string | null;
        auto_width: number | null;
        auto_height: number | null;
        updated_at: Date | null;
        updated_by: string | null;
      }>(
        `SELECT d.domain,
                o.blocked,
                (o.image IS NOT NULL) AS manual,
                o.version  AS manual_version,
                o.width    AS manual_width,
                o.height   AS manual_height,
                c.source   AS auto_source,
                CASE WHEN c.image IS NULL THEN NULL ELSE c.version END AS auto_version,
                c.width    AS auto_width,
                c.height   AS auto_height,
                o.updated_at,
                o.updated_by
           ${base}
          ORDER BY d.domain
          LIMIT $2 OFFSET $3`,
        [like, options.limit, options.offset],
      );

      const items: DomainLogoRow[] = res.rows.map((row) => {
        const blocked = row.blocked === true;
        const manual = row.manual;
        const auto = row.auto_version !== null;
        const state: DomainLogoRow['state'] = blocked
          ? 'blocked'
          : manual
            ? 'manual'
            : auto
              ? 'auto'
              : 'none';
        return {
          domain: row.domain,
          state,
          autoSource: (row.auto_source as LogoSource | null) ?? null,
          hasManual: manual,
          width: manual ? row.manual_width : row.auto_width,
          height: manual ? row.manual_height : row.auto_height,
          version: blocked ? null : manual ? row.manual_version : row.auto_version,
          updatedAt: row.updated_at?.toISOString() ?? null,
          updatedBy: row.updated_by,
        };
      });

      return { items, total: Number(totalRes.rows[0]?.n ?? 0) };
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Не удалось собрать список логотипов доменов');
      return { items: [], total: 0 };
    }
  }
}
