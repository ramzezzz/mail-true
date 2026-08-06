/**
 * Аутентификация: вход по email+паролю (проверка IMAP-логином к Dovecot),
 * сессия в Redis, httpOnly-cookie; выход и продление сессии.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { newSessionId } from '../crypto.js';
import { UnauthorizedError } from '../errors.js';
import { originOf } from '../settings/access-record.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1024),
});

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, sessionId: string): void {
  const { config } = app.deps;
  reply.setCookie(config.SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    signed: true,
    path: '/',
    maxAge: config.SESSION_TTL_SECONDS,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { config, sessions, secretBox, pool } = app.deps;

  // Вход: строже ограничиваем частоту (защита от перебора паролей)
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: { max: 10, timeWindow: 60_000 },
      },
    },
    async (request, reply) => {
      const { email, password } = loginSchema.parse(request.body);
      const origin = originOf(request);

      /*
       * Проверяем учётные данные реальным IMAP-логином.
       *
       * Неудача записывается в историю ящика ровно так же, как удача, и
       * это половина смысла раздела «Вход и действия»: человек, у которого
       * подбирают пароль, обязан увидеть три отказа подряд с чужого адреса.
       * Записываем ДО того, как бросить ошибку, — иначе в историю попадали
       * бы только успешные попытки, то есть только те, о которых человек
       * и так знает.
       *
       * Пароля здесь нет ни в каком виде: ни введённого, ни его длины.
       * Это журнал доступа, а не ловушка для опечаток.
       */
      try {
        await pool.verify(email, password);
      } catch (err) {
        app.deps.accessLog?.record({
          accountEmail: email,
          kind: 'login.failed',
          success: false,
          detail: 'Неудачная попытка входа через веб-интерфейс',
          ...origin,
        });
        throw err;
      }

      const sessionId = newSessionId();
      await sessions.set(
        sessionId,
        { email, passwordEnc: secretBox.encrypt(password), createdAt: Date.now() },
        config.SESSION_TTL_SECONDS
      );
      setSessionCookie(app, reply, sessionId);
      app.deps.accessLog?.record({
        accountEmail: email,
        kind: 'login',
        detail: 'Вход через веб-интерфейс',
        ...origin,
      });
      return { ok: true, email };
    }
  );

  // Выход: удаляем сессию и закрываем IMAP-соединения пользователя
  app.post('/auth/logout', async (request, reply) => {
    const raw = request.cookies[config.SESSION_COOKIE_NAME];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const data = await sessions.get(unsigned.value);
        await sessions.delete(unsigned.value);
        if (data) {
          await pool.closeUser(data.email).catch(() => undefined);
          app.deps.accessLog?.record({
            accountEmail: data.email,
            kind: 'logout',
            detail: 'Выход из почты',
            ...originOf(request),
          });
        }
      }
    }
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  // Текущая сессия + продление срока жизни
  app.get('/auth/session', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    // Пределы отдаём вместе с сессией, а не отдельным запросом: без них
    // интерфейс узнаёт о слишком большом вложении ТОЛЬКО после того, как
    // гигабайты уже уехали по сети, — человек ждёт впустую и получает отказ
    // в конце. Предел вложения — производная предела письма (вложение при
    // кодировании растёт), см. ENCODING_OVERHEAD в config.ts.
    return {
      authenticated: true,
      email: session.email,
      limits: {
        attachmentBytes: config.ATTACHMENT_MAX_BYTES,
        messageBytes: config.MESSAGE_MAX_BYTES,
      },
    };
  });
}
