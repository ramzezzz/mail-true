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
import { ServiceAgentUnavailableError } from '../service-agent.js';

/**
 * Значение p= из готовой строки rspamd.
 *
 * Строка приходит как «v=DKIM1; k=rsa; p=MIIBIjANBg…» и бывает разбита на
 * куски кавычками — так её пишет rspamd для длинных ключей, и так её
 * принимает BIND. В поле панели нужен один непрерывный ключ, поэтому
 * кавычки и переводы строк убираются.
 */
export function publicKeyOf(record: string): string {
  const flat = record.replace(/"/gu, '').replace(/\s+/gu, ' ');
  const found = /p=([A-Za-z0-9+/=\s]+)/u.exec(flat);
  return found ? found[1]!.replace(/\s+/gu, '') : '';
}

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

  /**
   * ГОТОВАЯ ЗАПИСЬ DKIM — с сервера, а не из консоли.
   *
   * rspamd кладёт её файлом рядом с ключом, и раньше панель показывала
   * человеку путь к этому файлу с просьбой «скопируйте значение p=». То
   * есть предлагала зайти по SSH за строкой, которую машина читает сама.
   *
   * Читает посредник (service-agent): у сервера приложения нет и не будет
   * доступа ни к сокету Docker, ни к тому rspamd — там лежат ПРИВАТНЫЕ
   * ключи подписи. Посредник отдаёт только файл .dns.txt, то есть ровно
   * ту часть, что и так уходит в общедоступный DNS.
   */
  app.get<{ Params: { id: string } }>(
    '/domains/:id/dkim-record',
    { preHandler: requireAdmin(app, 'domains.write') },
    async (request) => {
      const row = await ctx.db.findDomainById(pathId(request.params.id, 'домена'));
      if (!row) throw new NotFoundError('Домен не найден');

      const agent = ctx.serviceAgent;
      if (!agent) {
        throw new ServiceAgentUnavailableError(
          'Посредник служб не настроен, поэтому прочитать ключ с сервера нечем. ' +
            'Значение p= лежит в контейнере rspamd: ' +
            `/var/lib/rspamd/dkim/${row.name}.${row.dkim_selector ?? 'mail'}.dns.txt`,
        );
      }

      const selector = row.dkim_selector ?? 'mail';
      const record = await agent.dkimRecord(row.name, selector);
      return {
        domain: row.name,
        selector,
        /** Строка целиком, как её написал rspamd: v=DKIM1; k=rsa; p=… */
        record,
        /** Только значение p= — его и просят вставить в поле. */
        publicKey: publicKeyOf(record),
      };
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

      /*
       * Основной домен сервера удалить нельзя.
       *
       * ------------------------------------------------------------------
       * ЧТО БЫЛО
       * ------------------------------------------------------------------
       * Проверялись только счётчики ящиков и алиасов, а MAIL_DOMAIN не
       * сверялся нигде. На свежей установке домен ещё пуст — значит два
       * щелчка, и он удалён. После этого Postfix перестаёт принимать
       * почту для него (карта virtual_mailbox_domains пуста), настройки
       * DKIM уходят каскадом, а сервер продолжает представляться этим
       * именем в HELO и подписывать им письма.
       *
       * Собрать это обратно можно только повторным заведением домена и
       * выпуском нового ключа с публикацией записи в DNS — то есть цена
       * случайного нажатия несоизмерима с «домен пустой, что тут терять».
       *
       * `force` здесь НЕ помогает: он существует для домена с алиасами,
       * а не для отмены этого правила. Сменить основной домен можно
       * отдельным разделом — он для того и сделан.
       */
      const mainDomain = (await settingsOf(ctx).text('MAIL_DOMAIN')).trim().toLowerCase();
      if (mainDomain !== '' && row.name.toLowerCase() === mainDomain) {
        throw new BadRequestError(
          `${row.name} — основной домен сервера: им подписывается почта и по нему сервер ` +
            'представляется другим серверам. Удалить его нельзя: приём почты для него ' +
            'прекратится, а ключ подписи придётся выпускать заново и публиковать в DNS. ' +
            'Если домен меняется — воспользуйтесь разделом «Смена домена».',
        );
      }

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
        // Алиасы уносит каскад в схеме (0001_baseline.sql), поэтому здесь их
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

      /*
       * Список забираем ДО удаления: после каскада восстановить его
       * неоткуда. Порциями, а не первыми пятьюстами.
       *
       * Отказ выше обещает: «повторите с force=true — тогда ПОЛНЫЙ список
       * удалённых алиасов попадёт в журнал аудита». Раньше бралось ровно
       * 500 строк, поэтому у домена с 1200 алиасами 700 маршрутов
       * исчезали без следа, а ответ сообщал «удалено 500» — просто
       * неверное число. Восстановить их нечем: строк уже нет.
       *
       * Предел всё же есть, но на два порядка выше и назван вслух ниже:
       * журнал аудита — не место для мегабайтного списка, и если домен
       * действительно такого размера, в записи будет сказано, сколько
       * имён в неё не поместилось.
       */
      const AUDIT_ALIAS_LIMIT = 20_000;
      const doomed: Array<{ source: string; destination: string; active: boolean }> = [];
      if (aliasCount > 0) {
        const page = 500;
        for (let offset = 0; offset < Math.min(aliasCount, AUDIT_ALIAS_LIMIT); offset += page) {
          const chunk = await ctx.db.listAliases({ domainId: id, limit: page, offset });
          if (chunk.rows.length === 0) break;
          for (const alias of chunk.rows) {
            doomed.push({
              source: alias.source,
              destination: alias.destination,
              active: alias.active,
            });
          }
        }
      }
      // Сколько имён не попало в журнал. Ноль — обычный случай; всё, что
      // больше, обязано быть видно, иначе список снова начнёт врать.
      const notLogged = Math.max(0, aliasCount - doomed.length);

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
          // Если список пришлось обрезать, это сказано числом, а не
          // умолчано: иначе запись в аудите выглядит полной, не будучи ею.
          aliases_not_logged: notLogged,
        },
        after: {
          name: null,
          alias_count: 0,
          aliases_removed: [],
          aliases_not_logged: 0,
          forced: force,
        },
      });
      // Отвечаем настоящим числом удалённого, а не длиной списка: они
      // расходятся ровно тогда, когда список обрезан.
      return { ok: true, aliasesRemoved: aliasCount, aliasesLogged: doomed.length };
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
    /*
     * Ожидаемый ключ DKIM берём У RSPAMD, а не из базы.
     *
     * ------------------------------------------------------------------
     * ЧТО БЫЛО
     * ------------------------------------------------------------------
     * Проверка сверяла опубликованную запись со значением
     * `domain_settings.dkim_public_key` — то есть с тем, что кто-то
     * когда-то вписал в панель. Подписывает же письма rspamd своим
     * ключом из тома, и эти двое могут не совпадать.
     *
     * Самый быстрый способ их развести — восстановить копию настроек на
     * другой установке: приватного ключа в копии нет и быть не может (он
     * лежит в томе rspamd, куда серверу приложения ходу нет), а вот
     * публичный переезжает вместе с доменом. В базе оказывается чужой
     * ключ, DNS его подтверждает, панель показывает зелёный DKIM — а
     * письма подписываются другим. Обнаруживается это по массовому
     * попаданию всей исходящей почты организации в спам.
     *
     * Поэтому спрашиваем настоящий ключ у посредника. Он недоступен —
     * возвращаемся к значению из базы: проверка без сверки лучше, чем
     * отсутствие проверки, а расхождение поймается в следующий раз.
     */
    const selector = row.dkim_selector ?? 'mail';
    let expectedDkim = row.dkim_public_key;
    const agent = ctx.serviceAgent;
    if (agent) {
      const real = await agent
        .dkimRecord(row.name, selector)
        .then((record) => publicKeyOf(record))
        .catch(() => null);
      if (real !== null && real !== '') expectedDkim = real;
    }

    return checkDomainDns(row.name, {
      mailHostname: host,
      publicIpv4: await settings.text('MAIL_PUBLIC_IPV4'),
      dkimSelector: selector,
      dkimPublicKey: expectedDkim,
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
