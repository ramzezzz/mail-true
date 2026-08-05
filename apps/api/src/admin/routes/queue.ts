/**
 * Очередь писем и история обработанных.
 *
 * Два раздела одного экрана и два совершенно разных источника:
 *
 *   /queue         — что лежит в очереди ПРЯМО СЕЙЧАС. Спрашивается у
 *                    посредника в контейнере postfix (postqueue -j).
 *                    Данные всегда свежие, истории у них нет: доставленное
 *                    письмо исчезает из очереди вместе со своим файлом.
 *   /queue/history — что УЖЕ обработано. Разобранный журнал Postfix
 *                    (см. flow-collector.ts). Другого источника не
 *                    существует, и глубина у него ограничена — сколько
 *                    именно, честно сказано в /queue/history/stats.
 *
 * Действия над очередью (протолкнуть, удалить) требуют права на запись и
 * пишутся в журнал аудита — как и всё остальное, что меняет состояние.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FlowStore } from '../flow-store.js';
import { audit, requireAdmin } from '../guard.js';
import { queueMatches, type QueueMessage } from '../queue-agent.js';

const listSchema = z.object({
  search: z.string().trim().max(200).optional(),
  /** Где лежит: deferred / active / incoming / hold. */
  queueName: z.string().trim().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const idSchema = z.object({ id: z.string().trim().min(5).max(32) });

const historySchema = z.object({
  /** Окно времени. По умолчанию — сутки: столько обычно и ищут. */
  hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
  status: z
    .enum(['sent', 'deferred', 'bounced', 'expired', 'rejected', 'held'])
    .optional(),
  direction: z.enum(['in', 'out', 'unknown']).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Курсор ленивой подгрузки: пара «время + идентификатор» последней строки. */
  beforeTime: z.string().datetime().optional(),
  beforeId: z.string().regex(/^\d+$/).max(20).optional(),
  /** Обратный курсор автообновления: что появилось новее верхней строки. */
  afterTime: z.string().datetime().optional(),
  afterId: z.string().regex(/^\d+$/).max(20).optional(),
});

function queueView(message: QueueMessage): Record<string, unknown> {
  return {
    queueId: message.queueId,
    queueName: message.queueName,
    arrivalTime: message.arrivalTime.toISOString(),
    sizeBytes: message.sizeBytes,
    sender: message.sender,
    recipients: message.recipients.map((r) => ({
      address: r.address,
      delayReason: r.delayReason,
    })),
    reason: message.reason,
  };
}

