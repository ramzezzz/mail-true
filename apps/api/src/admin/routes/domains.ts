/**
 * Домены и проверка DNS.
 *
 * Проверка DNS — главный раздел этой части админки: именно на записях
 * MX/SPF/DKIM/DMARC/PTR спотыкаются при установке почтового сервера.
 * Ответ содержит не только вердикт, но и готовое значение записи
 * и объяснение, что именно сделать.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { ConflictError } from '../errors.js';
import { isUniqueViolation, type DomainRow } from '../db.js';
import { audit, requireAdmin } from '../guard.js';
import { buildDkimRecord, buildDmarcRecord, buildSpfRecord, checkDomainDns } from '../dns.js';

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(255)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u, {
      message: 'Похоже, это не доменное имя',
    }),
});

const settingsSchema = z.object({
  dkimSelector: z.string().trim().min(1).max(64).optional(),
  dkimPublicKey: z.string().trim().max(4096).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

function toDto(row: DomainRow, mailHostname: string): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    userCount: Number(row.user_count),
    aliasCount: Number(row.alias_count),
    dkimSelector: row.dkim_selector ?? 'mail',
    dkimPublicKey: row.dkim_public_key,
    dnsStatus: row.dns_status ?? null,
    dnsCheckedAt: row.dns_checked_at?.toISOString() ?? null,
    dnsOverall: row.dns_overall ?? 'unknown',
    createdAt: row.created_at.toISOString(),
    /** Готовые значения для панели регистратора — можно копировать сразу. */
    recommended: {
      mx: `10 ${mailHostname}.`,
      spf: buildSpfRecord(mailHostname),
      dmarc: buildDmarcRecord(row.name),
      dkim: row.dkim_public_key ? buildDkimRecord(row.dkim_public_key) : null,
      autoconfig: `${mailHostname}.`,
    },
  };
}

