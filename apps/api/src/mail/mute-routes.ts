/**
 * Маршруты заглушённых цепочек.
 *
 *   GET    /api/threads/muted  — подборка и доступность возможности
 *   POST   /api/threads/mute   — заглушить переписки выделенных писем
 *   DELETE /api/threads/mute   — вернуть переписки во «Входящие»
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ НЕ `/api/threads/:id/mute`, КАК БЫЛО НАПИСАНО В РАЗБОРЕ
 * ------------------------------------------------------------------
 * Потому что устойчивого `:id` у переписки не существует. Цепочки собирает
 * почтовый сервер командой THREAD по ссылкам между письмами, и делает это
 * ЗАНОВО при каждом показе папки (mail/threads.ts): результат зависит от
 * того, какие письма лежат в папке сейчас. Идентификатор из такого
 * результата протух бы к следующему запросу.
 *
 * Поэтому заглушают ПИСЬМАМИ («заглушить переписку вот этих писем»), а
 * снимают заглушку ключом записи, который выдала база. Разбор писал план,
 * не зная, что цепочки у нас считает Dovecot; смысл маршрутов при этом
 * ровно тот, что задуман.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError } from '../errors.js';
import { MAX_ENTITY_ID_LENGTH } from './folders.js';
import type { MuteService, MutedThreadItem } from './mute-service.js';
import type { MailSession } from '../types.js';

const messageIdSchema = z.string().min(3).max(MAX_ENTITY_ID_LENGTH);

const muteBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(500),
});

/**
 * Снятие принимает ЛИБО письма, либо ключи записей.
 *
 * Письма — обычный путь из интерфейса: человек выделил строки в
 * «Заглушённых» и нажал «Вернуть переписку». Ключ переписки в письме не
 * лежит, поэтому его вычисляет сервер по заголовкам — тем же разбором,
 * что и при заглушении.
 *
 * Ключи остаются для точечного снятия по строке подборки.
 */
const unmuteBodySchema = z
  .object({
    keys: z.array(z.string().min(1).max(250)).max(100).optional(),
    ids: z.array(messageIdSchema).max(500).optional(),
  })
  .refine((body) => (body.keys?.length ?? 0) > 0 || (body.ids?.length ?? 0) > 0, {
    message: 'Не указано, с чего снимать заглушку',
  });

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Состояние возможности.
 *
 * Два признака, а не один, и это не перестраховка:
 *   available — можно ли заглушать вообще (есть база);
 *   delivery  — дойдёт ли заглушка до ДОСТАВКИ (есть доступ к хранилищу
 *               скриптов Dovecot).
 * Без второго возможность превратилась бы в то самое «прячем в списке»,
 * ради отказа от которого она и делается: человек нажимает кнопку, а
 * письма продолжают падать во «Входящие». Интерфейс обязан сказать об
 * этом словами, а не показать кнопку и промолчать.
 */
export interface MutedState {
  available: boolean;
  delivery: boolean;
  reason: string | null;
  items: MutedThreadItem[];
}

export async function muteRoutes(app: FastifyInstance, mute: MuteService): Promise<void> {
  const { pool } = app.deps;

  app.get(
    '/threads/muted',
    { preHandler: app.requireSession },
    async (request): Promise<MutedState> => {
      const session = requireMailSession(request.mailSession);
      if (!mute.available) {
        return {
          available: false,
          delivery: false,
          reason: mute.unavailableReason,
          items: [],
        };
      }
      return {
        available: true,
        delivery: mute.deliveryAvailable,
        reason: mute.deliveryAvailable
          ? null
          : 'Нет доступа к хранилищу правил Dovecot: заглушённые переписки будут ' +
            'видны в подборке, но новые письма всё равно пойдут во «Входящие»',
        items: await mute.list(session.email),
      };
    },
  );

  app.post('/threads/mute', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = muteBodySchema.parse(request.body);
    return pool.withClient(session.email, session.password, (client) =>
      mute.mute(client, session.email, body.ids),
    );
  });

  /*
   * Снятие заглушки не трогает уже пришедшие письма, и это решение, а не
   * упущение. Они лежат в «Заглушённых» прочитанными; вернуть их во
   * «Входящие» значило бы вывалить человеку разом сорок старых писем
   * переписки, от которой он неделю прятался. Дальнейшее пойдёт во
   * «Входящие», а прошлое остаётся там, где лежит, — и никуда не денется.
   */
  app.delete('/threads/mute', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = unmuteBodySchema.parse(request.body);
    if (body.ids && body.ids.length > 0) {
      return app.deps.pool.withClient(session.email, session.password, (client) =>
        mute.unmuteByMessages(client, session.email, body.ids ?? []),
      );
    }
    return mute.unmute(session.email, body.keys ?? []);
  });
}
