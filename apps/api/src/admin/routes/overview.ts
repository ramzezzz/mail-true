/**
 * Сводка состояния: один экран, по которому видно, всё ли в порядке.
 * Считаем то, что доступно без выхода за пределы базы и локальных сокетов:
 * счётчики объектов, доступность Postgres/Redis/IMAP/SMTP, состояние
 * антиспама и подписи исходящих, свой резольвер, свежесть проверок DNS
 * и последние действия администраторов.
 *
 * Отдельно про антиспам и свой резольвер. Их отказ почту не останавливает,
 * поэтому в пробу контейнера они намеренно не входят (см. src/health.ts) —
 * и ровно поэтому увидеть его можно только здесь. Молчащий rspamd означает
 * не только спам во «Входящих», но и исходящие БЕЗ подписи DKIM: тихую
 * потерю репутации домена, о которой узнать больше неоткуда.
 *
 * Redis в пробе есть (без него не работает ни один запрос вошедшего), но
 * в сводке он тоже нужен: администратор смотрит сюда, а не в /health.
 */
import type { FastifyInstance } from 'fastify';
import { IMAP_FAREWELL, probeTcpPort, SMTP_FAREWELL } from '../../health.js';
import { actionLabel } from '../audit.js';
import { requireAdmin } from '../guard.js';
import { checkAntispam, checkResolver } from '../services.js';
import {
  bucketSeconds,
  isUserTrafficSort,
  MetricsStore,
  type UserTrafficSort,
} from '../metrics-store.js';
import { readCertificates, TLS_WARN_DAYS, type TlsTarget } from '../metrics-tls.js';
import { diskUsedPercent } from '../metrics-disk.js';
import { gradeDisk, gradeQueue } from '../selfcheck.js';

type ServiceState = 'ok' | 'fail' | 'unknown';

interface ServiceStatus {
  id: string;
  title: string;
  state: ServiceState;
  detail: string;
}

/**
 * Предел строк из строки запроса — ЦЕЛЫЙ и в разумных границах.
 *
 * Наружу ради проверки. Округления здесь не было (в отличие от смещения
 * строкой ниже по коду), и дробное число уезжало прямо в LIMIT: Postgres
 * на «LIMIT 12.5» отвечает ошибкой синтаксиса, то есть случайная запятая
 * в адресе страницы давала администратору не пустой список, а «Внутренняя
 * ошибка сервера» на весь дашборд.
 */
