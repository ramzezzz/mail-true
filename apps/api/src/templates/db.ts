/**
 * Хранилище шаблонов писем (таблицы mail_templates и
 * mail_template_attachments, миграция 0026).
 *
 * Своё подключение к Postgres — как у настроек, меток и адресной книги:
 * почта обязана читаться и без базы. Нет базы — нет шаблонов, и интерфейс
 * узнаёт об этом честно (`available: false`), а не показывает кнопку,
 * которая молча ничего не вставляет.
 *
 * Наружу торчит ИНТЕРФЕЙС, а не класс: маршруты общаются с хранилищем
 * только через него, поэтому проверки подставляют сюда хранилище в памяти
 * и проверяют всё поведение шаблонов без Postgres.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import {
  MAX_TEMPLATES_PER_ACCOUNT,
  TEMPLATE_LIST_BODY_CHARS,
  type MailTemplate,
  type TemplateAttachment,
} from './types.js';

/** Вложение вместе с байтами — так оно кладётся в базу и достаётся оттуда. */
export interface StoredAttachment extends Omit<TemplateAttachment, 'id'> {
  content: Buffer;
}

/** Поля шаблона без вложений: их правят по отдельности. */
export interface TemplateFields {
  name: string;
  subject: string;
  bodyHtml: string;
}

export type TemplateFieldsPatch = Partial<TemplateFields>;

export interface TemplateStore {
  /** Применена ли миграция 0026. */
  schemaReady(): Promise<boolean>;
  /**
   * Шаблоны ящика в порядке показа. Байты вложений НЕ читаются, а тело
   * обрезается до TEMPLATE_LIST_BODY_CHARS — длинное помечается
   * `bodyTruncated`, и за ним ходят в full().
   */
  list(accountEmail: string): Promise<MailTemplate[]>;
  /** Один шаблон целиком — с полным телом. */
  full(accountEmail: string, id: number): Promise<MailTemplate | null>;
  create(
    accountEmail: string,
    fields: TemplateFields,
    attachments: readonly StoredAttachment[],
  ): Promise<MailTemplate>;
  /**
   * Правка. `attachments === null` значит «не трогать вложения» — это
   * не то же самое, что пустой список («убрать все»): переименование
   * шаблона не должно стирать приложенный прайс.
   */
  update(
    accountEmail: string,
    id: number,
    patch: TemplateFieldsPatch,
    attachments: readonly StoredAttachment[] | null,
  ): Promise<MailTemplate | null>;
  remove(accountEmail: string, id: number): Promise<MailTemplate | null>;
  /** Порядок в меню. Присланные идентификаторы встают первыми, остальные — следом. */
  reorder(accountEmail: string, ids: readonly number[]): Promise<MailTemplate[]>;
  /**
   * Содержимое вложений шаблона. Единственное место, где из базы тянутся
   * байты, и зовётся оно только при вставке шаблона в письмо.
   */
  contents(accountEmail: string, id: number): Promise<StoredAttachment[] | null>;
}

/** Отсутствующая таблица (42P01) — миграция 0026 не применена. */
export function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

/** Нарушение уникальности (23505) — шаблон с таким названием уже есть. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

interface TemplateRow extends QueryResultRow {
  id: string | number;
  name: string;
  subject: string;
  body_html: string;
  position: number;
}

interface AttachmentRow extends QueryResultRow {
  id: string | number;
  template_id: string | number;
  filename: string;
  mime_type: string;
  size: number;
}

/**
 * BIGSERIAL приезжает из pg строкой: драйвер не приводит int8 к числу,
 * потому что не всякое int8 в число влезает. Наши идентификаторы влезают
 * с огромным запасом, а вот сравнение `row.id === id` со строкой молча
 * ложно — и правка шаблона «не находила» бы его.
 */
