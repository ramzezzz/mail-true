/**
 * Маршруты «напомнить, если не ответили».
 *
 *   GET    /api/messages/awaiting     — подборка «Ждут ответа» и доступность
 *   POST   /api/messages/await-reply  — ждать ответа на эти письма до срока
 *   DELETE /api/messages/await-reply  — «больше не ждать»
 *
 * Адреса взяты из разбора (docs/gaps.md, п. 4) как есть, кроме одного:
 * `DELETE /api/messages/await-reply/:id` заменён на тело со списком
 * идентификаторов — снимают ожидание с нескольких писем разом, ровно так
 * же, как ставят, и второй разбор идентификатора письма (в адресе вместо
 * тела) означал бы второе место, где он однажды разойдётся с первым.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError } from '../errors.js';
import { MAX_ENTITY_ID_LENGTH } from './folders.js';
import type { AwaitReplyService, AwaitingItem } from './await-reply-service.js';
import type { MailSession } from '../types.js';

const messageIdSchema = z.string().min(3).max(MAX_ENTITY_ID_LENGTH);

/**
 * Срок разбирается теми же полями, что и откладывание письма.
 *
 * Готовые сроки у двух возможностей общие намеренно: «завтра утром»
 * обязано означать одно и то же и там, и там (см. mail/snooze-schedule.ts).
 */
const waitBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(100),
  preset: z.enum(['tomorrow-morning', 'monday', 'next-week', 'custom']).optional(),
  until: z.string().min(1).max(64).optional(),
  timeZone: z.string().max(64).optional(),
});

const cancelBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(100),
});

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Состояние возможности.
 *
 * Два признака, как и у заглушённых цепочек:
 *   available     — можно ли ставить срок (есть база);
 *   scheduledCheck — проверит ли сервер срок САМ (настроен служебный вход
 *                    в Dovecot). Без второго кнопка обещала бы то, чего
 *                    не будет: срок поставится, а никто его не проверит.
 */
export interface AwaitingState {
  available: boolean;
  scheduledCheck: boolean;
  reason: string | null;
  items: AwaitingItem[];
}

export async function awaitReplyRoutes(
  app: FastifyInstance,
  service: AwaitReplyService,
): Promise<void> {
  const { pool } = app.deps;

  app.get(
    '/messages/awaiting',
    { preHandler: app.requireSession },
    async (request): Promise<AwaitingState> => {
      const session = requireMailSession(request.mailSession);
      if (!service.available) {
        return {
          available: false,
          scheduledCheck: false,
          reason: service.unavailableReason,
          items: [],
        };
      }
      return {
        available: true,
        scheduledCheck: service.scheduledCheckAvailable,
        reason: service.scheduledCheckAvailable
          ? null
          : 'Служебный доступ Dovecot не настроен: проверить ответ в срок будет некому',
        items: await service.list(session.email),
      };
    },
  );

  app.post('/messages/await-reply', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = waitBodySchema.parse(request.body);
    return pool.withClient(session.email, session.password, (client) =>
      service.wait(client, session.email, body.ids, {
        preset: body.preset,
        until: body.until,
        timeZone: body.timeZone,
      }),
    );
  });

  app.delete('/messages/await-reply', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = cancelBodySchema.parse(request.body);
    return pool.withClient(session.email, session.password, (client) =>
      service.cancel(client, session.email, body.ids),
    );
  });
}
