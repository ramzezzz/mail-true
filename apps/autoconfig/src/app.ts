/**
 * Fastify-приложение сервиса автоопределения настроек почтовых клиентов.
 *
 * Маршруты:
 *   GET  /mail/config-v1.1.xml                        — Mozilla Autoconfig (Thunderbird)
 *   GET  /.well-known/autoconfig/mail/config-v1.1.xml — то же, путь по спецификации well-known
 *   POST /autodiscover/autodiscover.xml               — Microsoft Autodiscover (Outlook)
 *   GET  /autodiscover/autodiscover.xml               — некоторые клиенты делают GET
 *   GET  /mobileconfig?email=…                        — профиль Apple (.mobileconfig)
 *   GET  /api/dns-records?domain=…                    — набор DNS-записей для публикации
 *   GET  /api/dns-check?domain=…                      — живая проверка опубликованных записей
 *   GET  /                                            — страница помощи (ручная настройка)
 *
 * Роутер работает без учёта регистра (caseSensitive: false): Outlook может
 * запрашивать /Autodiscover/Autodiscover.xml.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { settingsFromEnv, type AutoconfigEnv, type MailSettings } from './config.js';
import { buildClientConfigXml } from './autoconfig.js';
import {
  buildAutodiscoverError,
  buildAutodiscoverResponse,
  parseAutodiscoverRequest,
} from './autodiscover.js';
import { buildDnsRecords, buildZoneFile, checkDns, readDkimRecord } from './dns.js';
import { buildMobileConfig } from './mobileconfig.js';
import { buildHelpPage } from './help.js';

const XML_TYPE = 'application/xml; charset=utf-8';

const emailSchema = z.string().email().max(320);
const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
    'некорректный домен',
  );

/**
 * Насколько живёт готовый ответ проверки DNS.
 *
 * Записи домена не меняются чаще, а маршрут открыт в интернет: без
 * кэша каждый запрос снаружи превращается в десяток обращений к
 * резольверу.
 */
const DNS_CHECK_TTL_MS = 30_000;

/** Готовые ответы проверки: домен здесь ровно один, поэтому и записи одна. */
const dnsCheckCache = new Map<string, { at: number; body: unknown }>();

/**
 * По какому домену к нам обратились.
 *
 * Почтовые программы приходят на `autoconfig.<домен>` или
 * `autodiscover.<домен>` — имя узла в запросе и есть тот домен, чей
 * владелец направил сюда запись в DNS. Только его и можно подтверждать
 * как обслуживаемый: всё остальное было бы утверждением о чужом домене.
 */
function domainAskedVia(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const name = host.split(':')[0]?.toLowerCase().trim();
  if (!name) return undefined;
  const stripped = /^(?:autoconfig|autodiscover)\.(.+)$/u.exec(name);
  return stripped?.[1] ?? name;
}

