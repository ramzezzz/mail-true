/**
 * Маршруты уведомлений о новой почте.
 *
 * Все требуют почтовую сессию и работают только со своим ящиком: адрес
 * берётся из сессии, а не из тела запроса. Передать чужой адрес нельзя —
 * не потому что «проверяем», а потому что его негде указать.
 *
 * Отдельного маршрута «пометить прочитанным» и «в архив» здесь НЕТ
 * намеренно: кнопки в уведомлении обращаются к тем же самым
 * /api/messages/flags и /api/messages/move, что и сама почта. Второй путь
 * к тем же действиям — это второй набор проверок прав, который рано или
 * поздно разойдётся с первым.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, UnauthorizedError } from '../errors.js';
import { MAX_ENTITY_ID_LENGTH } from '../mail/folders.js';
import type { MailSession } from '../types.js';
import { accountKey, type PushService } from './service.js';
import { NOTIFICATION_LEVELS } from './types.js';

/* ------------------------------------------------------------------ */
/* Схемы                                                                */
/* ------------------------------------------------------------------ */

/**
 * Отпечаток браузера. Придумывает его сам браузер и хранит у себя;
 * сервер только сравнивает. Длину ограничиваем, чтобы в базу не приезжала
 * строка на мегабайт.
 */
const clientIdSchema = z.string().trim().min(1).max(64);

const subscribeSchema = z.object({
  /**
   * Адрес службы доставки. Он же секрет подписки, поэтому проверяем
   * схему: `http://` и тем более `file://` тут быть не может — это
   * означало бы, что сервер уговорили постучаться куда-то ещё.
   */
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine((v) => v.startsWith('https://'), {
      message: 'Адрес службы доставки должен быть https',
    }),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
  clientId: clientIdSchema,
  /** Пояс браузера для «тихих часов»: у сервера он свой и не тот. */
  timeZone: z.string().trim().max(64).optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().max(2000) });

const prefsSchema = z.object({
  level: z.enum(NOTIFICATION_LEVELS).optional(),
  push: z.boolean().optional(),
  pushPayload: z.boolean().optional(),
  skipFiltered: z.boolean().optional(),
  quietEnabled: z.boolean().optional(),
  /** Минуты от полуночи: 0..1439. Часы и минуты собирает интерфейс. */
  quietFrom: z.number().int().min(0).max(1439).optional(),
  quietTo: z.number().int().min(0).max(1439).optional(),
  timeZone: z.string().trim().max(64).nullable().optional(),
});

const seenSchema = z.object({
  ids: z.array(z.string().min(1).max(MAX_ENTITY_ID_LENGTH)).max(200).optional(),
});

const testSchema = z.object({ clientId: clientIdSchema });

const notificationsQuerySchema = z.object({
  /** Ограничить конкретными письмами. Без него — все неувиденные. */
  ids: z.string().max(4000).optional(),
  /**
   * Отпечаток ящика, которому пришло уведомление.
   *
   * Работник уведомлений в браузере получает его прямо в push и передаёт
   * сюда. Проверка нужна потому, что подписка привязана к адресу в момент
   * включения, а сессия в браузере с тех пор могла смениться: человек
   * переключился на второй ящик. Тогда письмо приходило в первый, а
   * содержимое собиралось по текущей сессии — и в окне показывались
   * письма ДРУГОГО ящика (а если новых там нет, безымянное «Новое
   * письмо»). Отпечаток — это хеш адреса, самого адреса он не открывает.
   */
  k: z.string().max(64).optional(),
});

/* ------------------------------------------------------------------ */
/* Маршруты                                                             */
/* ------------------------------------------------------------------ */

