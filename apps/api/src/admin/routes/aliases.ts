/**
 * Алиасы: пересылка с одного адреса на другой.
 * Таблицу virtual_aliases напрямую читает Postfix, поэтому изменения
 * действуют сразу, без перезапуска.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { ConflictError } from '../errors.js';
import { isUniqueViolation } from '../db.js';
import { audit, requireAdmin } from '../guard.js';

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  domainId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createSchema = z.object({
  source: z.string().trim().toLowerCase().email().max(255),
  destination: z.string().trim().toLowerCase().email().max(255),
});

const patchSchema = z.object({ active: z.boolean() });

export async function adminAliasRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;

  app.get('/aliases', { preHandler: requireAdmin(app, 'aliases.read') }, async (request) => {
    const q = listQuerySchema.parse(request.query);
    const { rows, total } = await ctx.db.listAliases({
      search: q.search,
      domainId: q.domainId,
      limit: q.limit,
      offset: q.offset,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        source: r.source,
        destination: r.destination,
        domain: r.domain,
        domainId: r.domain_id,
        active: r.active,
        createdAt: r.created_at.toISOString(),
      })),
      total,
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.post('/aliases', { preHandler: requireAdmin(app, 'aliases.write') }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    if (body.source === body.destination) {
      throw new BadRequestError('Алиас не может указывать сам на себя');
    }
    const domainName = body.source.slice(body.source.indexOf('@') + 1);
    const domain = await ctx.db.resolveDomain(domainName, false);
    if (!domain) {
      throw new BadRequestError(
        `Домен «${domainName}» не заведён. Алиас можно создать только в своём домене.`,
      );
    }
    try {
      const created = await ctx.db.createAlias(domain.id, body.source, body.destination);
      await audit(ctx, request, {
        action: 'alias.create',
        targetType: 'alias',
        targetId: created.id,
        targetLabel: `${created.source} -> ${created.destination}`,
        after: { source: created.source, destination: created.destination, active: created.active },
      });
      reply.status(201);
      return {
        id: created.id,
        source: created.source,
        destination: created.destination,
        domain: created.domain,
        domainId: created.domain_id,
        active: created.active,
        createdAt: created.created_at.toISOString(),
      };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('Такой алиас уже есть');
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/aliases/:id',
    { preHandler: requireAdmin(app, 'aliases.write') },
    async (request) => {
      const id = Number(request.params.id);
      const body = patchSchema.parse(request.body);
      const before = await ctx.db.findAliasById(id);
      if (!before) throw new NotFoundError('Алиас не найден');
      const after = await ctx.db.setAliasActive(id, body.active);
      if (!after) throw new NotFoundError('Алиас не найден');
      await audit(ctx, request, {
        action: 'alias.update',
        targetType: 'alias',
        targetId: id,
        targetLabel: `${after.source} -> ${after.destination}`,
        before: { active: before.active },
        after: { active: after.active },
      });
      return {
        id: after.id,
        source: after.source,
        destination: after.destination,
        domain: after.domain,
        domainId: after.domain_id,
        active: after.active,
        createdAt: after.created_at.toISOString(),
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/aliases/:id',
    { preHandler: requireAdmin(app, 'aliases.write') },
    async (request) => {
      const id = Number(request.params.id);
      const before = await ctx.db.findAliasById(id);
      if (!before) throw new NotFoundError('Алиас не найден');
      await ctx.db.deleteAlias(id);
      await audit(ctx, request, {
        action: 'alias.delete',
        targetType: 'alias',
        targetId: id,
        targetLabel: `${before.source} -> ${before.destination}`,
        before: { source: before.source, destination: before.destination, active: before.active },
      });
      return { ok: true };
    },
  );
}
