/**
 * Алиасы: пересылка с одного адреса на другой.
 * Таблицу virtual_aliases напрямую читает Postfix, поэтому изменения
 * действуют сразу, без перезапуска.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addressProblem } from '@mail-true/shared';
import { checkAlias } from '../alias-check.js';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { ConflictError } from '../errors.js';
import { isUniqueViolation } from '../db.js';
import { audit, requireAdmin } from '../guard.js';
import { pathId } from '../../params.js';

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  domainId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Форму адреса здесь НЕ проверяем — этим занимается addressProblem, и он
 * объясняет отказ словами. У zod на всё про всё одна фраза «Некорректные
 * данные запроса»: из неё не видно ни что не так, ни где. Тот же довод
 * записан у ящиков (routes/users.ts), где это уже исправлено; здесь
 * оставалась прежняя проверка, и опечатка в кириллице — самая частая —
 * давала человеку бессмысленный ответ.
 */
const createSchema = z.object({
  source: z.string().trim().toLowerCase().min(1).max(1024),
  destination: z.string().trim().toLowerCase().min(1).max(1024),
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

  app.post(
    '/aliases',
    { preHandler: requireAdmin(app, 'aliases.write') },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      // Разбор адреса словами: «в адресе есть буквы не латинского
      // алфавита», а не общее «некорректные данные».
      const addressBad = addressProblem(body.source) ?? addressProblem(body.destination);
      if (addressBad) throw new BadRequestError(addressBad);
      /*
       * Связность проверяется ДО создания. Раньше проверялось ровно одно —
       * что адрес не указывает сам на себя, — а самая тяжёлая беда пропускалась
       * молча: алиас с адресом существующего ящика уводит всю его входящую
       * почту, потому что перенаправления разбираются раньше ящиков.
       * Подробности и остальные случаи — в admin/alias-check.ts.
       */
      const problem = await checkAlias(body.source, body.destination, {
        mailboxExists: async (email) => (await ctx.db.findMailUserByEmail(email)) !== null,
        aliasTarget: (source) => ctx.db.aliasTargetOf(source),
      });
      if (problem?.blocking) throw new BadRequestError(problem.message);
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
          after: {
            source: created.source,
            destination: created.destination,
            active: created.active,
          },
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
          // Непреграждающее предупреждение: алиас создан, но человеку стоит
          // знать, что путь ведёт на несуществующий адрес. Отказывать нельзя —
          // ящик могут завести следующим действием, а пересылка на внешний
          // адрес это вообще обычное дело.
          ...(problem ? { warning: problem.message } : {}),
        };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError('Такой алиас уже есть');
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/aliases/:id',
    { preHandler: requireAdmin(app, 'aliases.write') },
    async (request) => {
      const id = pathId(request.params.id, 'псевдонима');
      const body = patchSchema.parse(request.body);
      const before = await ctx.db.findAliasById(id);
      if (!before) throw new NotFoundError('Алиас не найден');

      /*
       * ВКЛЮЧЕНИЕ ПРОВЕРЯЕТСЯ ТАК ЖЕ, КАК СОЗДАНИЕ.
       *
       * Замок при создании алиаса стоит наглухо: адрес существующего
       * ящика уводит всю его входящую почту, потому что перенаправления
       * разбираются раньше ящиков. Но выключенный алиас этот замок
       * обходил целиком — и обходил буднично:
       *
       *   1. алиас `info@d.ru → arc@d.ru` создан, когда ящика ещё не было;
       *   2. алиас ОТКЛЮЧИЛИ (кнопка рядом с корзиной, выглядит безопаснее);
       *   3. завели ящик `info@d.ru` — проверка при создании ящика смотрит
       *      только на АКТИВНЫЕ алиасы и молчит;
       *   4. алиас включили обратно — здесь не проверялось ничего.
       *
       * Дальше вся входящая почта живого ящика уходит на сторону, а ящик
       * выглядит исправным: он в списке, в него пускают, старая почта на
       * месте — просто новая больше не приходит.
       */
      if (body.active && !before.active) {
        const problem = await checkAlias(before.source, before.destination, {
          mailboxExists: async (email) => (await ctx.db.findMailUserByEmail(email)) !== null,
          aliasTarget: (source) => ctx.db.aliasTargetOf(source),
        });
        if (problem?.blocking) throw new BadRequestError(problem.message);
      }

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
      const id = pathId(request.params.id, 'псевдонима');
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
