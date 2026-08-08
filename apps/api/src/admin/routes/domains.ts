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
import { settingsOf } from '../server-settings.js';
import { pathId } from '../../params.js';
import {
  buildDkimRecord,
  buildDmarcRecord,
  buildSpfRecord,
  checkDomainDns,
  mergeDnsCheck,
  type DnsCheckId,
  type DnsReport,
} from '../dns.js';

/** Какие записи можно перепроверить поштучно (проверка параметра пути). */
const DNS_CHECK_IDS: readonly DnsCheckId[] = [
  'a',
  'mx',
  'spf',
  'dkim',
  'dmarc',
  'ptr',
  'web-apex',
  'web-mail',
  'web-admin',
  'autoconfig',
  'autodiscover',
  'srv-imaps',
  'srv-submission',
  'srv-pop3s',
  'srv-autodiscover',
];

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

/**
 * «a@b, c@d и ещё 5» — перечисление для отказа.
 *
 * Список приходит уже урезанным запросом; `total` — сколько их всего.
 * Показать десяток и назвать остаток честнее, чем и то, и другое по
 * отдельности: первое без второго врёт о размере, второе без первого
 * не помогает ничем.
 */
function listNames(names: readonly string[], total: number): string {
  const shown = names.slice(0, 10);
  const rest = total - shown.length;
  return rest > 0 ? `${shown.join(', ')} и ещё ${String(rest)}` : shown.join(', ');
}

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
      const row = await ctx.db.findDomainById(pathId(request.params.id, 'домена'));
      if (!row) throw new NotFoundError('Домен не найден');
      return toDto(row, host);
    },
  );

  app.post(
    '/domains',
    { preHandler: requireAdmin(app, 'domains.write') },
    async (request, reply) => {
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
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/domains/:id',
    { preHandler: requireAdmin(app, 'domains.write') },
    async (request) => {
      const id = pathId(request.params.id, 'домена');
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
      const id = pathId(request.params.id, 'домена');
      const force = request.query.force === 'true' || request.query.force === '1';
      const row = await ctx.db.findDomainById(id);
      if (!row) throw new NotFoundError('Домен не найден');

      const userCount = Number(row.user_count);
      if (userCount > 0) {
        /*
         * Отказ ПЕРЕЧИСЛЯЕТ ящики, а не просто называет их число.
         *
         * «В домене ещё 7 ящиков» — это тупик: человек знает, что нельзя,
         * и не знает, что делать. Дальше он уходит в раздел ящиков,
         * выставляет фильтр по домену и переписывает адреса руками —
         * при том что сервер их только что посчитал и держит перед собой.
         * Особенно обидно это на домене с двумя забытыми ящиками, ради
         * которых и затевалось удаление.
         *
         * Список ограничен: домен на тысячу ящиков не должен превращать
         * отказ в выгрузку, а хвост всё равно виден числом.
         */
        const boxes = await ctx.db.listMailUsers({ domainId: id, limit: 20, offset: 0 });
        throw new BadRequestError(
          `Домен ${row.name} удалить нельзя: в нём ${String(userCount)} ящик(ов) — ` +
            `${listNames(
              boxes.rows.map((u) => u.email),
              userCount,
            )}. ` +
            'Удаление домена уничтожило бы их записи вместе с настройками и правилами. ' +
            'Сначала перенесите ящики на другой домен или удалите их.',
        );
      }

      const aliasCount = Number(row.alias_count);
      if (aliasCount > 0 && !force) {
        // Алиасы уносит каскад в схеме (0001_init.sql), поэтому здесь их
        // тоже показываем поимённо: «нельзя» без ответа на вопрос «что
        // именно мешает» стоит человеку похода в соседний раздел.
        const doomed = await ctx.db.listAliases({ domainId: id, limit: 20, offset: 0 });
        throw new BadRequestError(
          `Домен ${row.name} удалить нельзя: в нём ${String(aliasCount)} алиас(ов) — ` +
            `${listNames(
              doomed.rows.map((a) => `${a.source} → ${a.destination}`),
              aliasCount,
            )}. ` +
            'Удаление домена уничтожит их вместе с ним. Удалите алиасы сами или ' +
            'повторите запрос с параметром force=true — тогда полный список ' +
            'удалённых алиасов попадёт в журнал аудита.',
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

  /**
   * Общая часть обеих проверок — всей зоны и одной записи.
   *
   * Спрашиваем ВНЕШНИЕ резольверы, а не свой unbound: вопрос стоит
   * «видит ли наши записи остальной интернет», а свой резольвер показал
   * бы то, что мы сами себе прописали. См. admin/dns.ts.
   */
  const runCheck = async (row: DomainRow, only?: readonly DnsCheckId[]): Promise<DnsReport> => {
    // И список резольверов, и ожидаемый адрес читаются на КАЖДУЮ проверку:
    // их правят именно тогда, когда проверка показала не то, чего ждали, —
    // и повторить её нужно сразу, а не после перезапуска контейнера.
    const settings = settingsOf(ctx);
    const servers = (await settings.text('DNS_CHECK_RESOLVERS'))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return checkDomainDns(row.name, {
      mailHostname: host,
      publicIpv4: await settings.text('MAIL_PUBLIC_IPV4'),
      dkimSelector: row.dkim_selector ?? 'mail',
      dkimPublicKey: row.dkim_public_key,
      imapsPort: ctx.config.IMAPS_PORT,
      submissionPort: ctx.config.SUBMISSION_PORT,
      pop3sPort: ctx.config.POP3S_PORT,
      servers: servers.length > 0 ? servers : undefined,
      only,
    });
  };

  app.post<{ Params: { id: string } }>(
    '/domains/:id/dns-check',
    {
      preHandler: requireAdmin(app, 'domains.dnscheck'),
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const id = pathId(request.params.id, 'домена');
      const row = await ctx.db.findDomainById(id);
      if (!row) throw new NotFoundError('Домен не найден');

      const report = await runCheck(row);
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

  /**
   * Перепроверка ОДНОЙ записи.
   *
   * Записи правят у регистратора по одной и хотят убедиться, что доехала
   * именно эта. Общая проверка ради одного ответа заставляет ждать все
   * полтора десятка запросов, а при молчащем резольвере — ещё и гадать,
   * какая из строк не проверилась. Предел частоты выше общего: точечных
   * проверок в норме делают много подряд, и каждая дешевле.
   */
  app.post<{ Params: { id: string; checkId: string } }>(
    '/domains/:id/dns-check/:checkId',
    {
      preHandler: requireAdmin(app, 'domains.dnscheck'),
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request) => {
      const id = pathId(request.params.id, 'домена');
      const checkId = request.params.checkId as DnsCheckId;
      if (!DNS_CHECK_IDS.includes(checkId)) {
        throw new BadRequestError(`Неизвестная запись «${request.params.checkId}»`);
      }
      const row = await ctx.db.findDomainById(id);
      if (!row) throw new NotFoundError('Домен не найден');

      const fresh = await runCheck(row, [checkId]);
      const check = fresh.checks[0];
      if (!check) throw new NotFoundError('Проверка не выполнена');

      // Точечная проверка не должна стирать то, что известно про
      // остальные записи, — вклеиваем результат в прежний отчёт.
      const merged = mergeDnsCheck((row.dns_status as DnsReport | null) ?? null, fresh);
      await ctx.db.saveDnsStatus(id, merged, merged.overall);
      return { check, resolver: fresh.resolver, overall: merged.overall };
    },
  );
}
