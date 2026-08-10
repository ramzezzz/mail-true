/**
 * Маршруты помощника на основе ИИ для пользователя.
 *
 * Общие правила, единые для всех маршрутов ниже:
 *
 *   1. Каждый требует почтовую сессию: помощник работает от имени
 *      конкретного ящика, и расход считается ему же.
 *   2. Каждый проходит через AiService.forFeature — то есть проверку
 *      «разрешил ли администратор», «дал ли пользователь согласие»,
 *      «включена ли эта возможность». Обойти проверку из маршрута нельзя.
 *   3. Успешный ответ несёт не только результат, но и опись отправленного
 *      (`disclosure`) — чтобы интерфейс мог показать, что именно ушло.
 *      Если ответ взят из кэша, опись равна null: наружу ничего не уходило.
 *   4. Отказ сервиса ИИ не ломает почту. Маршрут вернёт понятную ошибку,
 *      письма при этом читаются и отправляются как обычно.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_ENTITY_ID_LENGTH } from '../mail/folders.js';
import { replyTones, rewriteModes, type AiError, type AiOutcome } from '@mail-true/ai';
import { UnauthorizedError } from '../errors.js';
import type { MailSession } from '../types.js';
import { chatHistorySchema } from './chat-history.js';
import { AI_FEATURES, defaultFeatures, type AiUserFeature } from './features.js';
import { loadMessageForAi, loadMessagesForAi } from './messages.js';
import { aiErrorToHttp } from './errors.js';
import type { AiService } from './service.js';
import { errorInfo } from '../log.js';

/* ------------------------------------------------------------------ */
/* Схемы запросов                                                       */
/* ------------------------------------------------------------------ */

const messageIdSchema = z.string().min(3).max(MAX_ENTITY_ID_LENGTH);

const oneMessageSchema = z.object({ messageId: messageIdSchema });

const threadSchema = z.object({
  messageIds: z.array(messageIdSchema).min(1).max(30),
});

const summarizeSchema = z.union([oneMessageSchema, threadSchema]);

const repliesSchema = z.object({
  messageId: messageIdSchema,
  tones: z.array(z.enum(replyTones)).min(1).max(3).optional(),
  instruction: z.string().trim().max(500).optional(),
});

const continueSchema = z.object({
  draft: z.string().min(1).max(20_000),
  messageId: messageIdSchema.optional(),
});

const rewriteSchema = z.object({
  text: z.string().min(1).max(20_000),
  mode: z.enum(rewriteModes),
});

const translateSchema = z.union([
  z.object({
    messageId: messageIdSchema,
    targetLanguage: z.string().trim().min(2).max(40).default('русский'),
  }),
  z.object({
    text: z.string().min(1).max(20_000),
    targetLanguage: z.string().trim().min(2).max(40).default('русский'),
  }),
]);

const searchQuerySchema = z.object({ query: z.string().trim().min(1).max(500) });

const featureListSchema = z.object({
  features: z.array(z.enum(AI_FEATURES)).max(AI_FEATURES.length),
});

const consentSchema = z.object({
  /** Согласие должно быть осознанным действием, а не значением по умолчанию. */
  accept: z.literal(true),
  features: z.array(z.enum(AI_FEATURES)).max(AI_FEATURES.length).optional(),
});

/**
 * Разговор целиком: история живёт у клиента и приезжает с каждым
 * вопросом. Сервер её не хранит — закрытая вкладка стирает разговор
 * насовсем, и ещё одного места, где лежит переписка человека, не
 * появляется.
 *
 * Пределы здесь — не формальность, а плата: каждый вопрос уходит в
 * сервис вместе со всей историей и оплачивается вместе с ней. Двадцать
 * реплик по четыре тысячи символов — это уже заметная часть дневного
 * предела домена за одно нажатие.
 *
 * Сама схема — общая с чатом администратора (ai/chat-history.ts): там же
 * разобрано, почему ответ помощника обрезается, а вопрос человека нет.
 */
