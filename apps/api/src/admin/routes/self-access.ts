/**
 * История административных входов — для ВЛАДЕЛЬЦА ящика.
 *
 * Спецификация (docs/admin-spec.md, раздел «Вход в ящик пользователя»)
 * требует прямо: «Владелец ящика видит такие входы в своей истории
 * действий». Таблица admin_mailbox_access при этом читалась ровно одним
 * маршрутом — админским, под админским правом `audit.read`. Пользовательского
 * маршрута не было ни одного, то есть механизм подотчётности не работал:
 * администратор читает чужую переписку, а владелец узнать об этом не может
 * никак. Причина входа записывается — и не показывается тому, ради кого
 * её и требуют указывать.
 *
 * Здесь это исправлено. Маршрут живёт в почтовом API (почтовая сессия,
 * почтовая cookie) и отдаёт ТОЛЬКО записи о своём ящике: адрес берётся
 * из сессии, а не из запроса, поэтому заглянуть в чужую историю нельзя
 * даже подставив параметр.
 *
 * Что показываем владельцу: кто входил (логин администратора), когда,
 * зачем (та самая обязательная причина) и закончился ли сеанс. Адрес,
 * с которого входил администратор, НЕ показываем: владельцу он ничего
 * не объясняет, а во внутренней сети это лишние сведения о сотрудниках.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError } from '../../errors.js';
import type { AdminContext } from '../types.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Чем закончился сеанс — человеческими словами. */
const END_REASONS: Readonly<Record<string, string>> = {
  leave: 'администратор вышел из ящика',
  logout: 'администратор вышел из админки',
  replaced: 'администратор перешёл в другой ящик',
  expired: 'истёк срок сеанса',
};

export async function mailboxAccessSelfRoutes(
  app: FastifyInstance,
  ctx: AdminContext,
): Promise<void> {
  app.get('/account/admin-access', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const q = querySchema.parse(request.query);

    const { rows, total } = await ctx.db.listMailboxAccessForOwner(
      session.email,
      q.limit,
      q.offset,
    );
    return {
      items: rows.map((row) => ({
        id: Number(row.id),
        /** Кто входил. Скрывать это от владельца ящика бессмысленно. */
        adminLogin: row.admin_login,
        reason: row.reason,
        startedAt: row.started_at.toISOString(),
        endedAt: row.ended_at?.toISOString() ?? null,
        /** Сеанс идёт прямо сейчас. */
        active: row.ended_at === null,
        endReason: row.end_reason,
        endReasonLabel: row.end_reason ? (END_REASONS[row.end_reason] ?? row.end_reason) : null,
      })),
      total,
      limit: q.limit,
      offset: q.offset,
    };
  });
}
