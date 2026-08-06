/**
 * Подключение логотипов доменов отправителей к API.
 *
 * Единственная точка соприкосновения с остальным приложением — вызов
 * senderLogoRoutes(app) в src/app.ts. Модуль самодостаточен: своя
 * конфигурация, своё подключение к базе под кэш, свой ограничитель
 * исходящего потока.
 *
 * Отсутствие любой из частей — не авария почты:
 *   - нет базы          -> кэш живёт в памяти до перезапуска;
 *   - нет сети          -> в кружках остаются буквы;
 *   - помощник ИИ выключен -> третьего источника просто нет;
 *   - SENDER_LOGOS_ENABLED=false -> маршрут честно отвечает «выключено».
 *
 * Регистрируется ПОСЛЕ settingsRoutes: маршрут спрашивает у настроек ящика,
 * разрешил ли человек ходить за логотипами, и берёт готовый сервис из
 * декорации `settingsService`.
 */
import type { FastifyInstance } from 'fastify';
import { loadLogoConfig } from './config.js';
import { senderLogoRoutes } from './routes.js';
import { SenderLogoService } from './service.js';
import { LogoStore } from './store.js';
import { LogoOverrideStore } from './overrides.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Логотипы отправителей. Есть всегда — даже когда возможность выключена. */
    senderLogos: SenderLogoService;
  }
}

export async function senderLogosRoutes(app: FastifyInstance): Promise<void> {
  const { logger } = app.deps;
  const config = loadLogoConfig();

  const store = new LogoStore({ config, logger });
  // Одно подключение на весь раздел: кэш и ручные решения живут в одной
  // базе, и второй пул к ней ничего бы не дал, кроме лишних соединений.
  const overrides = new LogoOverrideStore({ pool: store.pool, logger });
  const service = new SenderLogoService({
    config,
    logger,
    store,
    overrides,
    // Помощник ИИ — третий источник и только он. Если модуль ИИ не
    // подключён (маршруты регистрируются раньше, но декорации может не
    // быть в урезанной сборке), источников остаётся два.
    ai: app.hasDecorator('aiService') ? app.aiService : null,
  });
  app.decorate('senderLogos', service);

  if (!config.SENDER_LOGOS_ENABLED) {
    logger.warn('SENDER_LOGOS_ENABLED=false: логотипы отправителей выключены на всём сервере');
  }

  app.addHook('onClose', async () => {
    await store.close().catch(() => undefined);
  });

  await app.register(
    async (scope) => {
      await senderLogoRoutes(scope, service);
    },
    { prefix: '/api' },
  );
}

export { SenderLogoService } from './service.js';
export { LogoStore } from './store.js';
export { LogoOverrideStore } from './overrides.js';
export { adminSenderLogoRoutes } from './admin.js';