export async function adminDomainRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const host = ctx.config.MAIL_HOSTNAME;

  app.get('/domains', { preHandler: requireAdmin(app, 'domains.read') }, async () => {
    const rows = await ctx.db.listDomains();
    return { items: rows.map((r) => toDto(r, host)) };
  });

  app.get<{ Params: { id: string } }>(
    '/domains/:id',
    { preHandler: requireAdmin(app, 'domains.read') },
    async (request) => {
      const row = await ctx.db.findDomainById(Number(request.params.id));
      if (!row) throw new NotFoundError('Домен не найден');
      return toDto(row, host);
    },
  );

  app.post('/domains', { preHandler: requireAdmin(app, 'domains.write') }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const existing = await ctx.db.resolveDomain(body.name, false);
    if (existing) throw new ConflictError(`Домен ${body.name} уже добавлен`);
    try {
      const domain = await ctx.db.resolveDomain(body.name, true);
      if (!domain) throw new BadRequestError('Не удалось добавить домен');
      await audit(ctx, request, {
        action: 'domain.create',
        targetType: 'domain',
        targetId: domain.id,
        targetLabel: domain.name,
        after: { name: domain.name },
      });
      const row = await ctx.db.findDomainById(domain.id);
      reply.status(201);
      return row ? toDto(row, host) : { id: domain.id, name: domain.name };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`Домен ${body.name} уже добавлен`);
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/domains/:id',
    { preHandler: requireAdmin(app, 'domains.write') },
    async (request) => {
      const id = Number(request.params.id);
      const body = settingsSchema.parse(request.body);
      const before = await ctx.db.findDomainById(id);
      if (!before) throw new NotFoundError('Домен не найден');

      const patch: {
        dkimSelector?: string;
        dkimPublicKey?: string | null;
        dkimDnsRecord?: string | null;
        notes?: string | null;
      } = {};
      if (body.dkimSelector !== undefined) patch.dkimSelector = body.dkimSelector;
      if (body.dkimPublicKey !== undefined) {
        patch.dkimPublicKey = body.dkimPublicKey;
        patch.dkimDnsRecord = body.dkimPublicKey ? buildDkimRecord(body.dkimPublicKey) : null;
      }
      if (body.notes !== undefined) patch.notes = body.notes;

      await ctx.db.saveDomainSettings(id, patch);
      const after = await ctx.db.findDomainById(id);
      await audit(ctx, request, {
        action: 'domain.update',
        targetType: 'domain',
        targetId: id,
        targetLabel: before.name,
        before: { dkim_selector: before.dkim_selector, dkim_public_key: before.dkim_public_key },
        after: { dkim_selector: after?.dkim_selector, dkim_public_key: after?.dkim_public_key },
      });
      return after ? toDto(after, host) : {};
    },
  );

  /**
   * Удаление домена.
   *
   * В схеме у virtual_aliases стоит каскадное удаление, поэтому удаление
   * домена молча уносит с собой ВСЕ его алиасы. Для ящиков защита была
   * сделана, для алиасов — забыли: удаление отвечало 200, алиасов
   * становилось ноль, ни предупреждения, ни следа в журнале аудита.
   *
   * Теперь алиасы считаются наравне с ящиками: по умолчанию удаление
   * отклоняется, а осознанное удаление вместе с алиасами требует явного
   * `?force=true` — и тогда полный список уничтоженных алиасов попадает
   * в журнал аудита, чтобы потом было видно, что именно исчезло.
   */
  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/domains/:id',
    { preHandler: requireAdmin(app, 'domains.write') },
    async (request) => {
      const id = Number(request.params.id);
      const force = request.query.force === 'true' || request.query.force === '1';
      const row = await ctx.db.findDomainById(id);
      if (!row) throw new NotFoundError('Домен не найден');
      if (Number(row.user_count) > 0) {
        throw new BadRequestError(
          `В домене ещё ${row.user_count} ящик(ов). Удаление домена уничтожит их записи — сначала перенесите или удалите ящики.`,
        );
      }

      const aliasCount = Number(row.alias_count);
      if (aliasCount > 0 && !force) {
        throw new BadRequestError(
          `В домене ещё ${String(aliasCount)} алиас(ов). Удаление домена уничтожит их вместе с ним — ` +
            'сначала удалите алиасы или повторите запрос с параметром force=true, ' +
            'тогда список удалённых алиасов попадёт в журнал аудита.',
        );
      }

      // Список забираем ДО удаления: после каскада восстановить его неоткуда.
      const doomed =
        aliasCount > 0
          ? (await ctx.db.listAliases({ domainId: id, limit: 500, offset: 0 })).rows.map((a) => ({
              source: a.source,
              destination: a.destination,
              active: a.active,
            }))
          : [];

      await ctx.db.deleteDomain(id);
      await audit(ctx, request, {
        action: 'domain.delete',
        targetType: 'domain',
        targetId: id,
        targetLabel: row.name,
        // Журнал показывает «было -> стало»: поля перечислены в обеих
        // половинах, иначе diffValues отбросит то, чего нет в «стало».
        before: {
          name: row.name,
          alias_count: aliasCount,
          // Уничтоженные каскадом алиасы — единственный их след после удаления.
          aliases_removed: doomed,
        },
        after: { name: null, alias_count: 0, aliases_removed: [], forced: force },
      });
      return { ok: true, aliasesRemoved: doomed.length };
    },
  );

  /* --- проверка DNS ------------------------------------------------ */
  app.post<{ Params: { id: string } }>(
    '/domains/:id/dns-check',
    {
      preHandler: requireAdmin(app, 'domains.dnscheck'),
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const id = Number(request.params.id);
      const row = await ctx.db.findDomainById(id);
      if (!row) throw new NotFoundError('Домен не найден');

      // Спрашиваем ВНЕШНИЕ резольверы, а не свой unbound: вопрос стоит
      // «видит ли наши записи остальной интернет», а свой резольвер
      // показал бы то, что мы сами себе прописали. См. admin/dns.ts.
      const servers = ctx.config.DNS_CHECK_RESOLVERS.split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      const report = await checkDomainDns(row.name, {
        mailHostname: host,
        publicIpv4: ctx.config.MAIL_PUBLIC_IPV4,
        dkimSelector: row.dkim_selector ?? 'mail',
        dkimPublicKey: row.dkim_public_key,
        imapsPort: ctx.config.IMAPS_PORT,
        submissionPort: ctx.config.SUBMISSION_PORT,
        pop3sPort: ctx.config.POP3S_PORT,
        servers: servers.length > 0 ? servers : undefined,
      });
      await ctx.db.saveDnsStatus(id, report, report.overall);
      await audit(ctx, request, {
        action: 'domain.dnscheck',
        targetType: 'domain',
        targetId: id,
        targetLabel: row.name,
        after: { overall: report.overall },
      });
      return report;
    },
  );
}
