/**
 * Журналы работы почты — по службам и по уровням.
 *
 * ОТКУДА. Общий том с файлами, в который пишут postfix, dovecot и сам
 * сервер приложения (см. infra/docker-compose.yml, том maillogs).
 * `docker compose logs` здесь недоступен: он требует сокета Docker, а тот
 * даёт права root на всей машине — за показ журналов такую дверь не
 * открывают. Службы поэтому пишут И в файл, И в stdout: админка читает
 * файл, `docker compose logs` работает как раньше.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Провёрнутых кусков журнала: раздел показывает текущий
 * файл. Что было раньше — в разделе истории доставки, она переживает
 * проворот, потому что лежит в базе. Наличие провёрнутых кусков видно
 * в ответе, чтобы не гадать, куда делось позавчера.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../guard.js';
import {
  LOG_FILE_NAMES,
  listLogFiles,
  listRotatedFiles,
  readLogPage,
  readLogTail,
} from '../log-files.js';
import { isServiceNoise, LOG_LEVELS, LOG_SOURCES, type LogSource } from '../mail-log.js';

const querySchema = z.object({
  /**
   * Показывать ли служебные строки: отчёты проверок живости и
   * внутренние обращения служб друг к другу. По умолчанию скрыты —
   * на одно письмо их приходятся десятки, и живая доставка тонет.
   */
  serviceNoise: z.coerce.boolean().default(false),
  source: z.enum(['postfix', 'dovecot', 'api']).default('postfix'),
  /** Порог важности: выбранный уровень и всё, что важнее. */
  level: z.enum(['error', 'warn', 'info', 'debug']).default('debug'),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  /** Курсор ленивой подгрузки: смещение в байтах. */
  before: z.coerce.number().int().min(0).optional(),
  /** Опознаватель файла из прошлого ответа — ловит проворот журнала. */
  fileId: z.string().max(64).optional(),
});

/**
 * Дочитывание новых строк для автообновления.
 *
 * Отдельный маршрут, а не «перечитай первую страницу»: перечитывание
 * не отличает новое от уже показанного и на быстром журнале теряет
 * строки между опросами. Здесь курсор точный — место в байтах.
 */
const tailSchema = z.object({
  serviceNoise: z.coerce.boolean().default(false),
  source: z.enum(['postfix', 'dovecot', 'api']).default('postfix'),
  level: z.enum(['error', 'warn', 'info', 'debug']).default('debug'),
  search: z.string().trim().max(200).optional(),
  after: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  fileId: z.string().max(64).optional(),
});

export async function adminLogRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const dir = ctx.config.MAIL_LOG_DIR;

  /** Какие журналы есть, насколько велики и когда обновлялись. */
  app.get('/logs/sources', { preHandler: requireAdmin(app, 'audit.read') }, async () => {
    const files = await listLogFiles(dir);
    const rotated = await Promise.all(
      LOG_SOURCES.map(async (source) => [source, await listRotatedFiles(dir, source)] as const),
    );
    const rotatedBySource = Object.fromEntries(rotated);
    return {
      dir,
      levels: LOG_LEVELS,
      items: files.map((file) => ({
        source: file.source,
        fileName: LOG_FILE_NAMES[file.source],
        present: file.present,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt?.toISOString() ?? null,
        /** Сколько провёрнутых кусков лежит рядом (их раздел не читает). */
        rotatedFiles: rotatedBySource[file.source]?.length ?? 0,
      })),
    };
  });

  /**
   * Страница журнала: свежие строки сверху.
   *
   * Право — audit.read: журналы работы почты содержат адреса отправителей
   * и получателей, то есть сведения о переписке. Показывать их всякому,
   * кто видит сводку, нельзя; это тот же круг лиц, что и у журнала аудита.
   */
  app.get('/logs', { preHandler: requireAdmin(app, 'audit.read') }, async (request) => {
    const q = querySchema.parse(request.query);
    const page = await readLogPage(dir, q.source as LogSource, {
      levelAtMost: q.level,
      search: q.search,
      serviceNoise: q.serviceNoise,
      limit: q.limit,
      before: q.before,
      fileId: q.fileId,
    });
    return {
      source: q.source,
      items: page.items.map((item) => ({
        offset: item.offset,
        level: item.level,
        at: item.at?.toISOString() ?? null,
        component: item.component,
        queueId: item.queueId,
        text: item.text,
        service: isServiceNoise(item.text),
      })),
      nextBefore: page.nextBefore,
      /** С этого места дочитываются новые строки при автообновлении. */
      tailOffset: page.tailOffset,
      fileId: page.fileId,
      sizeBytes: page.sizeBytes,
      /** Журнал провернулся между запросами — страница отдана с начала. */
      rotated: page.rotated,
      /**
       * Просмотр упёрся в потолок, не найдя ни одной подходящей строки.
       * Это не «ничего нет»: с тем же курсором надо просить дальше.
       */
      budgetExhausted: page.budgetExhausted,
    };
  });

  /** Только то, что дописано после `after`. Порядок — от старого к новому. */
  app.get('/logs/new', { preHandler: requireAdmin(app, 'audit.read') }, async (request) => {
    const q = tailSchema.parse(request.query);
    const tail = await readLogTail(dir, q.source as LogSource, {
      after: q.after,
      levelAtMost: q.level,
      search: q.search,
      serviceNoise: q.serviceNoise,
      limit: q.limit,
      fileId: q.fileId,
    });
    return {
      source: q.source,
      items: tail.items.map((item) => ({
        offset: item.offset,
        level: item.level,
        at: item.at?.toISOString() ?? null,
        component: item.component,
        queueId: item.queueId,
        text: item.text,
        service: isServiceNoise(item.text),
      })),
      nextAfter: tail.nextAfter,
      fileId: tail.fileId,
      sizeBytes: tail.sizeBytes,
      /** Журнал провернулся — прежнее место ничего не значит. */
      rotated: tail.rotated,
      /** Новых строк было больше предела: остальное придёт следующим запросом. */
      more: tail.more,
    };
  });
}
