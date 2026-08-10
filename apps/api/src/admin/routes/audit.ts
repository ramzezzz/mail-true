/**
 * Журнал аудита и журнал входов администраторов в чужие ящики.
 * Только чтение: удалять и править записи API не позволяет никому,
 * включая роль owner.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actionLabel } from '../audit.js';
import { requireAdmin } from '../guard.js';

const querySchema = z.object({
  action: z.string().trim().max(64).optional(),
  adminLogin: z.string().trim().max(128).optional(),
  /*
   * Перечисление обязано совпадать с тем, что РЕАЛЬНО пишется в журнал.
   *
   * Не совпадало: пункты «Перезапуски служб» и «Обновления сервера» есть
   * в выпадающем списке панели, записи такого вида есть в базе, а здесь
   * их не было — и выбор пункта отвечал «Некорректные данные запроса».
   * Отбор по настройкам сервера (в том числе замена сертификата) не был
   * возможен вовсе.
   */
  targetType: z
    .enum([
      'user',
      'alias',
      'domain',
      'admin',
      'mailbox',
      'settings',
      'serversettings',
      'service',
      'server',
      'branding',
      'backup',
      'migration',
      'antispam',
    ])
    .optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const accessQuerySchema = z.object({
  mailbox: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function adminAuditRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;

  app.get('/audit', { preHandler: requireAdmin(app, 'audit.read') }, async (request) => {
    const q = querySchema.parse(request.query);
    const { rows, total } = await ctx.db.listAudit({
      action: q.action,
      adminLogin: q.adminLogin,
      targetType: q.targetType,
      search: q.search,
      limit: q.limit,
      offset: q.offset,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        adminLogin: r.admin_login,
        action: r.action,
        actionLabel: actionLabel(r.action),
        targetType: r.target_type,
        targetId: r.target_id,
        targetLabel: r.target_label,
        ip: r.ip,
        oldValue: r.old_value ?? null,
        newValue: r.new_value ?? null,
        createdAt: r.created_at.toISOString(),
      })),
      total,
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get(
    '/audit/mailbox-access',
    { preHandler: requireAdmin(app, 'audit.read') },
    async (request) => {
      const q = accessQuerySchema.parse(request.query);
      const { rows, total } = await ctx.db.listMailboxAccess({
        mailboxEmail: q.mailbox,
        limit: q.limit,
        offset: q.offset,
      });
      return {
        items: rows.map((r) => ({
          id: r.id,
          adminLogin: r.admin_login,
          mailboxEmail: r.mailbox_email,
          reason: r.reason,
          ip: r.ip,
          startedAt: r.started_at.toISOString(),
          endedAt: r.ended_at?.toISOString() ?? null,
          /** Чем закончился сеанс; null вместе с endedAt — идёт прямо сейчас. */
          endReason: r.end_reason,
          active: r.ended_at === null,
        })),
        total,
        limit: q.limit,
        offset: q.offset,
      };
    },
  );
}