export async function pushRoutes(app: FastifyInstance, service: PushService): Promise<void> {
  const sessionOf = (request: { mailSession: MailSession | null }): MailSession => {
    if (!request.mailSession) throw new UnauthorizedError();
    return request.mailSession;
  };

  const requireDb = (): void => {
    if (!service.db) {
      throw new BadRequestError(
        'Настройки уведомлений недоступны: сервер работает без базы. ' +
          'Уведомления при открытой вкладке продолжают работать.',
      );
    }
  };

  /**
   * Состояние раздела: ключ для подписки, настройки, список устройств
   * и доступность уровня со сводкой ИИ.
   *
   * С этого маршрута начинается весь интерфейс уведомлений — в том числе
   * честный рассказ о том, почему что-то не работает.
   */
  app.get<{ Querystring: { clientId?: string } }>(
    '/state',
    { preHandler: app.requireSession },
    async (request) => {
      const session = sessionOf(request);
      const clientId = request.query.clientId?.trim() ?? null;
      return service.state(session.email, clientId === '' ? null : clientId);
    },
  );

  app.put('/prefs', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    requireDb();
    const patch = prefsSchema.parse(request.body ?? {});
    return service.savePrefs(session.email, patch);
  });

  /**
   * Подписка браузера.
   *
   * Часовой пояс приезжает вместе с подпиской, а не отдельной настройкой:
   * «тихие часы» задаются по местному времени человека, и спрашивать его
   * об этом отдельно было бы лишним вопросом с готовым ответом.
   */
  app.post('/subscribe', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    requireDb();
    if (!service.pushAvailable) {
      throw new BadRequestError(
        service.pushUnavailableReason ?? 'Уведомления при закрытой вкладке недоступны',
      );
    }
    const body = subscribeSchema.parse(request.body);
    const db = service.db!;
    await db.saveSubscription({
      accountEmail: session.email,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      clientId: body.clientId,
      userAgent: (request.headers['user-agent'] ?? null)?.slice(0, 500) ?? null,
    });
    if (body.timeZone) await db.savePrefs(session.email, { timeZone: body.timeZone });
    return service.state(session.email, body.clientId);
  });

  app.post('/unsubscribe', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    requireDb();
    const body = unsubscribeSchema.parse(request.body);
    const removed = await service.db!.deleteSubscription(session.email, body.endpoint);
    return { removed };
  });

  /**
   * Содержимое уведомления.
   *
   * Ради этого маршрута всё и затевалось: в push уходит только «есть
   * новости», а тему, отправителя и первые фразы Service Worker берёт
   * ЗДЕСЬ — с нашего сервера, по той же сессии, что и открытая вкладка.
   * Наружу при этом не уходит ничего.
   */
  app.get<{ Querystring: { ids?: string } }>(
    '/notifications',
    {
      preHandler: app.requireSession,
      // Предел выше общего: при десятке писем подряд Service Worker
      // спросит содержимое на каждое push-сообщение.
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request) => {
      const session = sessionOf(request);
      const query = notificationsQuerySchema.parse(request.query ?? {});
      /*
       * Уведомление пришло другому ящику, а в браузере открыт этот.
       * Показывать чужие письма нельзя, а показывать письма открытого
       * ящика — значит соврать: человек решит, что написали туда, куда
       * не писали. Отвечаем пустотой, и работник покажет безымянное
       * «Новое письмо» — честный минимум.
       */
      if (query.k && query.k !== accountKey(session.email)) {
        return { view: null, pending: 0 };
      }
      const ids = query.ids
        ?.split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '');
      const view = await service.buildView(
        session,
        undefined,
        ids && ids.length > 0 ? { ids } : {},
      );
      return { view, pending: service.pending(session.email).length };
    },
  );

  /**
   * Уведомление увидели: по нему щёлкнули, его закрыли или человек
   * открыл почту. Без списка — забываем все: новостей больше нет.
   */
  app.post('/seen', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const body = seenSchema.parse(request.body ?? {});
    const forgotten = service.markSeen(session.email, body.ids);
    return { forgotten, pending: service.pending(session.email).length };
  });

  /**
   * Проверочное уведомление.
   *
   * Нужно не для красоты: разрешение выдано, подписка создана, а окно не
   * появляется — и выяснить, на каком именно шаге всё встало, иначе
   * нечем. Уходит тем же путём и тем же телом, что и настоящее.
   */
  app.post(
    '/test',
    {
      preHandler: app.requireSession,
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request) => {
      const session = sessionOf(request);
      const body = testSchema.parse(request.body ?? {});
      return service.sendTestPush(session.email, body.clientId);
    },
  );
}
