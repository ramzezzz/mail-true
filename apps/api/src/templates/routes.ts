/**
 * Маршруты шаблонов писем.
 *
 *   GET    /api/templates                  — список и доступность возможности
 *   POST   /api/templates                  — завести шаблон
 *   PUT    /api/templates/:id              — правка (название, тема, тело, вложения)
 *   DELETE /api/templates/:id              — удалить
 *   POST   /api/templates/order            — порядок в меню
 *   POST   /api/templates/:id/attachments  — выложить вложения шаблона во
 *                                            временное хранилище загрузок
 *
 * ------------------------------------------------------------------
 * ПРО ПОСЛЕДНИЙ МАРШРУТ
 * ------------------------------------------------------------------
 * Он и есть ответ на вопрос «как шаблон несёт вложения честно».
 *
 * Вложение попадает в письмо только через временное хранилище загрузок
 * (`UploadStore`, см. uploads.ts) — так устроена отправка, и трогать её
 * ради шаблонов нельзя: там живёт вся обработка отказов, отмена отправки
 * и отложенная отправка. Но само хранилище временное: `sweep()` удаляет
 * всё старше суток. Запомни шаблон идентификатор загрузки — и назавтра он
 * вставлял бы письмо без прайса, МОЛЧА.
 *
 * Поэтому байты шаблона лежат в базе (миграция 0026), а этот маршрут
 * кладёт их обратно во временное хранилище НОВОЙ загрузкой и отдаёт её
 * метаданные. Дальше окно написания добавляет их в черновик как обычные
 * вложения, а письмо уходит тем же кодом, что и всегда, ничего не зная
 * ни про какие шаблоны.
 *
 * Заодно это отвечает на вопрос, который иначе пришлось бы решать: что
 * будет, если человек уберёт вложение из письма после вставки шаблона.
 * Ничего — он уберёт КОПИЮ, шаблон останется как был.
 */
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import type { MailSession } from '../types.js';
import type { UploadMeta } from '../uploads.js';
import {
  isUndefinedTable,
  isUniqueViolation,
  type StoredAttachment,
  type TemplateStore,
} from './db.js';
import { sanitizeTemplateHtml, templateHasText } from './sanitize.js';
import {
  formatBytes,
  MAX_TEMPLATE_ATTACHMENTS,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
  MAX_TEMPLATES_PER_ACCOUNT,
  type MailTemplate,
  type TemplatesState,
} from './types.js';

/** Подсказка, если миграцию 0026 ещё не применили. */
export const TEMPLATES_MIGRATION_HINT =
  'Таблиц шаблонов писем нет. Примените ' +
  'infra/postgres/migrations/0026_mail_templates.sql к работающей базе.';

/** Возможности нет, потому что базы нет вовсе. */
export const TEMPLATES_NO_DATABASE =
  'Шаблоны писем недоступны: не настроена база данных (DATABASE_URL). ' +
  'Почта при этом работает как обычно.';

const uploadIdSchema = z.string().min(1).max(64);

const draftSchema = z.object({
  name: z.string().min(1).max(MAX_TEMPLATE_NAME_LENGTH),
  subject: z.string().max(MAX_TEMPLATE_SUBJECT_LENGTH).default(''),
  bodyHtml: z.string().max(MAX_TEMPLATE_BODY_LENGTH).default(''),
  attachmentIds: z.array(uploadIdSchema).max(MAX_TEMPLATE_ATTACHMENTS).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(MAX_TEMPLATE_NAME_LENGTH).optional(),
  subject: z.string().max(MAX_TEMPLATE_SUBJECT_LENGTH).optional(),
  bodyHtml: z.string().max(MAX_TEMPLATE_BODY_LENGTH).optional(),
  attachmentIds: z.array(uploadIdSchema).max(MAX_TEMPLATE_ATTACHMENTS).optional(),
});

/*
 * Идентификатор приходит строкой из адреса. Разбор именно такой, а не
 * `z.coerce.number()`: тот принимает «12abc» и пробелы, и шаблон номер 12
 * открывался бы по десятку разных адресов.
 */