const chatSchema = chatHistorySchema;

/* ------------------------------------------------------------------ */
/* Вспомогательное                                                      */
/* ------------------------------------------------------------------ */

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Превращает результат помощника в тело ответа.
 * Отказ становится ошибкой HTTP с понятным кодом (см. errors.ts).
 */
function unwrap<T>(outcome: AiOutcome<T>): {
  value: T;
  cached: boolean;
  usage: unknown;
  disclosure: unknown;
  durationMs: number;
} {
  if (!outcome.ok) throw aiErrorToHttp(outcome.error);
  return {
    value: outcome.value,
    cached: outcome.cached,
    usage: outcome.usage,
    disclosure: outcome.disclosure,
    durationMs: outcome.durationMs,
  };
}

/**
 * Ограничение частоты для тяжёлых маршрутов: сервис ИИ медленный и платный.
 *
 * ------------------------------------------------------------------
 * СЧИТАЕТСЯ ПО ЯЩИКУ, А НЕ ПО АДРЕСУ КЛИЕНТА
 * ------------------------------------------------------------------
 * Умолчание ограничителя — ключ по адресу клиента и обработчик onRequest,
 * то есть ДО проверки сессии. Для помощника это неверно с обеих сторон:
 * контора за одним внешним адресом делила шестьдесят запросов в минуту
 * между всеми сотрудниками сразу (а расход считается по домену, и предел
 * этот не спасал), тогда как захваченный ящик с домашнего адреса получал
 * все шестьдесят в одиночку. Тот же разбор — у отправки письма
 * (routes/compose.ts), там это давно исправлено.
 *
 * `hook: 'preHandler'` обязателен: на onRequest `request.mailSession` ещё
 * пуст, и ключом молча снова стал бы адрес клиента.
 */
const AI_RATE_LIMIT = {
  rateLimit: {
    max: 60,
    timeWindow: 60_000,
    hook: 'preHandler' as const,
    keyGenerator: (request: { mailSession?: MailSession | null; ip: string }): string =>
      request.mailSession?.email ?? request.ip,
  },
};

/**
 * Событие потока в том виде, в каком его можно показать браузеру.
 *
 * Поток сериализовал событие целиком, вместе с полем `details`, про
 * которое в типе прямо написано «в интерфейс не выводится»: туда
 * попадает сырое тело ответа поставщика — до 500 символов, в том числе
 * при 401 и 403, где сервисы охотно пишут подробности про ключ и
 * организацию. Обычные маршруты берут из отказа только `message`
 * (см. errors.ts), а потоковый отдавал всё. Здесь тот же отбор.
 */
export interface StreamEventLike {
  type: string;
  error?: AiError;
}

