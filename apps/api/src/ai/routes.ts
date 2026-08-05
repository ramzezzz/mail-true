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
import { replyTones, rewriteModes, type AiOutcome } from '@mail-true/ai';
import { UnauthorizedError } from '../errors.js';
import type { MailSession } from '../types.js';
import { AI_FEATURES, defaultFeatures, type AiUserFeature } from './features.js';
import { loadMessageForAi, loadMessagesForAi } from './messages.js';
import { AiDisabledError, aiErrorToHttp } from './errors.js';
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

const streamSchema = z.object({
  messageId: messageIdSchema,
  tone: z.enum(replyTones).default('short'),
  instruction: z.string().trim().max(500).optional(),
});

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

/** Ограничение частоты для тяжёлых маршрутов: сервис ИИ медленный и платный. */
const AI_RATE_LIMIT = { rateLimit: { max: 60, timeWindow: 60_000 } };

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

  /**
   * Что именно уйдёт наружу для конкретного письма — БЕЗ отправки.
   * Нужен экрану согласия: обещания в общих словах — это туман,
   * а здесь пользователь видит настоящий текст своего письма.
   */
  app.get<{ Params: { id: string } }>(
    '/outbound/:id',
    { preHandler: app.requireSession },
    async (request) => {
      const mail = session(request);
      const availability = await service.availability(mail.email);
      if (!availability.available || !availability.assistant) throw new AiDisabledError();
      const message = await loadMessageForAi(app, mail, messageIdSchema.parse(request.params.id));
      return availability.assistant.previewOutbound(message);
    },
  );

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

  app.post('/summarize', { preHandler: app.requireSession, config: AI_RATE_LIMIT }, async (request) => {
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
  });

  /* --- раскладка по смыслу ----------------------------------------- */

  app.post('/classify', { preHandler: app.requireSession, config: AI_RATE_LIMIT }, async (request) => {
    const mail = session(request);
    const body = oneMessageSchema.parse(request.body);
    const { assistant } = await service.forFeature(mail.email, 'classify');
    const message = await loadMessageForAi(app, mail, body.messageId);
    return unwrap(await assistant.classifyMessage(message, { accountId: mail.email }));
  });

  /* --- помощь с ответом -------------------------------------------- */

  app.post('/replies', { preHandler: app.requireSession, config: AI_RATE_LIMIT }, async (request) => {
    const mail = session(request);
    const body = repliesSchema.parse(request.body);
    const { assistant } = await service.forFeature(mail.email, 'reply');
    const message = await loadMessageForAi(app, mail, body.messageId);
    return unwrap(
      await assistant.suggestReplies(message, { accountId: mail.email }, {
        ...(body.tones === undefined ? {} : { tones: body.tones }),
        ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
      }),
    );
  });

  app.post('/continue', { preHandler: app.requireSession, config: AI_RATE_LIMIT }, async (request) => {
    const mail = session(request);
    const body = continueSchema.parse(request.body);
    const { assistant } = await service.forFeature(mail.email, 'reply');
    const message =
      body.messageId === undefined ? null : await loadMessageForAi(app, mail, body.messageId);
    return unwrap(
      await assistant.continueWriting({ draft: body.draft, message }, { accountId: mail.email }),
    );
  });

  app.post('/rewrite', { preHandler: app.requireSession, config: AI_RATE_LIMIT }, async (request) => {
    const mail = session(request);
    const body = rewriteSchema.parse(request.body);
    const { assistant } = await service.forFeature(mail.email, 'reply');
    return unwrap(await assistant.rewriteText(body.text, body.mode, { accountId: mail.email }));
  });

  /* --- извлечение полезного ---------------------------------------- */

  app.post('/extract', { preHandler: app.requireSession, config: AI_RATE_LIMIT }, async (request) => {
    const mail = session(request);
    const body = oneMessageSchema.parse(request.body);
    const { assistant } = await service.forFeature(mail.email, 'extract');
    const message = await loadMessageForAi(app, mail, body.messageId);
    return unwrap(await assistant.extractData(message, { accountId: mail.email }));
  });

  /* --- перевод ------------------------------------------------------ */

  app.post('/translate', { preHandler: app.requireSession, config: AI_RATE_LIMIT }, async (request) => {
    const mail = session(request);
    const body = translateSchema.parse(request.body);
    const { assistant } = await service.forFeature(mail.email, 'translate');
    const ctx = { accountId: mail.email };

    if ('messageId' in body) {
      const message = await loadMessageForAi(app, mail, body.messageId);
      return unwrap(await assistant.translateMessage(message, body.targetLanguage, ctx));
    }
    return unwrap(await assistant.translateText(body.text, body.targetLanguage, ctx));
  });

  /* --- поиск обычными словами --------------------------------------- */

  app.post('/search-query', { preHandler: app.requireSession, config: AI_RATE_LIMIT }, async (request) => {
    const mail = session(request);
    const body = searchQuerySchema.parse(request.body);
    const { assistant } = await service.forFeature(mail.email, 'search');
    return unwrap(await assistant.parseSearchQuery(body.query, { accountId: mail.email }));
  });

  /* --- потоковый черновик ответа ------------------------------------ */

  /**
   * Черновик ответа с потоковой выдачей (Server-Sent Events).
   *
   * Первое событие — `disclosure`: интерфейс покажет опись отправленного
   * ещё до появления первой буквы ответа. Затем идут события `delta`
   * с кусками текста, в конце — `done` или `error`.
   *
   * Метод POST, а не GET: тело письма и пожелание к ответу не должны
   * попадать в адресную строку и журналы прокси.
   */
  app.post(
    '/reply/stream',
    { preHandler: app.requireSession, config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
    async (request, reply) => {
      const mail = session(request);
      const body = streamSchema.parse(request.body);
      const { assistant } = await service.forFeature(mail.email, 'reply');
      const message = await loadMessageForAi(app, mail, body.messageId);

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Отключаем буферизацию nginx: иначе поток дойдёт одним куском.
        'x-accel-buffering': 'no',
      });

      // Пользователь ушёл со страницы — прекращаем запрос к сервису ИИ,
      // чтобы не платить за ответ, который никто не прочитает.
      //
      // Слушаем именно ОТВЕТ, а не запрос: у запроса с телом событие
      // 'close' приходит сразу после вычитывания тела, и отмена сработала
      // бы до первой буквы ответа. Закрытие ответа означает ровно то,
      // что нужно: соединение с клиентом оборвалось.
      const controller = new AbortController();
      let finished = false;
      reply.raw.on('close', () => {
        if (!finished) controller.abort();
      });

      const send = (event: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      try {
        for await (const event of assistant.streamReply(
          message,
          { accountId: mail.email, signal: controller.signal },
          {
            tone: body.tone,
            ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
          },
        )) {
          send(event);
        }
      } catch (err) {
        request.log.warn(errorInfo(err), 'Поток ответа ИИ оборвался');
        send({ type: 'error', error: { kind: 'network', message: 'Поток прервался' } });
      } finally {
        finished = true;
        reply.raw.end();
      }
      // Ответ отправлен вручную через reply.raw — сообщаем об этом Fastify,
      // иначе он попытается отправить его ещё раз.
      return reply;
    },
  );
}