function toId(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export interface TemplatesDbOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

/**
 * Шаблонов уже столько, сколько разрешено.
 *
 * Отдельная ошибка, а не проверка в маршруте: считать до вставки — это
 * «прочитали список, решили, вставили», и между чтением и вставкой
 * пролезает второй такой же запрос. Повтор при обрыве связи или два
 * сохранения из разных вкладок пробивали потолок молча.
 */
export class TemplateLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Шаблонов уже ${String(limit)} — больше не помещается`);
    this.name = 'TemplateLimitError';
  }
}

export class TemplatesDb implements TemplateStore {
  readonly #pool: Pool;

  constructor(opts: TemplatesDbOptions) {
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#pool.on('error', (err) =>
      opts.logger.warn(errorInfo(err), 'Ошибка пула Postgres (шаблоны писем)'),
    );
  }

  async shutdown(): Promise<void> {
    await this.#pool.end();
  }

  async #query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(text, values);
    return result.rows;
  }

  /**
   * Всё, что меняет шаблон вместе с вложениями, идёт одной сделкой.
   *
   * Иначе оборвавшаяся правка оставила бы шаблон с новым текстом и старыми
   * вложениями — состояние, которого человек не видел ни до, ни после.
   */
  async #tx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async schemaReady(): Promise<boolean> {
    const rows = await this.#query<{ ok: boolean }>(
      `SELECT to_regclass('public.mail_templates') IS NOT NULL
          AND to_regclass('public.mail_template_attachments') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async list(accountEmail: string): Promise<MailTemplate[]> {
    const rows = await this.#query<TemplateRow>(
      `SELECT id, name, subject, body_html, position FROM mail_templates
        WHERE lower(account_email) = lower($1)
        ORDER BY position, id`,
      [accountEmail],
    );
    if (rows.length === 0) return [];

    /*
     * Вложения добираются ОДНИМ запросом на весь список, а не по запросу
     * на шаблон: пятнадцать заготовок означали бы шестнадцать оборотов к
     * базе на каждое открытие меню «Шаблоны». Байты при этом не читаются —
     * в списке нужны только имя и размер (см. шапку миграции 0026).
     */
    const ids = rows.map((r) => toId(r.id));
    const files = await this.#query<AttachmentRow>(
      `SELECT id, template_id, filename, mime_type, size FROM mail_template_attachments
        WHERE template_id = ANY($1::bigint[])
        ORDER BY position, id`,
      [ids],
    );

    const byTemplate = new Map<number, TemplateAttachment[]>();
    for (const file of files) {
      const key = toId(file.template_id);
      const bucket = byTemplate.get(key) ?? [];
      bucket.push({
        id: toId(file.id),
        filename: file.filename,
        mimeType: file.mime_type,
        size: file.size,
      });
      byTemplate.set(key, bucket);
    }

    return rows.map((row) => {
      /*
       * Тело в списке ОБРЕЗАЕТСЯ.
       *
       * Список запрашивается при открытии окна написания и на каждой
       * странице настроек, а тело допускается до 512 КБ при сотне
       * шаблонов на ящик — до полусотни мегабайт в одном ответе. В меню
       * при этом видно первые полсотни символов.
       *
       * Целое тело нужно вставке в письмо и правке; обе умеют дочитать
       * шаблон по номеру, увидев признак `bodyTruncated`.
       */
      const body = row.body_html;
      const cut = body.length > TEMPLATE_LIST_BODY_CHARS;
      return {
        id: toId(row.id),
        name: row.name,
        subject: row.subject,
        bodyHtml: cut ? body.slice(0, TEMPLATE_LIST_BODY_CHARS) : body,
        ...(cut ? { bodyTruncated: true } : {}),
        position: row.position,
        attachments: byTemplate.get(toId(row.id)) ?? [],
      };
    });
  }

  /**
   * Один шаблон ЦЕЛИКОМ.
   *
   * Отдельным запросом, а не выборкой из list(): список обрезает тело, и
   * вставка шаблона в письмо получила бы половину текста. Раньше этот
   * метод и правда брал шаблон из списка — тогда список был полным.
   */
  async full(accountEmail: string, id: number): Promise<MailTemplate | null> {
    const rows = await this.#query<TemplateRow>(
      `SELECT id, name, subject, body_html, position FROM mail_templates
        WHERE id = $1 AND lower(account_email) = lower($2)`,
      [id, accountEmail],
    );
    const row = rows[0];
    if (!row) return null;

    const files = await this.#query<AttachmentRow>(
      `SELECT id, template_id, filename, mime_type, size FROM mail_template_attachments
        WHERE template_id = $1 ORDER BY position, id`,
      [id],
    );
    return {
      id: toId(row.id),
      name: row.name,
      subject: row.subject,
      bodyHtml: row.body_html,
      position: row.position,
      attachments: files.map((file) => ({
        id: toId(file.id),
        filename: file.filename,
        mimeType: file.mime_type,
        size: file.size,
      })),
    };
  }

  async #one(accountEmail: string, id: number): Promise<MailTemplate | null> {
    return this.full(accountEmail, id);
  }

  async #putAttachments(
    client: PoolClient,
    templateId: number,
    attachments: readonly StoredAttachment[],
  ): Promise<void> {
    await client.query(`DELETE FROM mail_template_attachments WHERE template_id = $1`, [
      templateId,
    ]);
    let position = 0;
    for (const file of attachments) {
      await client.query(
        `INSERT INTO mail_template_attachments
           (template_id, filename, mime_type, size, content, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [templateId, file.filename, file.mimeType, file.size, file.content, position],
      );
      position += 1;
    }
  }

  async create(
    accountEmail: string,
    fields: TemplateFields,
    attachments: readonly StoredAttachment[],
  ): Promise<MailTemplate> {
    const id = await this.#tx(async (client) => {
      /*
       * Предел проверяется ЗДЕСЬ, внутри той же транзакции, что и
       * вставка, и под блокировкой по ящику.
       *
       * Блокировка нужна потому, что блокировать нечего: строки-владельца
       * у ящика нет, а `count(*) ... FOR UPDATE` Postgres не разрешает
       * (с агрегатом нельзя). Советующая блокировка по хешу адреса
       * выстраивает создание шаблонов одного ящика в очередь и
       * отпускается сама вместе с транзакцией.
       */
      await client.query(`SELECT pg_advisory_xact_lock(hashtext(lower($1)))`, [accountEmail]);
      const counted = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM mail_templates WHERE lower(account_email) = lower($1)`,
        [accountEmail],
      );
      if (Number(counted.rows[0]?.n ?? '0') >= MAX_TEMPLATES_PER_ACCOUNT) {
        throw new TemplateLimitError(MAX_TEMPLATES_PER_ACCOUNT);
      }

      const inserted = await client.query<TemplateRow>(
        `INSERT INTO mail_templates (account_email, name, subject, body_html, position)
         VALUES (lower($1), $2, $3, $4,
                 coalesce((SELECT max(position) + 1 FROM mail_templates
                            WHERE lower(account_email) = lower($1)), 0))
         RETURNING id, name, subject, body_html, position`,
        [accountEmail, fields.name, fields.subject, fields.bodyHtml],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Не удалось создать шаблон');
      const newId = toId(row.id);
      await this.#putAttachments(client, newId, attachments);
      return newId;
    });
    const created = await this.#one(accountEmail, id);
    if (!created) throw new Error('Не удалось создать шаблон');
    return created;
  }

  async update(
    accountEmail: string,
    id: number,
    patch: TemplateFieldsPatch,
    attachments: readonly StoredAttachment[] | null,
  ): Promise<MailTemplate | null> {
    const found = await this.#tx(async (client) => {
      const sets: string[] = [];
      const values: unknown[] = [];
      const put = (column: string, value: unknown): void => {
        values.push(value);
        sets.push(`${column} = $${String(values.length)}`);
      };
      if (patch.name !== undefined) put('name', patch.name);
      if (patch.subject !== undefined) put('subject', patch.subject);
      if (patch.bodyHtml !== undefined) put('body_html', patch.bodyHtml);

      if (sets.length > 0) {
        values.push(accountEmail, id);
        const updated = await client.query<TemplateRow>(
          `UPDATE mail_templates SET ${sets.join(', ')}, updated_at = now()
            WHERE lower(account_email) = lower($${String(values.length - 1)})
              AND id = $${String(values.length)}
           RETURNING id`,
          values,
        );
        if (updated.rows.length === 0) return false;
      } else {
        const exists = await client.query(
          `SELECT 1 FROM mail_templates WHERE lower(account_email) = lower($1) AND id = $2`,
          [accountEmail, id],
        );
        if (exists.rows.length === 0) return false;
      }

      if (attachments !== null) await this.#putAttachments(client, id, attachments);
      return true;
    });
    if (!found) return null;
    return this.#one(accountEmail, id);
  }

  async remove(accountEmail: string, id: number): Promise<MailTemplate | null> {
    const before = await this.#one(accountEmail, id);
    if (!before) return null;
    // Вложения уходят сами: ON DELETE CASCADE в миграции 0026.
    await this.#query(
      `DELETE FROM mail_templates WHERE lower(account_email) = lower($1) AND id = $2`,
      [accountEmail, id],
    );
    return before;
  }

  async reorder(accountEmail: string, ids: readonly number[]): Promise<MailTemplate[]> {
    await this.#tx(async (client) => {
      let position = 0;
      for (const id of ids) {
        await client.query(
          `UPDATE mail_templates SET position = $1, updated_at = now()
            WHERE lower(account_email) = lower($2) AND id = $3`,
          [position, accountEmail, id],
        );
        position += 1;
      }
      /*
       * Не названные в запросе шаблоны уезжают ЗА названные, сохраняя свой
       * прежний относительный порядок. Иначе шаблон, заведённый во второй
       * вкладке между показом списка и перетаскиванием, получил бы позицию
       * 0 и молча встал бы первым.
       */
      await client.query(
        `UPDATE mail_templates SET position = position + $1
          WHERE lower(account_email) = lower($2) AND NOT (id = ANY($3::bigint[]))`,
        [ids.length, accountEmail, [...ids]],
      );
    });
    return this.list(accountEmail);
  }

  async contents(accountEmail: string, id: number): Promise<StoredAttachment[] | null> {
    /*
     * Принадлежность шаблона ящику проверяется В ЭТОМ ЖЕ запросе, а не
     * отдельной выборкой до него: иначе между проверкой и чтением байтов
     * лежал бы промежуток, и соединение таблиц ради этого дешевле, чем
     * рассуждения о том, что за это время могло произойти.
     */
    const owned = await this.#query<{ id: string | number }>(
      `SELECT id FROM mail_templates WHERE lower(account_email) = lower($1) AND id = $2`,
      [accountEmail, id],
    );
    if (owned.length === 0) return null;

    const rows = await this.#query<AttachmentRow & { content: Buffer }>(
      `SELECT a.id, a.template_id, a.filename, a.mime_type, a.size, a.content
         FROM mail_template_attachments a
         JOIN mail_templates t ON t.id = a.template_id
        WHERE lower(t.account_email) = lower($1) AND t.id = $2
        ORDER BY a.position, a.id`,
      [accountEmail, id],
    );
    return rows.map((row) => ({
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      content: row.content,
    }));
  }
}