export function publicStreamEvent(event: StreamEventLike): unknown {
  if (event.type !== 'error') return event;
  const error = event.error;
  if (!error) return { type: 'error' };
  return {
    type: 'error',
    error: {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Маршруты                                                             */
/* ------------------------------------------------------------------ */

export async function aiUserRoutes(app: FastifyInstance, service: AiService): Promise<void> {
  const session = (request: { mailSession: MailSession | null }): MailSession =>
    requireMailSession(request.mailSession);

  /**
   * Состояние помощника: включён ли, какие возможности доступны,
   * что именно уходит наружу, сколько израсходовано.
   *
   * Ключевой маршрут для интерфейса. Если `enabled: false`, интерфейс
   * не показывает ни одной кнопки ИИ — не показывает и получает отказ,
   * а именно не показывает.
   */
  app.get('/state', { preHandler: app.requireSession }, async (request) => {
    return service.state(session(request).email);
  });

  /* --- согласие ---------------------------------------------------- */

  /**
   * Дать согласие. Записывается вместе с адресом сервиса и моделью,
   * на которые пользователь соглашался: смена сервиса администратором
   * обесценивает согласие, и оно будет спрошено заново.
   */
  app.post('/consent', { preHandler: app.requireSession }, async (request) => {
    const mail = session(request);
    const body = consentSchema.parse(request.body);
    // Список не прислан — включаем набор по умолчанию, а не «ничего».
    const features: AiUserFeature[] = body.features ? [...body.features] : defaultFeatures();
    await service.grantConsent(mail.email, features);
    return service.state(mail.email);
  });

  /**
   * Отозвать согласие. Вместе с ним удаляются ВСЕ созданные помощником
   * резюме, метки, извлечённые данные и переводы этого пользователя.
   * Не «помечаются удалёнными» — удаляются.
   */
  app.delete('/consent', { preHandler: app.requireSession }, async (request) => {
    const mail = session(request);
    const { removedCacheEntries } = await service.revokeConsent(mail.email);
    const state = await service.state(mail.email);
    return { ...state, removedCacheEntries };
  });

  /** Какие возможности пользователь оставляет включёнными. */
  app.put('/features', { preHandler: app.requireSession }, async (request) => {
    const mail = session(request);
    const body = featureListSchema.parse(request.body);
    await service.saveFeatures(mail.email, [...body.features]);
    return service.state(mail.email);
  });

  /** Сколько потрачено и сколько осталось. */
  app.get('/usage', { preHandler: app.requireSession }, async (request) => {
    const mail = session(request);
    const availability = await service.availability(mail.email);
    if (!availability.available || !availability.assistant) {
      return { enabled: false, budget: null, totals: null };
    }
    const budget = await service.budget(mail.email, availability.assistant);
    const totals = await service.audit.totals({ accountId: mail.email });
    const recent = await service.audit.list({ accountId: mail.email, limit: 20 });
    return { enabled: true, budget, totals, recent };
  });

  /** Забыть всё, что помощник насчитал по одному письму. */
  app.delete<{ Params: { id: string } }>(
    '/messages/:id',
    { preHandler: app.requireSession },
    async (request) => {
      const mail = session(request);
      const removed = await service.forgetMessage(
        mail.email,
        messageIdSchema.parse(request.params.id),
      );
      return { removed };
    },
  );

  /* --- резюме ------------------------------------------------------ */

  app.post(
    '/summarize',
    { preHandler: app.requireSession, config: AI_RATE_LIMIT },
    async (request) => {
      const mail = session(request);
      const body = summarizeSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'summary');
      const ctx = { accountId: mail.email };

      if ('messageIds' in body) {
        const messages = await loadMessagesForAi(app, mail, body.messageIds);
        return unwrap(await assistant.summarizeThread(messages, ctx));
      }
      const message = await loadMessageForAi(app, mail, body.messageId);
      return unwrap(await assistant.summarizeMessage(message, ctx));
    },
  );

  /* --- раскладка по смыслу ----------------------------------------- */

  app.post(
    '/classify',
    { preHandler: app.requireSession, config: AI_RATE_LIMIT },
    async (request) => {
      const mail = session(request);
      const body = oneMessageSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'classify');
      const message = await loadMessageForAi(app, mail, body.messageId);
      return unwrap(await assistant.classifyMessage(message, { accountId: mail.email }));
    },
  );

  /* --- помощь с ответом -------------------------------------------- */

  app.post(
    '/replies',
    { preHandler: app.requireSession, config: AI_RATE_LIMIT },
    async (request) => {
      const mail = session(request);
      const body = repliesSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'reply');
      const message = await loadMessageForAi(app, mail, body.messageId);
      return unwrap(
        await assistant.suggestReplies(
          message,
          { accountId: mail.email },
          {
            ...(body.tones === undefined ? {} : { tones: body.tones }),
            ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
          },
        ),
      );
    },
  );

  app.post(
    '/continue',
    { preHandler: app.requireSession, config: AI_RATE_LIMIT },
    async (request) => {
      const mail = session(request);
      const body = continueSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'reply');
      const message =
        body.messageId === undefined ? null : await loadMessageForAi(app, mail, body.messageId);
      return unwrap(
        await assistant.continueWriting({ draft: body.draft, message }, { accountId: mail.email }),
      );
    },
  );

  app.post(
    '/rewrite',
    { preHandler: app.requireSession, config: AI_RATE_LIMIT },
    async (request) => {
      const mail = session(request);
      const body = rewriteSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'reply');
      return unwrap(await assistant.rewriteText(body.text, body.mode, { accountId: mail.email }));
    },
  );

  /* --- извлечение полезного ---------------------------------------- */

  app.post(
    '/extract',
    { preHandler: app.requireSession, config: AI_RATE_LIMIT },
    async (request) => {
      const mail = session(request);
      const body = oneMessageSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'extract');
      const message = await loadMessageForAi(app, mail, body.messageId);
      return unwrap(await assistant.extractData(message, { accountId: mail.email }));
    },
  );

  /* --- перевод ------------------------------------------------------ */

  app.post(
    '/translate',
    { preHandler: app.requireSession, config: AI_RATE_LIMIT },
    async (request) => {
      const mail = session(request);
      const body = translateSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'translate');
      const ctx = { accountId: mail.email };

      if ('messageId' in body) {
        const message = await loadMessageForAi(app, mail, body.messageId);
        return unwrap(await assistant.translateMessage(message, body.targetLanguage, ctx));
      }
      return unwrap(await assistant.translateText(body.text, body.targetLanguage, ctx));
    },
  );

  /* --- поиск обычными словами --------------------------------------- */

  app.post(
    '/search-query',
    { preHandler: app.requireSession, config: AI_RATE_LIMIT },
    async (request) => {
      const mail = session(request);
      const body = searchQuerySchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'search');
      return unwrap(await assistant.parseSearchQuery(body.query, { accountId: mail.email }));
    },
  );

  /* --- разговор ------------------------------------------------------ */

  /**
   * Свободный разговор с помощником (Server-Sent Events).
   *
   * ------------------------------------------------------------------
   * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ
   * ------------------------------------------------------------------
   * Есть: то, что человек написал сам, и ответ модели кусками.
   *
   * Нет: доступа к почте, к настройкам, к чему бы то ни было на сервере.
   * И это не только текст в правилах для модели — сюда просто нечего
   * передать: маршрут не читает ни одного письма и не даёт модели
   * никаких средств что-либо запросить. Даже уговорив её, получить через
   * разговор чужой пароль или настройку невозможно, потому что их здесь
   * нет.
   *
   * Возможность отдельная («chat») и по умолчанию выключена: разговоры
   * тратят тот же предел домена, что и разбор писем.
   */
  app.post(
    '/chat/stream',
    { preHandler: app.requireSession, config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
    async (request, reply) => {
      const mail = session(request);
      const body = chatSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'chat');

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      // Слушаем закрытие ОТВЕТА, а не запроса: у запроса с телом 'close'
      // приходит сразу после вычитывания тела, и разговор обрывался бы
      // до первой буквы.
      const controller = new AbortController();
      let finished = false;
      reply.raw.on('close', () => {
        if (!finished) controller.abort();
      });

      const send = (event: StreamEventLike): void => {
        reply.raw.write(`data: ${JSON.stringify(publicStreamEvent(event))}

`);
      };

      try {
        for await (const event of assistant.streamChat(body.messages, {
          accountId: mail.email,
          signal: controller.signal,
        })) {
          send(event);
        }
      } catch (err) {
        request.log.warn(errorInfo(err), 'Поток разговора с ИИ оборвался');
        send({
          type: 'error',
          error: {
            kind: 'network',
            message: 'Поток прервался',
            retryable: true,
            status: null,
            details: null,
          },
        });
      } finally {
        finished = true;
        reply.raw.end();
      }
      return reply;
    },
  );
}