export function pageLimit(raw: unknown, fallback: number, max = 200): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
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
      probeTcpPort(apiConfig.IMAP_HOST, apiConfig.IMAP_PORT, 3000, IMAP_FAREWELL),
      probeTcpPort(apiConfig.SMTP_HOST, apiConfig.SMTP_PORT, 3000, SMTP_FAREWELL),
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
      problems.push(`DNS требует внимания у доменов: ${dnsProblems.map((d) => d.name).join(', ')}`);
    }
    if (dnsNeverChecked.length > 0) {
      problems.push(
        `DNS ни разу не проверялся у доменов: ${dnsNeverChecked.map((d) => d.name).join(', ')}`,
      );
    }
    if (counters.admins <= 1) {
      problems.push('Администратор всего один — при потере доступа чинить будет некому');
    }

    /*
     * МЕСТО НА ДИСКЕ И ОЧЕРЕДЬ — ТОЖЕ ЧАСТЬ ОТВЕТА «ВСЁ ЛИ В ПОРЯДКЕ».
     *
     * Раньше баннер смотрел только на службы, DNS и число
     * администраторов. Забитый диск и застрявшая очередь — то есть
     * состояния, при которых почта уже не работает или вот-вот
     * перестанет, — на него не влияли никак: сверху зелёное «замечаний
     * нет», а ниже, в блоках этой же страницы, красное.
     *
     * Снимок берётся у сборщика (он уже собран, это чтение из памяти),
     * поэтому проверка ничего не стоит.
     */
    const resources = await resourceSnapshot().catch(() => null);
    if (resources) {
      for (const volume of resources.volumes) {
        // Процент считается ОДНОЙ формулой на весь продукт (metrics-disk.ts):
        // по доступному месту, а не по свободному, — резерв root службам
        // всё равно не отдадут.
        const percent = diskUsedPercent(volume.totalBytes, volume.freeBytes);
        if (percent !== null && gradeDisk(percent) === 'fail') {
          problems.push(
            `Место на диске (${volume.path}) почти кончилось: занято ${String(Math.round(percent))}% — ` +
              'приём почты остановится',
          );
        }
      }
      const queue = resources.queue;
      if (queue && gradeQueue(queue.total, queue.oldestSeconds) === 'fail') {
        problems.push(
          `Очередь Postfix не разбирается: ${String(queue.total)} писем, самое старое ждёт ` +
            `${String(Math.round((queue.oldestSeconds ?? 0) / 3600))} ч.`,
        );
      }
    }

    /*
     * «Состояние неизвестно» — не то же самое, что «в порядке».
     *
     * У хранилища сессий это значит, что проба его не нашла: вошедшие
     * могут получать ошибку на каждый запрос, а баннер писал «замечаний
     * нет». Молчание о непроверенном — худший из ответов: оно читается
     * как «проверено и хорошо».
     */
    for (const service of services) {
      if (service.state === 'unknown' && service.id === 'redis') {
        problems.push(`${service.title}: ${service.detail}`);
      }
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

  /* ================================================================== */
  /* Дашборд наблюдения                                                  */
  /*                                                                     */
  /* ПОЧЕМУ РАЗДЕЛОВ ПЯТЬ, А НЕ ОДИН БОЛЬШОЙ ОТВЕТ.                      */
  /* Они стоят разного. Ресурсы отдаются из памяти сборщика мгновенно;   */
  /* агрегаты по сотням тысяч строк истории — десятки миллисекунд;       */
  /* занятость ящиков — обход хранилища; сертификаты — четыре сетевых    */
  /* соединения с таймаутом в четыре секунды. Слепив их в один ответ, мы */
  /* заставили бы весь экран ждать самого медленного: недоступный порт   */
  /* TLS задерживал бы показ загрузки процессора. Раздельные запросы     */
  /* рисуют каждый раздел, как только он готов.                          */
  /* ================================================================== */

  const store = new MetricsStore(ctx.db);

  /**
   * Снимок ресурсов или честное «сборщика нет».
   *
   * Сборщик может отсутствовать (см. AdminContext.metrics): тогда показывать
   * нечего, и притворяться нулями нельзя — ноль занятой памяти выглядит как
   * исправный сервер, а на деле означает, что мы ничего не мерили.
   */
  const NO_COLLECTOR =
    'Сборщик показателей не запущен: раздел ресурсов недоступен. ' +
    'Проверьте MAIL_METRICS_INTERVAL_SECONDS — ноль означает «не снимать вовсе»';
  const resourceSnapshot = async () => {
    const collector = ctx.metrics;
    if (!collector) return null;
    return collector.latest ?? (await collector.runOnce());
  };

  /** Окно времени из запроса: часы, с потолком и разумным умолчанием. */
  const windowOf = (raw: unknown, fallback = 24): { from: Date; to: Date; hours: number } => {
    const parsed = Number(raw);
    // Потолок в 30 суток не выдуман: дольше история и не живёт (см.
    // MAIL_FLOW_RETENTION_DAYS и MAIL_METRICS_RETENTION_DAYS), а запрос
    // «за год» просто прочесал бы всю таблицу ради пустого графика.
    const hours =
      Number.isFinite(parsed) && parsed >= 1 ? Math.min(720, Math.floor(parsed)) : fallback;
    const to = new Date();
    return { from: new Date(to.getTime() - hours * 3600_000), to, hours };
  };

  /**
   * Часовой пояс смотрящего из строки запроса (`?tz=Europe/Moscow`).
   *
   * Здесь только достаётся значение; знает ли Postgres такой пояс — решает
   * metrics-store (там же и запасной вариант UTC). Пустое и слишком
   * длинное отбрасывается сразу, чтобы мусор не доезжал до базы.
   */
  const timeZoneOf = (query: unknown): string | undefined => {
    const raw = (query as Record<string, unknown> | null)?.tz;
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    return value === '' || value.length > 64 ? undefined : value;
  };

  /* --- Ресурсы «прямо сейчас» ---------------------------------------- */
  app.get('/overview/resources', { preHandler: requireAdmin(app, 'overview.read') }, async () => {
    // Снимок берётся у сборщика, а не снимается здесь: см. пояснение
    // в metrics-collector.ts (загрузка процессора — это разность двух
    // замеров, одним обращением её не получить).
    const snapshot = await resourceSnapshot();
    if (!snapshot) {
      return {
        takenAt: null,
        intervalSeconds: ctx.config.MAIL_METRICS_INTERVAL_SECONDS,
        cpu: null,
        memory: null,
        volumes: [],
        singleDevice: false,
        slices: [],
        queue: null,
        unavailable: [NO_COLLECTOR],
      };
    }
    return {
      takenAt: snapshot.takenAt,
      intervalSeconds: ctx.config.MAIL_METRICS_INTERVAL_SECONDS,
      cpu: {
        nodePercent: snapshot.host.cpuNodePercent,
        apiPercent: snapshot.host.cpuApiPercent,
        cores: snapshot.host.cpuCount,
        apiLimit: snapshot.host.cpuApiLimit,
        load1: snapshot.host.load1,
      },
      memory: {
        total: snapshot.host.memNodeTotal,
        used: snapshot.host.memNodeUsed,
        api: snapshot.host.memApiBytes,
        apiLimit: snapshot.host.memApiLimit,
      },
      volumes: snapshot.volumes,
      singleDevice: snapshot.singleDevice,
      slices: snapshot.slices,
      queue: snapshot.queue,
      unavailable: snapshot.unavailable,
    };
  });

  /* --- История показателей ------------------------------------------- */
  app.get('/overview/history', { preHandler: requireAdmin(app, 'overview.read') }, async (req) => {
    const { from, to, hours } = windowOf((req.query as Record<string, unknown>).hours);
    const step = bucketSeconds(
      hours * 3600,
      Math.max(60, ctx.config.MAIL_METRICS_INTERVAL_SECONDS),
    );
    const ready = await store.schemaReady();
    if (!ready) {
      return {
        available: false,
        note:
          'История показателей недоступна: не применена миграция 0011_metrics.sql. ' +
          'Состояние «прямо сейчас» показывается и без неё, графика за прошедшие часы — нет',
        hours,
        stepSeconds: step,
        points: [],
      };
    }
    return {
      available: true,
      note: `Снимки раз в ${ctx.config.MAIL_METRICS_INTERVAL_SECONDS} с, усреднены по ${step} с`,
      hours,
      stepSeconds: step,
      points: await store.history(from, to, step),
    };
  });

  /* --- Почтовый поток ------------------------------------------------ */
  app.get('/overview/mail', { preHandler: requireAdmin(app, 'overview.read') }, async (req) => {
    const { from, to, hours } = windowOf((req.query as Record<string, unknown>).hours);
    const step = bucketSeconds(hours * 3600, 300);
    /*
     * Без таблицы разобранного журнала все восемь запросов ниже падают
     * сырой ошибкой SQL, и человек получает «Внутренняя ошибка сервера» на
     * весь раздел. Соседний график ресурсов в такой же ситуации объясняет,
     * какой миграции не хватает, — здесь должно быть так же.
     */
    if (!(await store.flowSchemaReady())) {
      return {
        available: false,
        note:
          'Почтовый поток недоступен: не применена миграция 0007_mail_flow.sql. ' +
          'Остальные разделы дашборда работают и без неё',
        hours,
        stepSeconds: step,
        buckets: [],
        totals: {},
        byDirection: { in: 0, out: 0, unknown: 0 },
        spamRejected: 0,
        messages: 0,
        spamNote: '',
        rejectReasons: [],
        deferReasons: [],
        sizes: { messages: 0, totalBytes: 0, avgBytes: null, medianBytes: null, maxBytes: null },
        hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
        hourlyTimeZone: 'UTC',
        historyStartsAt: null,
        historyEndsAt: null,
        mailboxesTotal: 0,
        mailboxesActive: 0,
        activityNote: '',
      };
    }
    // Пять сводок разом: они читают один и тот же индекс по одному и тому
    // же окну, и последовательное выполнение просто складывало бы задержки.
    const [buckets, totals, rejectReasons, deferReasons, sizes, hourly, edges, activity] =
      await Promise.all([
        store.flowByBucket(from, to, step),
        store.flowTotals(from, to),
        store.topReasons(from, to, ['rejected', 'bounced', 'expired']),
        store.topReasons(from, to, ['deferred']),
        store.sizeSummary(from, to),
        // Часовой пояс — тот, в котором СМОТРЯТ. Браузер присылает своё
        // IANA-имя; неизвестное имя не роняет раздел, а честно даёт UTC
        // (см. hourlyProfile).
        store.hourlyProfile(from, to, timeZoneOf(req.query)),
        store.flowEdges(),
        store.activityCounts(from, to),
      ]);
    return {
      // Признак «раздел доступен» есть в ОБОИХ ответах: без него панели
      // пришлось бы угадывать по составу полей, доехали данные или нет.
      available: true,
      note: '',
      hours,
      stepSeconds: step,
      buckets,
      totals: totals.byStatus,
      byDirection: totals.byDirection,
      spamRejected: totals.spamRejected,
      /**
       * Различных писем за окно — знаменатель доли спама. Именно писем,
       * а не строк журнала: письмо, отложенное трижды, — одно письмо,
       * а не четыре (подробно — в metrics-store.ts, flowTotals).
       */
      messages: totals.messages,
      spamNote:
        'Отдельного поля «спам» в журнале Postfix нет: rspamd отвечает обычным отказом ' +
        'SMTP. Здесь считаются отказы, в тексте которых виден след антиспама. ' +
        'Доля считается от РАЗЛИЧНЫХ писем, а не от попыток доставки: письмо, ' +
        'отложенное трижды, — это одно письмо',
      rejectReasons,
      deferReasons,
      sizes,
      hourly: hourly.hours,
      /** В каком поясе посчитаны часы: без подписи график сдвинут молча. */
      hourlyTimeZone: hourly.timeZone,
      historyStartsAt: edges.oldest,
      historyEndsAt: edges.newest,
      mailboxesTotal: activity.total,
      mailboxesActive: activity.active,
      activityNote:
        '«Активен» значит «за окно был хотя бы один принятый или отправленный конверт». ' +
        'Про входы в почту журнал Postfix ничего не знает',
    };
  });

  /* --- Кто сколько отправил и получил -------------------------------- */
  app.get('/overview/users', { preHandler: requireAdmin(app, 'overview.read') }, async (req) => {
    const query = req.query as Record<string, unknown>;
    const { from, to, hours } = windowOf(query.hours);
    const sort: UserTrafficSort = isUserTrafficSort(query.sort) ? query.sort : 'totalMessages';
    const limit = pageLimit(query.limit, 25);
    const offsetRaw = Number(query.offset);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const page = await store.userTraffic(from, to, sort, limit, offset);
    return {
      hours,
      sort,
      limit,
      offset,
      total: page.total,
      /**
       * Сколько ящиков за окно НЕ отправили и не получили ничего.
       *
       * Считает база по всем ящикам, а не панель по отданной странице:
       * страница отсортирована по трафику по убыванию, молчащие стоят в
       * хвосте и в первые 25 строк не попадают никогда. Панель считала
       * их сама и на сервере со 143 ящиками всегда показывала ноль —
       * выглядя при этом измеренным числом.
       */
      silent: page.silent,
      items: page.rows,
    };
  });

  /* --- Занятость ящиков и близость к квоте --------------------------- */
  app.get(
    '/overview/mailboxes',
    { preHandler: requireAdmin(app, 'overview.read') },
    async (req) => {
      const limit = pageLimit((req.query as Record<string, unknown>).limit, 20);
      // Занятость берём из снимка сборщика: обходить хранилище на каждый
      // запрос значит платить обходом за каждое обновление страницы.
      const snapshot = await resourceSnapshot();
      if (!snapshot) {
        return {
          available: false,
          note: NO_COLLECTOR,
          takenAt: null,
          totalBytes: 0,
          withoutAccounting: 0,
          total: 0,
          items: [],
        };
      }
      // Квоты — одним запросом по всем ящикам: по одному это N обращений
      // к базе ради таблицы, которую и так показывают целиком.
      const users = await ctx.db.query<{ email: string; quota_bytes: string; active: boolean }>(
        `SELECT email, quota_bytes::text, active FROM virtual_users`,
      );
      const quotas = new Map<string, { quota: number; active: boolean }>();
      for (const user of users) {
        quotas.set(user.email.toLowerCase(), {
          quota: Number(user.quota_bytes),
          active: user.active,
        });
      }
      const items = snapshot.mailboxes.items.map((box) => {
        const known = quotas.get(box.email.toLowerCase());
        // Квота из базы важнее записанной в maildirsize: в базе лежит то,
        // что администратор задал СЕЙЧАС, а в файле — то, что Dovecot
        // записал в момент последнего пересчёта. Расходятся они как раз
        // после изменения квоты, то есть ровно тогда, когда на это смотрят.
        const quota = known?.quota ?? box.limitBytes ?? 0;
        return {
          email: box.email,
          bytes: box.bytes,
          messages: box.messages,
          quotaBytes: quota,
          usedPercent: quota > 0 ? Math.round((box.bytes / quota) * 1000) / 10 : null,
          active: known?.active ?? true,
          known: known !== undefined,
        };
      });
      // Сортируем по близости к квоте, а не по размеру: ящик на 900 МБ из
      // гигабайта важнее ящика на 5 ГБ без ограничения — первый завтра
      // перестанет принимать почту, а второй просто большой.
      items.sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1));
      return {
        available: snapshot.mailboxes.available,
        note: snapshot.mailboxes.note,
        takenAt: snapshot.takenAt,
        totalBytes: snapshot.mailboxes.totalBytes,
        withoutAccounting: snapshot.mailboxes.withoutAccounting,
        total: items.length,
        items: items.slice(0, limit),
      };
    },
  );

  /* --- Сроки сертификатов и состояние DNS ---------------------------- */
  app.get('/overview/security', { preHandler: requireAdmin(app, 'overview.read') }, async () => {
    const host = apiConfig.SMTP_HOST;
    const targets: TlsTarget[] = [
      { title: 'Отправка почты (SMTPS 465)', host, port: 465, implicitTls: true },
      {
        title: 'Чтение почты (IMAPS 993)',
        host: apiConfig.IMAP_HOST,
        port: 993,
        implicitTls: true,
      },
      {
        title: 'Чтение почты (POP3S 995)',
        host: apiConfig.IMAP_HOST,
        port: 995,
        implicitTls: true,
      },
    ];
    const [certificates, domains] = await Promise.all([
      readCertificates(targets),
      ctx.db.listDomains().catch(() => []),
    ]);
    return {
      warnDays: TLS_WARN_DAYS,
      certificateNote:
        'Сертификат читается из живого соединения со службой, а не из файла: после ' +
        'обновления файла служба продолжает отдавать старый, пока её не перезапустят',
      certificates,
      domains: domains.map((d) => ({
        id: d.id,
        name: d.name,
        dnsOverall: d.dns_overall ?? 'unknown',
        dnsCheckedAt: d.dns_checked_at?.toISOString() ?? null,
        dkimSelector: d.dkim_selector ?? null,
        dkimConfigured: Boolean(d.dkim_public_key),
      })),
    };
  });
}