export async function adminQueueRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const agent = ctx.queueAgent;
  const flow = new FlowStore(ctx.db);

  /* ---------------------------------------------------------------- */
  /* Очередь сейчас                                                     */
  /* ---------------------------------------------------------------- */

  app.get('/queue', { preHandler: requireAdmin(app, 'overview.read') }, async (request) => {
    const q = listSchema.parse(request.query);
    const snapshot = await agent.snapshot();

    const needle = q.search?.toLowerCase() ?? '';
    const filtered = snapshot.messages.filter(
      (m) =>
        (q.queueName === undefined || m.queueName === q.queueName) &&
        queueMatches(m, needle),
    );

    // Счётчики считаем по ВСЕЙ очереди, а не по отфильтрованному куску:
    // «в отложенных 12 тысяч» — это состояние сервера, оно не должно
    // меняться от того, что человек набрал в поиске.
    const byQueue: Record<string, number> = {};
    for (const message of snapshot.messages) {
      byQueue[message.queueName] = (byQueue[message.queueName] ?? 0) + 1;
    }

    return {
      items: filtered.slice(q.offset, q.offset + q.limit).map(queueView),
      total: filtered.length,
      limit: q.limit,
      offset: q.offset,
      queueTotal: snapshot.messages.length,
      byQueue,
      truncated: snapshot.truncated,
      takenAt: snapshot.takenAt.toISOString(),
    };
  });

  /** Письмо очереди целиком: конверт, заголовки, начало тела. */
  app.get('/queue/:id/message', { preHandler: requireAdmin(app, 'overview.read') }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const result = await agent.message(id);
    return { queueId: id, text: result.text, truncated: result.truncated };
  });

  /**
   * Попробовать доставить сейчас.
   *
   * Право берём users.write, а не overview.read: это действие, а не
   * просмотр. Читатель («Только чтение») очередь видит, но не трогает.
   */
  app.post('/queue/:id/flush', { preHandler: requireAdmin(app, 'users.write') }, async (request) => {
    const { id } = idSchema.parse(request.params);
    await agent.flush(id);
    await audit(ctx, request, {
      action: 'queue.flush',
      targetType: 'settings',
      targetLabel: `Очередь: ${id}`,
      after: { queueId: id, action: 'flush' },
    });
    return { ok: true };
  });

  /**
   * Удалить письмо из очереди.
   *
   * Действие необратимое: письмо исчезает совсем, отправитель отбойника
   * не получит. Поэтому право самое сильное из читаемых админкой
   * (users.delete) и обязательная запись в аудит с адресатами — чтобы
   * потом было видно не только «удалили ABC», но и что это было за письмо.
   */
  app.post('/queue/:id/delete', { preHandler: requireAdmin(app, 'users.delete') }, async (request) => {
    const { id } = idSchema.parse(request.params);
    // Сведения о письме забираем ДО удаления: после него их взять неоткуда.
    const snapshot = await agent.snapshot();
    const doomed = snapshot.messages.find((m) => m.queueId === id);
    await agent.remove(id);
    await audit(ctx, request, {
      action: 'queue.delete',
      targetType: 'settings',
      targetLabel: `Очередь: ${id}`,
      before: doomed
        ? {
            queueId: id,
            sender: doomed.sender,
            recipients: doomed.recipients.map((r) => r.address),
            sizeBytes: doomed.sizeBytes,
            arrivalTime: doomed.arrivalTime.toISOString(),
          }
        : { queueId: id },
      after: null,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* История обработанных                                               */
  /* ---------------------------------------------------------------- */

  app.get('/queue/history', { preHandler: requireAdmin(app, 'overview.read') }, async (request) => {
    const q = historySchema.parse(request.query);
    const to = new Date();
    const from = new Date(to.getTime() - q.hours * 3600 * 1000);
    // Просим на одну строку больше предела: так узнаём, есть ли ещё, не
    // пересчитывая всю выборку. Считать total на сотнях тысяч строк ради
    // одной подгрузки — это секунды ожидания на каждую прокрутку.
    const rows = await flow.listEvents({
      from,
      to,
      statuses: q.status ? [q.status] : undefined,
      direction: q.direction,
      search: q.search?.toLowerCase(),
      beforeTime: q.beforeTime ? new Date(q.beforeTime) : undefined,
      beforeId: q.beforeId,
      afterTime: q.afterTime ? new Date(q.afterTime) : undefined,
      afterId: q.afterId,
      limit: q.limit + 1,
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at.toISOString(),
        queueId: r.queue_id,
        direction: r.direction,
        status: r.status,
        sender: r.sender,
        recipient: r.recipient,
        relay: r.relay,
        delaySeconds: r.delay_seconds === null ? null : Number(r.delay_seconds),
        sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
        dsn: r.dsn,
        reason: r.reason,
      })),
      hasMore,
      nextBefore: hasMore && last ? { time: last.occurred_at.toISOString(), id: last.id } : null,
      limit: q.limit,
    };
  });

  /**
   * Сводка по окну и — главное — С КАКОГО МОМЕНТА вообще есть история.
   *
   * Последнее не украшение: разбор журнала начинается с установки, и
   * показать «за 90 суток» пустую таблицу, когда данным час, значит
   * соврать. Интерфейс обязан сказать глубину прямо.
   */
  app.get('/queue/history/stats', { preHandler: requireAdmin(app, 'overview.read') }, async (request) => {
    const q = z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) })
      .parse(request.query);
    const to = new Date();
    const from = new Date(to.getTime() - q.hours * 3600 * 1000);
    const [stats, cursor] = await Promise.all([
      flow.stats(from, to),
      flow.getCursor('postfix'),
    ]);
    return {
      hours: q.hours,
      counts: stats.counts,
      total: stats.total,
      oldest: stats.oldest?.toISOString() ?? null,
      newest: stats.newest?.toISOString() ?? null,
      /** Когда разбор журнала увидел первую строку. */
      collectingSince: cursor?.startedAt.toISOString() ?? null,
      retentionDays: ctx.config.MAIL_FLOW_RETENTION_DAYS,
      maxRows: ctx.config.MAIL_FLOW_MAX_ROWS,
      queueAgentConfigured: agent.configured,
    };
  });
}
