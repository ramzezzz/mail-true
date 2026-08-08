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
import { PROMPT_VERSIONS, type AiFeature } from '@mail-true/ai';
import { BadRequestError, NotFoundError } from '../errors.js';
import { audit, requireAdmin } from '../admin/guard.js';
import { AI_FEATURES, AI_FEATURE_INFO, NEVER_SENT } from './features.js';
import { keyHint } from './secret.js';
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
  local: z.boolean().optional(),
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

const auditQuerySchema = z.object({
  accountId: z.string().max(255).optional(),
  feature: z.enum(TECHNICAL_FEATURES).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

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
    local: row.local,
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
      if (body.local !== undefined) patch.local = body.local;
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
