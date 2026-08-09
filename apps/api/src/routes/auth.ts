/**
 * Аутентификация: вход по email+паролю (проверка IMAP-логином к Dovecot),
 * сессия в Redis, httpOnly-cookie; выход и продление сессии.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { newSessionId } from '../crypto.js';
import { AuthFailedError, UnauthorizedError } from '../errors.js';
import { originOf } from '../settings/access-record.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1024),
});

/**
 * Дописывает страну входа к строке события.
 *
 * Ради этого настройка GEOIP_LOGIN_POLICY=log и существует: в её описании
 * прямо сказано «определять и писать в журнал ящика, пуская всех». Страна
 * определялась — и терялась: при «log» решение всегда «пустить», а
 * вычисленная страна никуда не записывалась. Настройка обещала журнал и
 * не давала ровно ничего: ни в истории ящика, ни в журнале сервера её
 * следа не было, а значит и заметить вход из чужой страны было нечем.
 *
 * Пишем при любой политике, где страна известна (log и allow): человеку,
 * который смотрит «Вход и действия», страна нужна одинаково — и когда её
 * проверяют, и когда только наблюдают.
 */
function withCountry(detail: string, geo: { country: string | null } | undefined): string {
  return geo?.country ? `${detail}, страна ${geo.country}` : detail;
}

export function setSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  sessionId: string,
): void {
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
       * Страна входа — ДО проверки пароля.
       *
       * Порядок важен: если страна запрещена, пароль не проверяется вовсе.
       * Иначе запрет превратился бы в удобную проверялку паролей —
       * подбирающий узнавал бы «пароль верный, но страна не та» и понимал,
       * что пара найдена.
       *
       * Ответ при отказе тот же, что и при неверном пароле, и это не
       * лишняя вежливость: разные ответы сообщают чужому человеку, какие
       * ящики на сервере существуют, и заодно — что защита по стране
       * включена. Настоящая причина уходит в журнал ящика, где её видит
       * владелец.
       */
      const geo = app.deps.geoip?.check(origin.ip ?? '');
      if (geo && !geo.allowed) {
        app.deps.accessLog?.record({
          accountEmail: email,
          kind: 'login.failed',
          success: false,
          detail: `Вход отклонён: ${geo.reason}`,
          ...origin,
        });
        request.log.warn(
          { kind: 'login.failed', ip: request.ip, email, country: geo.country },
          'Вход в веб-почту отклонён по стране',
        );
        throw new AuthFailedError('Неверный адрес или пароль');
      }

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
        /*
         * СНАЧАЛА разбираемся, чей это отказ: человека или Dovecot.
         *
         * pool.verify бросает и то и другое, уже приведённое к контракту:
         * 401 AUTH_FAILED — пароль не подошёл, 503 — почтовый сервер не
         * ответил, оборвал соединение или упёрся в предел соединений
         * (см. classifyImapError: при перегрузке Dovecot присылает
         * authenticationFailed вместе с «too many connections»).
         *
         * Разница здесь не косметическая. Ниже стоят ДВЕ записи, и обе
         * при недоступности врут — каждая по-своему:
         *
         *   * запись в историю ящика показывает владельцу «неудачная
         *     попытка входа» с его собственного адреса — то есть ровно то,
         *     что человек обязан читать как «кто-то подбирает мой пароль»;
         *   * строку в api.log читает fail2ban и БАНИТ адрес целиком, на
         *     всех портах (см. infra/fail2ban/filter.d/mailtrue-api.conf).
         *
         * Вторая и есть настоящая беда. Авария почтового сервера — это
         * когда входят ВСЕ и всем отказывают; при пределе соединений это
         * вдобавок самоусиливается: чем больше людей ломится, тем больше
         * отказов. Через несколько минут забанены свои же пользователи, а
         * с ними — адрес офиса целиком, и после починки Dovecot войти всё
         * равно нельзя, пока не истечёт бан. Защита от подбора пароля
         * превращалась в отказ в обслуживании, устроенный своими руками.
         *
         * Поэтому при недоступности — ни записи, ни строки для камеры.
         * Только жалоба в журнал уровнем error: это событие для
         * администратора, а не для владельца ящика, и в истории доступа
         * ему места нет — там события доступа, а не аварии.
         */
        if ((err as { code?: string } | null)?.code !== 'AUTH_FAILED') {
          request.log.error(
            { kind: 'login.upstream', ip: request.ip, email },
            'Вход в веб-почту не состоялся: почтовый сервер недоступен',
          );
          throw err;
        }

        app.deps.accessLog?.record({
          accountEmail: email,
          kind: 'login.failed',
          success: false,
          detail: withCountry('Неудачная попытка входа через веб-интерфейс', geo),
          ...origin,
        });
        /*
         * Та же неудача — ещё и строкой в журнал сервера (api.log).
         *
         * Запись выше уходит в базу, её читает человек в истории своего
         * ящика. Эту читает fail2ban: у него нет доступа ни к базе, ни к
         * нашему API, он умеет ровно одно — следить за файлом. Без такой
         * строки камера mailtrue-api существует, включена и не ловит
         * ничего, а подбор пароля через веб-форму остаётся прикрыт только
         * ограничением частоты запросов.
         *
         * Адрес берём из request.ip: при заданном TRUSTED_PROXIES это то,
         * что подставил наш же nginx. Заголовку клиента здесь верить
         * нельзя — подбирающий вписал бы туда чужой адрес и банил бы им
         * посторонних чужими руками.
         *
         * Ни пароля, ни его длины в строке нет. Адрес ящика есть: без него
         * в журнале нельзя отличить подбор одного ящика от веерного
         * перебора по всему серверу.
         */
        request.log.warn(
          { kind: 'login.failed', ip: request.ip, email },
          'Неудачная попытка входа в веб-почту',
        );
        throw err;
      }

      const sessionId = newSessionId();
      await sessions.set(
        sessionId,
        { email, passwordEnc: secretBox.encrypt(password), createdAt: Date.now() },
        config.SESSION_TTL_SECONDS,
      );
      setSessionCookie(app, reply, sessionId);
      app.deps.accessLog?.record({
        accountEmail: email,
        kind: 'login',
        detail: withCountry('Вход через веб-интерфейс', geo),
        ...origin,
      });
      return { ok: true, email };
    },
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