const idParamSchema = z.object({ id: z.string().regex(/^[1-9][0-9]{0,17}$/u) });

const orderSchema = z.object({
  ids: z.array(z.number().int().positive()).max(MAX_TEMPLATES_PER_ACCOUNT),
});

export interface TemplatesDeps {
  store: TemplateStore | null;
  /** Почему возможности нет. Пусто — возможность есть. */
  unavailableReason: string;
}

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

/** Название без краевых пробелов и без переводов строк внутри. */
export function normalizeTemplateName(raw: string): string {
  return raw.replace(/\s+/gu, ' ').trim();
}

/**
 * Проверяет набор вложений целиком и объясняет отказ числами.
 *
 * Числа здесь не для красоты: «слишком большие вложения» ничего не говорит
 * человеку, у которого их четыре, — он не знает, какое убрать. «Вложения
 * шаблона весят 7 МБ, а можно 5 МБ» — говорит.
 */
export function checkAttachmentBudget(files: readonly StoredAttachment[]): void {
  if (files.length > MAX_TEMPLATE_ATTACHMENTS) {
    throw new BadRequestError(
      `В шаблон помещается не больше ${String(MAX_TEMPLATE_ATTACHMENTS)} вложений`,
    );
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TEMPLATE_BYTES) {
    throw new BadRequestError(
      `Вложения шаблона весят ${formatBytes(total)}, а помещается ${formatBytes(MAX_TEMPLATE_BYTES)}. ` +
        'Уберите лишнее или отправьте файл ссылкой.',
    );
  }
}

