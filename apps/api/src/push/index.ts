/**
 * Подключение уведомлений о новой почте к API.
 *
 * Единственная точка соприкосновения с остальным приложением — вызов
 * pushNotificationRoutes(app) в src/app.ts. Модуль самодостаточен: своя
 * конфигурация, своё подключение к Postgres, свои ключи.
 *
 * Отсутствие любой из частей — не авария почты:
 *   - нет базы               -> уведомления только при открытой вкладке;
 *   - PUSH_ENABLED=false     -> то же самое, и об этом честно сказано;
 *   - помощник ИИ выключен   -> уровень «сводка от ИИ» недоступен, и в
 *                               настройках написано почему;
 *   - логотипы выключены     -> в уведомлении наш собственный значок.
 *
 * Регистрируется ПОСЛЕ settingsRoutes (главный выключатель уведомлений
 * живёт в общих настройках ящика), ПОСЛЕ aiRoutes (сводка) и ПОСЛЕ
 * senderLogosRoutes (значок отправителя) — у всех троих берутся готовые
 * сервисы из декораций.
 */
import type { FastifyInstance } from 'fastify';
import { loadPushConfig } from './config.js';
import { PushDb } from './db.js';
import { pushRoutes } from './routes.js';
import { PushService, type AiSummaryResult, type PushEnvironment } from './service.js';
import { errorInfo } from '../log.js';
import type { MailSession } from '../types.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Уведомления о новой почте. Есть всегда — даже когда push выключен. */
    pushService: PushService;
  }
}

/**
 * Растровые типы значков.
 *
 * Chrome не рисует SVG в поле `icon` уведомления вовсе — окно выходит без
 * значка, молча. А BIMI, наш первый источник логотипов, отдаёт именно SVG.
 * Поэтому векторный логотип до уведомления не доходит: вместо пустого
 * места показывается наш собственный значок.
 */
const RASTER_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/gif']);

