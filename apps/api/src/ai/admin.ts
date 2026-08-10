/**
 * Админские маршруты помощника: настройки по домену, предел расходов,
 * журнал обращений.
 *
 * Регистрируются внутри админского плагина (см. src/admin/index.ts),
 * поэтому получают ту же аутентификацию, те же роли и тот же аудит,
 * что остальная админка. Права переиспользуются существующие:
 * настройки ИИ — это настройки домена, а журнал — журнал.
 *
 * Ключ доступа наружу не отдаётся НИКОГДА, даже администратору:
 * в ответе только подсказка вида «…a3f9». Записать новый можно,
 * прочитать записанный — нет.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROMPT_VERSIONS, isInsidePerimeter, type AiFeature } from '@mail-true/ai';
import { BadRequestError, NotFoundError } from '../errors.js';
import { audit, requireAdmin } from '../admin/guard.js';
import { chatHistorySchema } from './chat-history.js';
import { AI_FEATURES, AI_FEATURE_INFO, NEVER_SENT } from './features.js';
import { publicStreamEvent } from './routes.js';
import { keyHint } from './secret.js';
import {
  describeNetworkFailure,
  modelsEndpoint,
  parseModelList,
  readJsonCapped,
} from './models.js';
import { serverKnowledge } from '../admin/ai-knowledge.js';
import { AiUnavailableError } from './errors.js';
import type { AiDomainSettings, AiDomainSettingsPatch } from './db.js';
import type { AiService } from './service.js';
import { pathId } from '../params.js';

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z
    .string()
    .url('Адрес сервиса должен быть корректным URL')
    .max(512)
    .nullable()
    .optional(),
  chatPath: z.string().trim().min(1).max(255).optional(),
  /**
   * Ключ доступа в открытом виде — принимаем, шифруем, забываем.
   * null — стереть сохранённый ключ. Поле отсутствует — не трогать.
   */
  apiKey: z
    .string()
    .max(512)
    .regex(/^[\x20-\x7e]*$/, 'Ключ доступа может содержать только печатные символы ASCII')
    .nullable()
    .optional(),
  model: z.string().trim().min(1).max(255).nullable().optional(),
  providerLabel: z.string().trim().min(1).max(255).optional(),
  /*
   * Поля `local` здесь НЕТ и быть не может.
   *
   * Признак «модель поднята на этом же сервере — письма не покидают
   * периметр» — это обещание, которое читает каждый пользователь домена
   * на экране согласия. Пока он принимался обычным булевым полем,
   * запрос мимо формы (curl, старая сборка админки, чей-нибудь скрипт)
   * с baseUrl=https://api.openai.com/v1 и local=true заставлял почту
   * обещать людям то, чего нет: письма уходили наружу, а экран согласия,
   * опись отправленного и журнал обращений говорили обратное. Вывод
   * делался только в браузере админки, то есть защищал ровно тех, кто
   * и так пользовался формой.
   *
   * Теперь признак выводится из адреса на сервере (isInsidePerimeter),
   * и прислать его нельзя никак.
   */
  maxBodyChars: z.number().int().min(200).max(200_000).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  maxOutputTokens: z.number().int().min(64).max(32_000).optional(),
  periodMs: z.number().int().min(60_000).max(2_592_000_000).optional(),
  maxTokensPerPeriod: z.number().int().positive().nullable().optional(),
  maxRequestsPerPeriod: z.number().int().positive().nullable().optional(),
  maxTokensPerRequest: z.number().int().positive().nullable().optional(),
  featuresAllowed: z.array(z.enum(AI_FEATURES)).nullable().optional(),
});

/**
 * Технические возможности пакета — единственный допустимый фильтр по полю
 * feature. Список берётся из самого пакета (ключи PROMPT_VERSIONS),
 * поэтому не разойдётся с ним при добавлении новой возможности.
 */
const TECHNICAL_FEATURES = Object.keys(PROMPT_VERSIONS) as [AiFeature, ...AiFeature[]];

/**
 * Разговор целиком: история живёт у клиента и приезжает с каждым
 * вопросом. Сервер её не хранит — закрытая вкладка стирает разговор.
 *
 * Схема общая с пользовательским чатом (ai/chat-history.ts): дефект,
 * ломавший разговор насмерть длинным ответом помощника, был здесь ровно
 * тот же, и чинить его в двух местах по-разному — значит однажды
 * починить только в одном.
 */
const chatSchema = chatHistorySchema;