export async function buildApp(config: AutoconfigEnv, logger: Logger): Promise<FastifyInstance> {
  const settings: MailSettings = settingsFromEnv(config);

  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    caseSensitive: false,
    bodyLimit: 64 * 1024,
    disableRequestLogging: config.NODE_ENV === 'production',
  }) as unknown as FastifyInstance;

  // Outlook шлёт XML как text/xml (иногда без корректного Content-Type) —
  // принимаем любое тело как строку и разбираем сами.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  app.get('/healthz', async () => ({ ok: true, uptime: process.uptime() }));

  // ------------------------------------------------------------------
  // 1. Mozilla Autoconfig
  // ------------------------------------------------------------------
  for (const path of ['/mail/config-v1.1.xml', '/.well-known/autoconfig/mail/config-v1.1.xml']) {
    app.get(path, async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>;
      const email = emailSchema.safeParse(q['emailaddress']);
      return reply
        .type(XML_TYPE)
        .send(
          buildClientConfigXml(
            settings,
            email.success ? email.data : undefined,
            domainAskedVia(request.headers.host),
          ),
        );
    });
  }

  // ------------------------------------------------------------------
  // 2. Microsoft Autodiscover
  // ------------------------------------------------------------------
  app.post('/autodiscover/autodiscover.xml', async (request, reply) => {
    const body = typeof request.body === 'string' ? request.body : '';
    const parsed = parseAutodiscoverRequest(body);
    const email = emailSchema.safeParse(parsed.email);
    if (!email.success) {
      request.log.info({ body: body.slice(0, 500) }, 'Autodiscover: запрос без корректного адреса');
      return reply.code(200).type(XML_TYPE).send(buildAutodiscoverError(600, 'Invalid Request'));
    }
    return reply.type(XML_TYPE).send(buildAutodiscoverResponse(settings, email.data));
  });

  // Некоторые клиенты и проверяющие утилиты делают GET (адрес — в query Email).
  app.get('/autodiscover/autodiscover.xml', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const email = emailSchema.safeParse(q['email'] ?? q['Email'] ?? q['emailaddress']);
    if (!email.success) {
      return reply.code(200).type(XML_TYPE).send(buildAutodiscoverError(600, 'Invalid Request'));
    }
    return reply.type(XML_TYPE).send(buildAutodiscoverResponse(settings, email.data));
  });

  // ------------------------------------------------------------------
  // 3. DNS-записи и их проверка
  // ------------------------------------------------------------------
  /**
   * Проверка домена в запросе.
   *
   * ------------------------------------------------------------------
   * ЧТО БЫЛО
   * ------------------------------------------------------------------
   * `?domain=` принимался любой, а маршруты `/api/dns-records` и
   * `/api/dns-check` открыты в интернет: они живут на
   * `autoconfig.<домен>`, куда nginx отдаёт всё без всякого входа
   * (иначе почтовые программы не смогли бы забрать настройки).
   *
   * То есть кто угодно снаружи мог заставить наш резольвер обойти до
   * десятка записей произвольного домена, сколько угодно раз. Плюс
   * ответ `/api/dns-records` для чужого домена выглядит как «вот
   * записи, которые надо опубликовать, чтобы этот домен обслуживал наш
   * сервер», — то есть утверждает то, о чём сервер ничего не знает.
   *
   * Проверять чужие домены незачем: раздел существует ради того, чтобы
   * администратор проверил СВОЙ. Полноценная проверка с правами и без
   * ограничений живёт в панели (раздел «Домены»).
   */
  const ownDomain = (value: string | undefined): string | null => {
    const asked = (value ?? settings.domain).toLowerCase().trim();
    const own = settings.domain.toLowerCase();
    return asked === own ? own : null;
  };

  app.get('/api/dns-records', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const own = ownDomain(q['domain']);
    if (own === null) {
      return reply
        .code(403)
        .send({ error: 'FOREIGN_DOMAIN', message: 'Этот сервер обслуживает другой домен' });
    }
    const domain = domainSchema.safeParse(own);
    if (!domain.success) {
      return reply.code(400).send({ error: 'BAD_DOMAIN', message: 'Некорректный домен' });
    }
    const dkim = await readDkimRecord(settings, domain.data);
    const records = buildDnsRecords(settings, domain.data, dkim);
    return {
      domain: domain.data,
      ttl: settings.dnsTtl,
      records,
      zoneFile: buildZoneFile(settings, domain.data, records),
    };
  });

  app.get('/api/dns-check', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const own = ownDomain(q['domain']);
    if (own === null) {
      return reply
        .code(403)
        .send({ error: 'FOREIGN_DOMAIN', message: 'Этот сервер обслуживает другой домен' });
    }
    const domain = domainSchema.safeParse(own);
    if (!domain.success) {
      return reply.code(400).send({ error: 'BAD_DOMAIN', message: 'Некорректный домен' });
    }
    /*
     * Проверка ходит в DNS — до десятка резолвов на запрос. Держим
     * недолгий кэш ответа: без него открытый в интернет маршрут работает
     * усилителем запросов к резольверу, а обновлять его чаще, чем раз в
     * полминуты, всё равно бессмысленно — записи так быстро не меняются.
     */
    const cached = dnsCheckCache.get(domain.data);
    if (cached && Date.now() - cached.at < DNS_CHECK_TTL_MS) return cached.body;

    const dkim = await readDkimRecord(settings, domain.data);
    const records = buildDnsRecords(settings, domain.data, dkim);
    const results = await checkDns(settings, domain.data, records);
    const summary = {
      ok: results.filter((r) => r.status === 'ok').length,
      problems: results.filter((r) => r.status !== 'ok').length,
    };
    const body = { domain: domain.data, summary, results };
    dnsCheckCache.set(domain.data, { at: Date.now(), body });
    return body;
  });

  // ------------------------------------------------------------------
  // 4. Профиль Apple
  // ------------------------------------------------------------------
  app.get('/mobileconfig', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const email = emailSchema.safeParse(q['email']);
    if (!email.success) {
      return reply.code(400).send({
        error: 'BAD_EMAIL',
        message: 'Укажите адрес ящика: /mobileconfig?email=user@' + settings.domain,
      });
    }
    const fileName = `${settings.domain}-${email.data.replace(/[^a-z0-9@._-]/gi, '_')}.mobileconfig`;
    return reply
      .type('application/x-apple-aspen-config; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .send(buildMobileConfig(settings, email.data));
  });

  // ------------------------------------------------------------------
  // 5. Страница помощи
  // ------------------------------------------------------------------
  app.get('/', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(buildHelpPage(settings)),
  );

  return app;
}