export async function templateRoutes(app: FastifyInstance, deps: TemplatesDeps): Promise<void> {
  const { uploads } = app.deps;

  const requireStore = (): TemplateStore => {
    if (!deps.store) throw new BadRequestError(deps.unavailableReason);
    return deps.store;
  };

  /** Отсутствующая таблица превращается в понятный отказ, а не в 500. */
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (isUndefinedTable(err)) throw new BadRequestError(TEMPLATES_MIGRATION_HINT);
      if (isUniqueViolation(err)) throw new BadRequestError('Шаблон с таким названием уже есть');
      throw err;
    }
  };

  /**
   * Забирает байты загрузок во владение шаблона.
   *
   * Сама загрузка при этом НЕ удаляется: те же файлы могут быть прикреплены
   * к письму, которое человек прямо сейчас пишет («сохранить как шаблон» не
   * означает «убрать вложения из письма»). Уборщик хранилища заберёт их
   * сам, когда придёт срок.
   */
  const takeUploads = async (ids: readonly string[]): Promise<StoredAttachment[]> => {
    const files: StoredAttachment[] = [];
    for (const id of ids) {
      const found = await uploads.get(id);
      if (!found) {
        /*
         * Молчаливый пропуск был бы худшим исходом: шаблон сохранился бы
         * «успешно», а прайса в нём не оказалось бы — и выяснилось бы это
         * у получателя. Загрузка пропадает по одной причине (прошли сутки),
         * и её надо назвать.
         */
        throw new BadRequestError(
          'Один из файлов больше не найден среди загрузок — прикрепите его заново.',
        );
      }
      files.push({
        filename: found.meta.filename,
        mimeType: found.meta.mimeType,
        size: found.meta.size,
        content: await readFile(found.path),
      });
    }
    checkAttachmentBudget(files);
    return files;
  };

  app.get(
    '/templates',
    { preHandler: app.requireSession },
    async (request): Promise<TemplatesState> => {
      const session = requireMailSession(request.mailSession);
      if (!deps.store) {
        return { available: false, reason: deps.unavailableReason, items: [] };
      }
      try {
        return { available: true, reason: null, items: await deps.store.list(session.email) };
      } catch (err) {
        if (isUndefinedTable(err)) {
          // Схемы нет — это не ошибка запроса, а отсутствие возможности.
          // Отвечать отказом значило бы показать человеку красную полосу
          // там, где правильный ответ — «раздела просто нет».
          return { available: false, reason: TEMPLATES_MIGRATION_HINT, items: [] };
        }
        throw err;
      }
    },
  );

  app.post('/templates', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = draftSchema.parse(request.body);
    const store = requireStore();

    const name = normalizeTemplateName(body.name);
    if (name === '') throw new BadRequestError('У шаблона должно быть название');

    const bodyHtml = sanitizeTemplateHtml(body.bodyHtml);
    const files = await takeUploads(body.attachmentIds ?? []);

    /*
     * Пустой шаблон отклоняется: заготовка без темы, текста и вложений —
     * это строка в меню, которая ничего не делает. Проверка идёт по
     * ВИДИМОМУ тексту, а не по разметке (см. templateHasText).
     */
    if (body.subject.trim() === '' && !templateHasText(bodyHtml) && files.length === 0) {
      throw new BadRequestError('Шаблон пустой: в нём нет ни темы, ни текста, ни вложений');
    }

    return guard(async () => {
      const existing = await store.list(session.email);
      if (existing.length >= MAX_TEMPLATES_PER_ACCOUNT) {
        throw new BadRequestError(
          `Шаблонов уже ${String(MAX_TEMPLATES_PER_ACCOUNT)} — больше не помещается. ` +
            'Удалите ненужные в настройках почты.',
        );
      }
      return store.create(session.email, { name, subject: body.subject, bodyHtml }, files);
    });
  });

  app.put('/templates/:id', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { id } = idParamSchema.parse(request.params);
    const patch = patchSchema.parse(request.body ?? {});
    const store = requireStore();

    const name = patch.name === undefined ? undefined : normalizeTemplateName(patch.name);
    if (name !== undefined && name === '') throw new BadRequestError('У шаблона должно быть название');

    /*
     * Вложения трогаются, ТОЛЬКО если о них сказали. Отсутствие поля и
     * пустой список — разные просьбы: первая значит «правлю название»,
     * вторая — «убери все вложения». Слей мы их в одно, переименование
     * шаблона стирало бы приложенный прайс — молча и необратимо.
     */
    const files = patch.attachmentIds === undefined ? null : await takeUploads(patch.attachmentIds);

    const updated = await guard(() =>
      store.update(
        session.email,
        Number(id),
        {
          ...(name !== undefined ? { name } : {}),
          ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
          ...(patch.bodyHtml !== undefined
            ? { bodyHtml: sanitizeTemplateHtml(patch.bodyHtml) }
            : {}),
        },
        files,
      ),
    );
    if (!updated) throw new NotFoundError(`Шаблон не найден: ${id}`);
    return updated;
  });

  app.delete('/templates/:id', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { id } = idParamSchema.parse(request.params);
    const removed = await guard(() => requireStore().remove(session.email, Number(id)));
    if (!removed) throw new NotFoundError(`Шаблон не найден: ${id}`);
    return { ok: true, id: removed.id, name: removed.name };
  });

  /**
   * Порядок в меню. Отдельным маршрутом, а не полем в правке шаблона:
   * порядок — свойство СПИСКА, и задавать его по одному шаблону значило бы
   * получать промежуточные состояния, в которых два шаблона делят позицию.
   */
  app.post('/templates/order', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { ids } = orderSchema.parse(request.body);
    const items = await guard(() => requireStore().reorder(session.email, ids));
    return { items };
  });

  /**
   * Вложения шаблона — во временное хранилище загрузок (см. шапку файла).
   *
   * Метод POST, а не GET, потому что запрос СОЗДАЁТ загрузки: повтор его
   * заводит новые файлы, и кэшировать такой ответ нельзя ни браузеру, ни
   * прокси.
   */
  app.post('/templates/:id/attachments', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { id } = idParamSchema.parse(request.params);
    const files = await guard(() => requireStore().contents(session.email, Number(id)));
    if (files === null) throw new NotFoundError(`Шаблон не найден: ${id}`);

    const created: UploadMeta[] = [];
    for (const file of files) {
      created.push(await uploads.save(file.filename, file.mimeType, Readable.from(file.content)));
    }
    return { attachments: created };
  });
}

export type { MailTemplate };