const auditQuerySchema = z.object({
  accountId: z.string().max(255).optional(),
  feature: z.enum(TECHNICAL_FEATURES).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Внутри периметра ли адрес сервиса. Пустой адрес — нет: отправлять
 * некуда, но и обещать «не покидают сервер» не за что.
 */
function perimeterOf(baseUrl: string | null): boolean {
  return baseUrl !== null && isInsidePerimeter(baseUrl);
}

/**
 * Настройки для админки. Ключ доступа заменён подсказкой:
 * увидеть его нельзя, отличить один от другого — можно.
 */
function toDto(row: AiDomainSettings): Record<string, unknown> {
  return {
    domainId: row.domainId,
    domain: row.domain,
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    chatPath: row.chatPath,
    /** true — ключ сохранён. Значение не отдаётся ни при каких условиях. */
    hasApiKey: row.apiKeyEnc !== null,
    apiKeyHint: row.apiKeyHint,
    model: row.model,
    providerLabel: row.providerLabel,
    /*
     * Считаем из адреса, а не отдаём как записано: в базе могла остаться
     * строка от старой версии, где признак приходил от клиента. Показывать
     * администратору «внутри периметра» при внешнем адресе нельзя ни
     * секунды — по этому полю он решает, включать ли помощника.
     */
    local: perimeterOf(row.baseUrl),
    maxBodyChars: row.maxBodyChars,
    timeoutMs: row.timeoutMs,
    maxOutputTokens: row.maxOutputTokens,
    periodMs: row.periodMs,
    maxTokensPerPeriod: row.maxTokensPerPeriod,
    maxRequestsPerPeriod: row.maxRequestsPerPeriod,
    maxTokensPerRequest: row.maxTokensPerRequest,
    featuresAllowed: row.featuresAllowed,
    updatedAt: row.updatedAt,
  };
}

/**
 * Отказ поставщика на списке моделей — словами, а не кодом.
 *
 * Код 401 и код 404 здесь означают совершенно разные ошибки настройки, и
 * человеку у формы нужно знать, какое из полей поправить, а не число.
 */
function describeModelsFailure(status: number): string {
  if (status === 401 || status === 403) {
    return 'Сервис не принял ключ доступа: проверьте его в поле ниже.';
  }
  if (status === 404) {
    return 'По этому адресу списка моделей нет. Обычно это значит, что в адресе не хватает /v1.';
  }
  return `Сервис ответил отказом (${String(status)}).`;
}

export async function aiAdminRoutes(app: FastifyInstance, service: AiService): Promise<void> {
  const ctx = app.adminCtx;

  const requireDb = (): NonNullable<AiService['db']> => {
    const db = service.db;
    if (!db) {
      throw new AiUnavailableError(
        'Помощник ИИ не настроен: нет подключения к базе или не применена миграция 0004_ai.sql',
      );
    }
    return db;
  };

  /** Справочник возможностей и списка «что не отправляется» — для интерфейса. */
  app.get('/ai/features', { preHandler: requireAdmin(app, 'domains.read') }, () => ({
    features: AI_FEATURES.map((key) => AI_FEATURE_INFO[key]),
    neverSent: NEVER_SENT,
    /**
     * Можно ли сейчас сохранить ключ доступа к внешнему сервису.
     * Если нет — админка честно скажет, какой переменной не хватает,
     * вместо загадочной ошибки при сохранении.
     */
    canStoreApiKey: service.keyBox !== null,
    apiKeyReason: service.keyBoxReason,
  }));

  app.get('/ai/domains', { preHandler: requireAdmin(app, 'domains.read') }, async () => {
    const rows = await requireDb().listDomainSettings();
    return { items: rows.map(toDto) };
  });

  app.get<{ Params: { id: string } }>(
    '/ai/domains/:id',
    { preHandler: requireAdmin(app, 'domains.read') },
    async (request) => {
      const row = await requireDb().findDomainSettingsById(pathId(request.params.id, 'записи'));
      if (!row) throw new NotFoundError('Настройки ИИ для домена не найдены');
      return toDto(row);
    },
  );

  /**
   * Сохранение настроек. Неупомянутые поля не трогаются: администратор,
   * меняющий предел расходов, не должен случайно стереть ключ доступа.
   */
  app.patch<{ Params: { id: string } }>(
    '/ai/domains/:id',
    { preHandler: requireAdmin(app, 'domains.write') },
    async (request) => {
      const db = requireDb();
      const id = pathId(request.params.id, 'записи');
      const body = settingsSchema.parse(request.body);
      const before = await db.findDomainSettingsById(id);
      if (!before) throw new NotFoundError('Настройки ИИ для домена не найдены');

      const patch: AiDomainSettingsPatch = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
      if (body.chatPath !== undefined) patch.chatPath = body.chatPath;
      if (body.model !== undefined) patch.model = body.model;
      if (body.providerLabel !== undefined) patch.providerLabel = body.providerLabel;
      /*
       * Признак периметра всегда пересчитывается из адреса — и когда
       * адрес меняют, и когда его не трогают (тогда из сохранённого).
       * Так строка в базе приводится к правде даже при сохранении
       * соседнего поля, а прислать сюда «внутри периметра» руками нельзя.
       */
      patch.local = perimeterOf(body.baseUrl === undefined ? before.baseUrl : body.baseUrl);
      if (body.maxBodyChars !== undefined) patch.maxBodyChars = body.maxBodyChars;
      if (body.timeoutMs !== undefined) patch.timeoutMs = body.timeoutMs;
      if (body.maxOutputTokens !== undefined) patch.maxOutputTokens = body.maxOutputTokens;
      if (body.periodMs !== undefined) patch.periodMs = body.periodMs;
      if (body.maxTokensPerPeriod !== undefined) patch.maxTokensPerPeriod = body.maxTokensPerPeriod;
      if (body.maxRequestsPerPeriod !== undefined)
        patch.maxRequestsPerPeriod = body.maxRequestsPerPeriod;
      if (body.maxTokensPerRequest !== undefined)
        patch.maxTokensPerRequest = body.maxTokensPerRequest;
      if (body.featuresAllowed !== undefined) {
        patch.featuresAllowed = body.featuresAllowed === null ? null : [...body.featuresAllowed];
      }

      // Ключ доступа: шифруем здесь и больше нигде не держим в открытом виде.
      if (body.apiKey !== undefined) {
        if (body.apiKey === null || body.apiKey.length === 0) {
          patch.apiKeyEnc = null;
          patch.apiKeyHint = null;
        } else {
          const box = service.keyBox;
          if (!box) {
            throw new BadRequestError(
              service.keyBoxReason ??
                'Ключ доступа сохранить негде: не задана переменная окружения AI_ENCRYPTION_KEY',
            );
          }
          patch.apiKeyEnc = box.encrypt(body.apiKey);
          patch.apiKeyHint = keyHint(body.apiKey);
        }
      }

      const after = await db.saveDomainSettings(id, patch);
      service.forgetSettings();

      await audit(ctx, request, {
        action: 'ai.settings.update',
        targetType: 'domain',
        targetId: id,
        targetLabel: before.domain,
        // Ключ доступа в аудит не попадает: вместо значения — признак смены.
        before: {
          enabled: before.enabled,
          base_url: before.baseUrl,
          model: before.model,
          local: before.local,
          has_api_key: before.apiKeyEnc !== null,
          max_tokens_per_period: before.maxTokensPerPeriod,
        },
        after: {
          enabled: after?.enabled,
          base_url: after?.baseUrl,
          model: after?.model,
          local: after?.local,
          has_api_key: after?.apiKeyEnc !== null,
          max_tokens_per_period: after?.maxTokensPerPeriod,
          api_key_changed: body.apiKey !== undefined,
        },
      });

      return after ? toDto(after) : {};
    },
  );

  /**
   * Какие модели есть у поставщика.
   *
   * ------------------------------------------------------------------
   * ЧТО БЫЛО
   * ------------------------------------------------------------------
   * Название модели вводилось руками в пустое поле. Опечатка в нём
   * выяснялась не при сохранении, а потом — отказом сервиса на первом же
   * письме, и выглядела как «помощник сломался», а не как «в названии
   * лишний дефис». Узнать правильное написание было негде: список
   * моделей есть у каждого поставщика, но панель его не спрашивала.
   *
   * Проверка НЕ требует включённого помощника: список нужен как раз
   * тогда, когда его ещё настраивают. Достаточно сохранённого адреса.
   *
   * Ключ доступа при этом остаётся на сервере: он расшифровывается
   * здесь и уходит только поставщику — наружу в ответе его нет ни в
   * каком виде.
   */
  app.get<{ Params: { id: string } }>(
    '/ai/domains/:id/models',
    {
      preHandler: requireAdmin(app, 'domains.write'),
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request) => {
      const db = requireDb();
      const id = pathId(request.params.id, 'записи');
      const row = await db.findDomainSettingsById(id);
      if (!row) throw new NotFoundError('Настройки ИИ для домена не найдены');
      if (!row.baseUrl) {
        throw new BadRequestError(
          'Сначала укажите адрес сервиса и сохраните настройки — список моделей ' +
            'спрашивается у него самого.',
        );
      }

      let apiKey: string | null = null;
      if (row.apiKeyEnc) {
        const box = service.keyBox;
        if (!box) {
          throw new AiUnavailableError(
            service.keyBoxReason ?? 'Ключ доступа сохранён, но расшифровать его нечем',
          );
        }
        apiKey = box.decrypt(row.apiKeyEnc);
      }

      const endpoint = modelsEndpoint(row.baseUrl);
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(apiKey === null ? {} : { Authorization: `Bearer ${apiKey}` }),
          },
          signal: AbortSignal.timeout(row.timeoutMs),
        });
        if (!response.ok) {
          /*
           * Отказ поставщика — не наша ошибка, и падать 500 здесь
           * нельзя: человеку нужен код и текст, по которым понятно, что
           * не так (401 — ключ, 404 — адрес без /v1).
           */
          return {
            ok: false as const,
            endpoint,
            status: response.status,
            message: describeModelsFailure(response.status),
            models: [],
          };
        }
        const models = parseModelList(await readJsonCapped(response));
        return { ok: true as const, endpoint, status: response.status, message: null, models };
      } catch (err) {
        return {
          ok: false as const,
          endpoint,
          status: null,
          message:
            err instanceof Error && err.name === 'TimeoutError'
              ? `Сервис не ответил за ${String(row.timeoutMs)} мс`
              : `Не удалось обратиться к сервису: ${describeNetworkFailure(err)}`,
          models: [],
        };
      }
    },
  );

  /**
   * Живая проверка настроек: один настоящий вызов сервиса на служебном
   * тексте. Настоящие письма при этом наружу не уходят — проверяем связь,
   * а не содержимое ящиков.
   */
  app.post<{ Params: { id: string } }>(
    '/ai/domains/:id/test',
    {
      preHandler: requireAdmin(app, 'domains.write'),
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request) => {
      const db = requireDb();
      const id = pathId(request.params.id, 'записи');
      const row = await db.findDomainSettingsById(id);
      if (!row) throw new NotFoundError('Настройки ИИ для домена не найдены');
      if (!row.enabled) {
        throw new BadRequestError('Сначала включите помощника для домена, потом проверяйте связь');
      }

      // Проверяем от имени служебного адреса домена, а не живого ящика.
      const probeAccount = `ai-probe@${row.domain}`;
      const availability = await service.availability(probeAccount);
      if (!availability.available || !availability.assistant) {
        return {
          ok: false,
          reason: availability.reason,
          message: availability.detail ?? 'Помощник не собрался из текущих настроек',
        };
      }

      const started = Date.now();
      const outcome = await availability.assistant.summarizeMessage(
        {
          id: `ai-test:${String(id)}`,
          subject: 'Проверка связи с сервисом ИИ',
          date: new Date().toISOString(),
          from: { name: 'Проверка Mail.True', address: probeAccount },
          to: [{ name: null, address: probeAccount }],
          cc: [],
          bodyText:
            'Это служебное письмо для проверки настроек помощника. ' +
            'Ответьте кратким пересказом: «проверка связи прошла успешно».',
          bodyHtml: null,
          attachments: [],
          headers: {},
        },
        { accountId: probeAccount, skipCache: true },
      );

      await audit(ctx, request, {
        action: 'ai.settings.test',
        targetType: 'domain',
        targetId: id,
        targetLabel: row.domain,
        after: { ok: outcome.ok, endpoint: availability.assistant.endpoint },
      });

      if (!outcome.ok) {
        return {
          ok: false,
          reason: outcome.error.kind,
          message: outcome.error.message,
          status: outcome.error.status,
          durationMs: Date.now() - started,
        };
      }
      return {
        ok: true,
        endpoint: availability.assistant.endpoint,
        model: availability.assistant.model,
        local: availability.assistant.local,
        summary: outcome.value.summary,
        usage: outcome.usage,
        durationMs: outcome.durationMs,
      };
    },
  );

  /* --- разговор администратора --------------------------------------- */

  /**
   * Разговор с помощником, который знает про ЭТОТ сервер.
   *
   * ------------------------------------------------------------------
   * ЧЕМ ОТЛИЧАЕТСЯ ОТ ПОЛЬЗОВАТЕЛЬСКОГО
   * ------------------------------------------------------------------
   * Только правилами разговора: сюда добавлен справочник по продукту —
   * разделы панели, устройство стека и список настроек с назначением
   * (см. admin/ai-knowledge.ts). Больше ничего: доступа к серверу у
   * модели нет ни здесь, ни там.
   *
   * ЗНАЧЕНИЙ настроек в справочнике нет — только имена и назначение.
   * Иначе разговор стал бы способом вытащить содержимое infra/.env через
   * вопрос «а что у меня сейчас стоит», и помощник охотно бы его назвал.
   *
   * ------------------------------------------------------------------
   * ПОЧЕМУ УЧЁТ ИДЁТ НА СЛУЖЕБНЫЙ АДРЕС
   * ------------------------------------------------------------------
   * Расход считается по домену, а разговор ведёт администратор, у
   * которого почтового ящика может не быть вовсе. Служебный адрес
   * ai-admin@домен делает расход видимым в журнале обращений отдельной
   * строкой: сколько потрачено на разговоры администраторов, видно
   * сразу, и это честнее, чем прятать их в расход чьего-то ящика.
   */
  app.post(
    '/ai/chat/stream',
    {
      preHandler: requireAdmin(app, 'serversettings.read'),
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const db = requireDb();
      const body = chatSchema.parse(request.body);

      /*
       * Домен берём основной — тот, которым сервер представляется. У
       * администратора почтового ящика может не быть, а настройки
       * помощника живут по доменам.
       */
      const rows = await db.listDomainSettings();
      const mainDomain = ctx.config.MAIL_DOMAIN.toLowerCase();
      const row = rows.find((item) => item.domain.toLowerCase() === mainDomain) ?? rows[0];
      if (!row) {
        throw new AiUnavailableError('Помощник ИИ не настроен ни для одного домена');
      }

      const availability = await service.availability(`ai-admin@${row.domain}`);
      if (!availability.available || !availability.assistant) {
        throw new AiUnavailableError(
          availability.detail ??
            'Помощник ИИ выключен или настроен не полностью — включите его на вкладке настроек',
        );
      }

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      // Слушаем закрытие ОТВЕТА, а не запроса: у запроса с телом событие
      // 'close' приходит сразу после вычитывания тела.
      const controller = new AbortController();
      let finished = false;
      reply.raw.on('close', () => {
        if (!finished) controller.abort();
      });

      try {
        for await (const event of availability.assistant.streamChat(
          body.messages,
          { accountId: `ai-admin@${row.domain}`, signal: controller.signal },
          { systemExtra: serverKnowledge() },
        )) {
          /*
           * Опись отправленного администратору не показывается: она
           * пересказывает его же вопрос, а справочник в неё не входит по
           * устройству. Пропускаем её молча, чтобы интерфейс не рисовал
           * пустую плашку «что ушло наружу».
           */
          if (event.type === 'disclosure') continue;
          /*
           * Событие чистится тем же отбором, что и в пользовательском
           * потоке (publicStreamEvent).
           *
           * У отказа поставщика в `details` лежит сырое тело ответа до 500
           * символов — в том числе для 401/403, где в нём оказывается
           * кусок ключа доступа и внутренние имена организации. Здесь
           * событие писалось как есть, и это ровно тот дефект, который в
           * соседнем файле объявлен закрытым и закреплён тестом
           * (ai/stream-events.test.ts). Право `serversettings.read` есть
           * только у владельца — но ключ и не предназначен для показа
           * даже ему: он вводится один раз и больше нигде не отдаётся.
           */
          reply.raw.write(`data: ${JSON.stringify(publicStreamEvent(event))}

`);
        }
      } catch (err) {
        request.log.warn({ err }, 'Разговор администратора с ИИ оборвался');
        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'error',
            error: { kind: 'network', message: 'Поток прервался', retryable: true },
          })}

`,
        );
      } finally {
        finished = true;
        reply.raw.end();
      }
      return reply;
    },
  );

  /* --- журнал обращений --------------------------------------------- */

  /**
   * Всё, что уходило наружу: когда, чей ящик, какое письмо, сколько
   * токенов. Тел писем здесь нет — только длина отправленного текста.
   */
  app.get('/ai/audit', { preHandler: requireAdmin(app, 'audit.read') }, async (request) => {
    const q = auditQuerySchema.parse(request.query);
    const filter = {
      ...(q.accountId === undefined ? {} : { accountId: q.accountId }),
      ...(q.feature === undefined ? {} : { feature: q.feature }),
      ...(q.since === undefined ? {} : { since: q.since }),
      limit: q.limit,
    };
    const [items, totals] = await Promise.all([
      service.audit.list(filter),
      service.audit.totals(filter),
    ]);
    return { items, totals };
  });
}