/**
 * Хранилище в памяти — для проверок.
 *
 * Живёт рядом с настоящим, а не в файле проверок, потому что обязано
 * повторять его поведение слово в слово: порядок, `null` на правку
 * несуществующего шаблона, «не трогать вложения» при `attachments === null`
 * и отказ на повтор названия. Разошлись бы — проверки перестали бы
 * что-либо доказывать.
 */
export class MemoryTemplateStore implements TemplateStore {
  readonly #byAccount = new Map<string, Array<MailTemplate & { files: StoredAttachment[] }>>();
  #seq = 0;

  #bucket(accountEmail: string): Array<MailTemplate & { files: StoredAttachment[] }> {
    const key = accountEmail.toLowerCase();
    const found = this.#byAccount.get(key);
    if (found) return found;
    const created: Array<MailTemplate & { files: StoredAttachment[] }> = [];
    this.#byAccount.set(key, created);
    return created;
  }

  #visible(item: MailTemplate & { files: StoredAttachment[] }): MailTemplate {
    return {
      id: item.id,
      name: item.name,
      subject: item.subject,
      bodyHtml: item.bodyHtml,
      position: item.position,
      attachments: item.files.map((f, index) => ({
        id: index + 1,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
      })),
    };
  }

  async schemaReady(): Promise<boolean> {
    return true;
  }

  async list(accountEmail: string): Promise<MailTemplate[]> {
    // Обрезаем так же, как настоящее хранилище: иначе проверки не
    // поймали бы код, который забыл дочитать длинный шаблон.
    return this.#bucket(accountEmail)
      .slice()
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((item) => {
        const visible = this.#visible(item);
        if (visible.bodyHtml.length <= TEMPLATE_LIST_BODY_CHARS) return visible;
        return {
          ...visible,
          bodyHtml: visible.bodyHtml.slice(0, TEMPLATE_LIST_BODY_CHARS),
          bodyTruncated: true,
        };
      });
  }

  async full(accountEmail: string, id: number): Promise<MailTemplate | null> {
    const found = this.#bucket(accountEmail).find((item) => item.id === id);
    return found ? this.#visible(found) : null;
  }

  async create(
    accountEmail: string,
    fields: TemplateFields,
    attachments: readonly StoredAttachment[],
  ): Promise<MailTemplate> {
    const bucket = this.#bucket(accountEmail);
    // Предел — как в настоящем хранилище: он часть договора, а не
    // проверка маршрута.
    if (bucket.length >= MAX_TEMPLATES_PER_ACCOUNT) {
      throw new TemplateLimitError(MAX_TEMPLATES_PER_ACCOUNT);
    }
    if (bucket.some((t) => t.name.toLowerCase() === fields.name.toLowerCase())) {
      // Тот же отказ, что даёт уникальный индекс в базе, — с тем же кодом,
      // иначе маршрут проверялся бы против поведения, которого нет.
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    const position = bucket.reduce((max, t) => Math.max(max, t.position + 1), 0);
    const created = {
      id: ++this.#seq,
      name: fields.name,
      subject: fields.subject,
      bodyHtml: fields.bodyHtml,
      position,
      attachments: [],
      files: [...attachments],
    };
    bucket.push(created);
    return this.#visible(created);
  }

  async update(
    accountEmail: string,
    id: number,
    patch: TemplateFieldsPatch,
    attachments: readonly StoredAttachment[] | null,
  ): Promise<MailTemplate | null> {
    const bucket = this.#bucket(accountEmail);
    const current = bucket.find((t) => t.id === id);
    if (!current) return null;
    if (
      patch.name !== undefined &&
      bucket.some((t) => t.id !== id && t.name.toLowerCase() === patch.name?.toLowerCase())
    ) {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    }
    if (patch.name !== undefined) current.name = patch.name;
    if (patch.subject !== undefined) current.subject = patch.subject;
    if (patch.bodyHtml !== undefined) current.bodyHtml = patch.bodyHtml;
    if (attachments !== null) current.files = [...attachments];
    return this.#visible(current);
  }

  async remove(accountEmail: string, id: number): Promise<MailTemplate | null> {
    const bucket = this.#bucket(accountEmail);
    const index = bucket.findIndex((t) => t.id === id);
    const removed = bucket[index];
    if (!removed) return null;
    bucket.splice(index, 1);
    return this.#visible(removed);
  }

  async reorder(accountEmail: string, ids: readonly number[]): Promise<MailTemplate[]> {
    const bucket = this.#bucket(accountEmail);
    ids.forEach((id, index) => {
      const found = bucket.find((t) => t.id === id);
      if (found) found.position = index;
    });
    for (const item of bucket) {
      if (!ids.includes(item.id)) item.position += ids.length;
    }
    return this.list(accountEmail);
  }

  async contents(accountEmail: string, id: number): Promise<StoredAttachment[] | null> {
    const found = this.#bucket(accountEmail).find((t) => t.id === id);
    return found ? found.files.map((f) => ({ ...f })) : null;
  }
}