export async function pushNotificationRoutes(app: FastifyInstance): Promise<void> {
  const { logger, pool } = app.deps;
  const config = loadPushConfig();

  let db: PushDb | null = null;
  if (config.databaseUrl) {
    db = new PushDb({ connectionString: config.databaseUrl, logger });
  } else {
    logger.warn(
      'Уведомления при закрытой вкладке выключены: не задан ' +
        'PUSH_DATABASE_URL/SETTINGS_DATABASE_URL/ADMIN_DATABASE_URL/DATABASE_URL. ' +
        'Уведомления при открытой вкладке работают как обычно.',
    );
  }

  const env: PushEnvironment = {
    pool,

    /*
     * Главный выключатель — общая настройка ящика «Уведомления в браузере».
     * Она была там раньше этого раздела, её показывает страница «Общие», и
     * заводить второй такой же выключатель значило бы получить «включил
     * в одном месте, а работает по другому».
     */
    masterSwitch: async (email: string): Promise<boolean> => {
      const settings = app.settingsService;
      if (!settings.available) return false;
      try {
        return (await settings.requireDb().getSettings(email)).notifyBrowser;
      } catch {
        // Недоступные настройки означают «не разрешал»: уведомления,
        // которых не просили, хуже отсутствующих.
        return false;
      }
    },

    logoUrl: async (email: string, domain: string): Promise<string | null> => {
      if (!app.hasDecorator('senderLogos')) return null;
      const service = app.senderLogos;
      if (!service.enabled) return null;
      // Настройку человека спрашиваем ровно так же, как маршрут логотипов:
      // сервер не ходит в интернет за картинками, пока не разрешили.
      const settings = app.settingsService;
      if (!settings.available) return null;
      try {
        if (!(await settings.requireDb().getSettings(email)).senderLogos) return null;
        const states = await service.resolve([domain], email);
        const state = states.get(domain);
        if (!state || state.status !== 'ready') return null;
        const entry = await service.image(domain);
        if (!entry?.mime || !RASTER_MIME.has(entry.mime.toLowerCase())) return null;
        return `/api/sender-logos/${encodeURIComponent(domain)}/image?v=${state.version}`;
      } catch (err) {
        logger.debug(errorInfo(err, { domain }), 'Логотип отправителя для уведомления не получен');
        return null;
      }
    },

    /*
     * Доступность уровня «сводка от ИИ».
     *
     * Пункт не прячется молча: человек должен понимать, почему выбор
     * недоступен — администратор не разрешил помощника или не дано
     * согласие на отправку писем сервису ИИ.
     */
    aiAvailability: async (
      email: string,
    ): Promise<{ available: boolean; reason: string | null }> => {
      if (!app.hasDecorator('aiService')) {
        return { available: false, reason: 'Помощник на основе ИИ на сервере не подключён' };
      }
      const state = await app.aiService.state(email);
      if (!state.enabled) {
        return {
          available: false,
          reason: 'Помощник на основе ИИ выключен администратором домена',
        };
      }
      if (!state.consent.given || !state.consent.matchesProvider) {
        return {
          available: false,
          reason:
            'Нужно ваше согласие на отправку писем сервису ИИ — ' +
            'дайте его в настройках помощника',
        };
      }
      if (!state.features.some((f) => f.key === 'summary' && f.allowed && f.enabled)) {
        return {
          available: false,
          reason: 'Возможность «Краткое резюме» выключена в настройках помощника',
        };
      }
      // Предел расходов на исходе — сказать об этом ЗАРАНЕЕ честнее, чем
      // молча показать уведомление без сводки.
      if (state.budget && state.budget.requestsLeft !== null && state.budget.requestsLeft <= 0) {
        return { available: false, reason: 'Предел расходов на ИИ исчерпан на этот период' };
      }
      if (state.budget && state.budget.tokensLeft !== null && state.budget.tokensLeft <= 0) {
        return { available: false, reason: 'Предел расходов на ИИ исчерпан на этот период' };
      }
      return { available: true, reason: null };
    },

    aiSummary: async (session: MailSession, messageId: string): Promise<AiSummaryResult> => {
      if (!app.hasDecorator('aiService')) {
        return { text: null, degraded: 'Помощник на основе ИИ недоступен' };
      }
      try {
        const { assistant } = await app.aiService.forFeature(session.email, 'summary');
        const { loadMessageForAi } = await import('../ai/messages.js');
        const message = await loadMessageForAi(app, session, messageId);
        const outcome = await assistant.summarizeMessage(message, { accountId: session.email });
        if (!outcome.ok) {
          /*
           * Предел расходов исчерпан прямо сейчас. Уведомление при этом
           * НЕ пропадает: оно показывается уровнем ниже, с первыми
           * фразами письма. Молчать было бы худшим из решений — человек
           * включал уведомления не ради сводки, а ради письма.
           */
          const budget =
            outcome.error.kind === 'budget-exceeded' || outcome.error.kind === 'rate-limited';
          return {
            text: null,
            degraded: budget
              ? 'Предел расходов на ИИ исчерпан — в уведомлении первые фразы письма'
              : 'Сервис ИИ не ответил — в уведомлении первые фразы письма',
          };
        }
        // Пакет отдаёт разобранную сводку целиком (текст, пункты, признак
        // «нужно действие»). В окно уведомления идёт только сам текст:
        // остальному там всё равно не хватит места.
        const text = outcome.value.summary.trim();
        return { text: text === '' ? null : text, degraded: null };
      } catch (err) {
        logger.debug(errorInfo(err), 'Сводка ИИ для уведомления не получена');
        return { text: null, degraded: 'Сводка от ИИ сейчас недоступна' };
      }
    },
  };

  const service = new PushService({ config, db, logger, env });
  app.decorate('pushService', service);

  if (!config.PUSH_ENABLED) {
    logger.warn('PUSH_ENABLED=false: уведомления при закрытой вкладке выключены на всём сервере');
  }

  /*
   * Ранняя диагностика. Молчать здесь нельзя: «уведомления не приходят»
   * иначе выяснится только жалобой, а причина (не применена миграция)
   * видна прямо сейчас.
   */
  if (db) {
    try {
      if (await db.schemaReady()) {
        await service.init();
      } else {
        logger.error(
          'Таблиц уведомлений нет. Примените infra/postgres/migrations/0001_baseline.sql ' +
            'к работающей базе — до этого уведомления работают только при открытой вкладке.',
        );
      }
    } catch (err) {
      logger.warn(errorInfo(err), 'Не удалось проверить схему уведомлений');
    }
  }

  app.addHook('onClose', async () => {
    if (db) await db.close().catch(() => undefined);
  });

  await app.register(
    async (scope) => {
      await pushRoutes(scope, service);
    },
    { prefix: '/api/push' },
  );
}

export { PushService } from './service.js';
export * from './types.js';
