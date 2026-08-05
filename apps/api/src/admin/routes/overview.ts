/**
 * Сводка состояния: один экран, по которому видно, всё ли в порядке.
 * Считаем то, что доступно без выхода за пределы базы и локальных сокетов:
 * счётчики объектов, доступность Postgres/Redis/IMAP/SMTP, состояние
 * антиспама и подписи исходящих, свой резольвер, свежесть проверок DNS
 * и последние действия администраторов.
 *
 * Отдельно про антиспам, Redis и резольвер. Их отказ почту не останавливает,
 * поэтому в пробу контейнера они намеренно не входят (см. src/health.ts) —
 * и ровно поэтому увидеть его можно только здесь. Молчащий rspamd означает
 * не только спам во «Входящих», но и исходящие БЕЗ подписи DKIM.
 */
import type { FastifyInstance } from 'fastify';
import { probeTcpPort } from '../../health.js';
import { actionLabel } from '../audit.js';
import { requireAdmin } from '../guard.js';
import { checkAntispam, checkResolver } from '../services.js';

type ServiceState = 'ok' | 'fail' | 'unknown';

interface ServiceStatus {
  id: string;
  title: string;
  state: ServiceState;
  detail: string;
}

export async function adminOverviewRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const { config: apiConfig } = app.deps;

  app.get('/overview', { preHandler: requireAdmin(app, 'overview.read') }, async () => {
    const services: ServiceStatus[] = [];

    // Postgres — заодно и счётчики
    let counters = {
      domains: 0,
      users: 0,
      usersActive: 0,
      usersBlocked: 0,
      aliases: 0,
      admins: 0,
      quotaTotal: 0,
      auditToday: 0,
      impersonations7d: 0,
    };
    try {
      counters = await ctx.db.overviewCounters();
      services.push({
        id: 'postgres',
        title: 'База данных',
        state: 'ok',
        detail: 'Отвечает; домены, ящики и алиасы читаются',
      });
    } catch (err) {
      services.push({
        id: 'postgres',
        title: 'База данных',
        state: 'fail',
        detail: `Не отвечает: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Все внешние проверки идут разом: последовательно они складывались бы
    // в секунды ожидания на экране, который открывают как раз при аварии.
    const [imapOk, smtpOk, rspamd, resolver, health] = await Promise.all([
      probeTcpPort(apiConfig.IMAP_HOST, apiConfig.IMAP_PORT),
      probeTcpPort(apiConfig.SMTP_HOST, apiConfig.SMTP_PORT),
      checkAntispam({
        host: ctx.config.RSPAMD_HOST,
        port: ctx.config.RSPAMD_CONTROLLER_PORT,
        password: ctx.config.RSPAMD_PASSWORD,
        domain: ctx.config.MAIL_DOMAIN,
      }),
      checkResolver({ address: ctx.config.RESOLVER_IP }),
      // Redis спрашиваем через общую пробу состояния: у неё уже открыто
      // соединение и есть кэш на пару секунд — своего подключения ради
      // сводки не заводим.
      app.health.report(),
    ]);
    const redisPart = health.parts.find((p) => p.id === 'redis');
    services.push({
      id: 'dovecot',
      title: 'Dovecot (IMAP)',
      state: imapOk ? 'ok' : 'fail',
      detail: imapOk
        ? `Порт ${apiConfig.IMAP_HOST}:${apiConfig.IMAP_PORT} открыт`
        : `Порт ${apiConfig.IMAP_HOST}:${apiConfig.IMAP_PORT} не отвечает — пользователи не смогут читать почту`,
    });
    services.push({
      id: 'postfix',
      title: 'Postfix (submission)',
      state: smtpOk ? 'ok' : 'fail',
      detail: smtpOk
        ? `Порт ${apiConfig.SMTP_HOST}:${apiConfig.SMTP_PORT} открыт`
        : `Порт ${apiConfig.SMTP_HOST}:${apiConfig.SMTP_PORT} не отвечает — почта не отправляется`,
    });
    services.push({
      id: 'redis',
      title: 'Redis (сессии)',
      state: redisPart ? (redisPart.state === 'ok' ? 'ok' : 'fail') : 'unknown',
      detail: redisPart
        ? redisPart.state === 'ok'
          ? redisPart.detail
          : `${redisPart.detail}. Вошедшие пользователи получают ошибку на каждый запрос, войти заново нельзя`
        : 'Состояние неизвестно: хранилище сессий не зарегистрировано в пробе',
    });
    services.push({
      id: 'rspamd',
      title: 'Антиспам (rspamd)',
      state: rspamd.antispam.state,
      detail: rspamd.antispam.detail,
    });
    services.push({
      id: 'dkim',
      title: 'Подпись исходящих (DKIM)',
      state: rspamd.dkim.state,
      detail: rspamd.dkim.detail,
    });
    services.push({
      id: 'unbound',
      title: 'Свой резольвер (unbound)',
      state: resolver.state,
      detail: resolver.detail,
    });
    services.push({
      id: 'master',
      title: 'Служебный доступ Dovecot',
      state: ctx.mailbox.configured ? 'ok' : 'unknown',
      detail: ctx.mailbox.configured
        ? 'Настроен: вход администратора в ящик доступен'
        : 'Не настроен: задайте DOVECOT_MASTER_USER/DOVECOT_MASTER_PASSWORD, иначе вход в чужой ящик недоступен',
    });

    // Домены и свежесть проверок DNS
    const domains = await ctx.db.listDomains().catch(() => []);
    const dnsProblems = domains
      .filter((d) => d.dns_overall === 'fail' || d.dns_overall === 'warn')
      .map((d) => ({ id: d.id, name: d.name, overall: d.dns_overall }));
    const dnsNeverChecked = domains
      .filter((d) => d.dns_checked_at === null)
      .map((d) => ({ id: d.id, name: d.name }));

    const audit = await ctx.db
      .listAudit({ limit: 10, offset: 0 })
      .catch(() => ({ rows: [], total: 0 }));

    const problems: string[] = [];
    for (const s of services) {
      if (s.state === 'fail') problems.push(`${s.title}: ${s.detail}`);
    }
    if (dnsProblems.length > 0) {
      problems.push(
        `DNS требует внимания у доменов: ${dnsProblems.map((d) => d.name).join(', ')}`,
      );
    }
    if (dnsNeverChecked.length > 0) {
      problems.push(
        `DNS ни разу не проверялся у доменов: ${dnsNeverChecked.map((d) => d.name).join(', ')}`,
      );
    }
    if (counters.admins <= 1) {
      problems.push('Администратор всего один — при потере доступа чинить будет некому');
    }

    return {
      healthy: problems.length === 0,
      problems,
      services,
      counters,
      domains: domains.map((d) => ({
        id: d.id,
        name: d.name,
        userCount: Number(d.user_count),
        dnsOverall: d.dns_overall ?? 'unknown',
        dnsCheckedAt: d.dns_checked_at?.toISOString() ?? null,
      })),
      recentAudit: audit.rows.map((r) => ({
        id: r.id,
        adminLogin: r.admin_login,
        action: r.action,
        actionLabel: actionLabel(r.action),
        targetLabel: r.target_label,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });
}
