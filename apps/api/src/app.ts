/**
 * Сборка Fastify-приложения: плагины, middleware сессий, маршруты,
 * обработка ошибок, ограничение частоты запросов.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { UnauthorizedError } from './errors.js';
import {
  brokenCriticalParts,
  HealthMonitor,
  IMAP_FAREWELL,
  SMTP_FAREWELL,
  tcpPart,
} from './health.js';
import { mapFrameworkError, rateLimitedError, registerErrorHandling } from './http-errors.js';
import { MAX_ENTITY_ID_LENGTH } from './mail/folders.js';
import type { AppDeps } from './types.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { folderRoutes } from './routes/folders.js';
import { messageRoutes } from './routes/messages.js';
import { composeRoutes } from './routes/compose.js';
import { uploadRoutes } from './routes/uploads.js';
import { versionRoutes } from './routes/version.js';
import { MailNotifier, wsRoutes } from './ws.js';
import { adminRoutes } from './admin/index.js';
import { aiRoutes } from './ai/index.js';
import { settingsRoutes } from './settings/index.js';
import { accountsRoutes } from './accounts/index.js';
import { senderLogosRoutes } from './logos/index.js';
import { pushNotificationRoutes } from './push/index.js';

export interface BuiltApp {
  app: FastifyInstance;
  notifier: MailNotifier;
}

/**
 * Собирает пробу состояния почтового API.
 *
 * Здесь регистрируются только те части, о которых знает сам почтовый API.
 * Postgres добавляет админка (см. src/admin/index.ts) — у неё подключение,
 * и открывать второе ради пробы незачем.
 */
function buildHealthMonitor(deps: AppDeps): HealthMonitor {
  const { config, sessions } = deps;
  const monitor = new HealthMonitor({
    ttlMs: config.HEALTH_CACHE_MS,
    timeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
  });

  monitor.register({
    id: 'redis',
    title: 'Redis (сессии)',
    // Без хранилища сессий ни один вошедший пользователь не сделает
    // ни одного запроса, а войти заново не выйдет: сессию некуда положить.
    critical: config.SESSION_STORE === 'redis',
    probe: () => sessions.ping(),
  });

  monitor.register(
    tcpPart({
      id: 'imap',
      title: 'Dovecot (IMAP)',
      critical: true,
      host: config.IMAP_HOST,
      port: config.IMAP_PORT,
      timeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
      farewell: IMAP_FAREWELL,
      consequence: 'почта не читается',
    }),
  );

  monitor.register(
    tcpPart({
      id: 'smtp',
      title: 'Postfix (отправка)',
      // Не критично намеренно: без отправки почту всё ещё можно читать,
      // а красная проба увела бы сервер приложения из работы целиком.
      critical: false,
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      timeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
      farewell: SMTP_FAREWELL,
      consequence: 'письма не отправляются, чтение работает',
    }),
  );

  return monitor;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config, logger } = deps;

  // Приводим к базовому типу: generic с pino-логгером мешает композиции маршрутов
  const app = Fastify({
    loggerInstance: logger,
    // Доверять заголовку X-Forwarded-For можно ТОЛЬКО от своего обратного
    // прокси. Раньше здесь стояло `true`, то есть заголовку верили от кого
    // угодно — а его подставляет сам клиент. Последствия проверены:
    //
    //   1. Ограничение частоты запросов обходилось полностью: счётчик
    //      ведётся по адресу клиента, и достаточно было менять заголовок,
    //      чтобы каждый запрос считался новым. Защита от подбора пароля
    //      на входе (10 попыток в минуту) переставала работать вовсе.
    //   2. В журнал аудита администратора попадал любой адрес, какой
    //      пожелает атакующий, — журнал переставал что-либо доказывать.
    //
    // Список доверенных задаётся настройкой: по умолчанию петля и внутренняя
    // сеть стека, где стоит nginx. Всё, что приходит снаружи, больше не
    // способно подменить свой адрес.
    trustProxy: config.TRUSTED_PROXIES,
    bodyLimit: 2 * 1024 * 1024,
    // Предел длины параметра в адресе. У Fastify по умолчанию сто символов,
    // а наши идентификаторы несут в себе путь папки: `f-<base64url(путь)>`
    // и `<папка>:<номер письма>`. Кириллическое название из 37 букв уже
    // выходило за сотню — и папка превращалась в ловушку: письма в ней
    // нельзя было ни открыть, ни вынести обратно. Предел согласован с
    // MAX_FOLDER_PATH_BYTES, см. mail/folders.ts.
    maxParamLength: MAX_ENTITY_ID_LENGTH * 2,
    disableRequestLogging: config.NODE_ENV === 'production',
    // Ошибки маршрутизатора (слишком длинный параметр в адресе, битый URL)
    // до обработчика ошибок не доходят вовсе: Fastify отвечает на них сам и
    // в своей форме тела `{statusCode, code, error, message}`. Интерфейс
    // читает поле `error` как код — и показывал пользователю «Bad Request»
    // вместо кода из контракта. Перехватываем здесь.
    frameworkErrors: (error, _request, reply) => {
      const { status, body } = mapFrameworkError(error);
      const send = reply as unknown as {
        status(code: number): { send(payload: unknown): unknown };
      };
      send.status(status).send(body);
    },
  }) as unknown as FastifyInstance;

  app.decorate('deps', deps);
  app.decorateRequest('mailSession', null);
  // Проба живёт на корневом приложении: её пополняет админка и читает
  // сводка состояния — все вложенные области видят одну и ту же.
  app.decorate('health', buildHealthMonitor(deps));

  await app.register(cors, {
    origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // Ответ по контракту: код из docs/api.md и текст по-русски.
    // Плагин бросает то, что вернёт эта функция, — поэтому возвращаем
    // настоящую ошибку со статусом, а её вид приводит общий обработчик.
    // `context.after` плагин формирует по-английски («32 seconds»), поэтому
    // берём численное `context.ttl` и склоняем сами — см. rateLimitedError.
    errorResponseBuilder: (_request, context) => rateLimitedError(context),
  });
  await app.register(multipart, {
    // Действующий предел вложения выведен из предела письма: файл, который
    // после кодирования заведомо не пролезет в письмо, принимать незачем
    limits: { fileSize: config.ATTACHMENT_MAX_BYTES, files: 20 },
  });
  await app.register(websocket);

  // Middleware проверки сессии: cookie -> Redis -> request.mailSession
  app.decorate('requireSession', async function (request) {
    const raw = request.cookies[config.SESSION_COOKIE_NAME];
    if (!raw) throw new UnauthorizedError();
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) throw new UnauthorizedError();

    const sessionId = unsigned.value;
    const data = await deps.sessions.get(sessionId);
    if (!data) throw new UnauthorizedError('Сессия истекла');

    let password: string;
    try {
      password = deps.secretBox.decrypt(data.passwordEnc);
    } catch {
      await deps.sessions.delete(sessionId);
      throw new UnauthorizedError('Сессия повреждена');
    }

    request.mailSession = { id: sessionId, email: data.email, password };
    // Скользящее продление сессии
    void deps.sessions.touch(sessionId, config.SESSION_TTL_SECONDS).catch(() => undefined);
  });

  // Единая обработка ошибок: любая ошибка выходит наружу в форме контракта
  // `{error, message}` — включая ошибки самого Fastify, которые раньше
  // отдавали английские тексты и коды, которых нет в docs/api.md
  registerErrorHandling(app);

  /*
   * Проба контейнера. Ответ намеренно короткий: её читает `wget | grep`
   * в healthcheck образа и обратный прокси, а не человек.
   *
   * Почему 503, а не 500. Пятисотый значит «сервер сломан, чинить его».
   * Здесь сервер цел — недоступна часть, от которой он зависит, и как
   * только она вернётся, всё заработает само. 503 — ровно это: «не готов
   * принимать запросы прямо сейчас». Обратный прокси уводит такой узел из
   * работы, контейнер помечается unhealthy, но процесс НЕ падает: убивать
   * его бессмысленно, лежащий Redis от перезапуска соседа не оживёт, а
   * перезапуски пошли бы по кругу. Ровно поэтому в пробу входит только то,
   * без чего продукт не работает вовсе, — антиспама и отправки здесь нет.
   */
  app.get('/healthz', { config: { rateLimit: false } }, async (_request, reply) => {
    const report = await app.health.report();
    const broken = brokenCriticalParts(report);
    if (broken.length > 0) {
      void reply.status(503);
      return {
        ok: false,
        status: report.status,
        uptime: report.uptimeSeconds,
        failed: broken.map((p) => p.id),
      };
    }
    return { ok: true, status: report.status, uptime: report.uptimeSeconds };
  });

  /*
   * То же состояние для человека: перечень частей, что с каждой и чем
   * грозит отказ. Отвечает 200 ВСЕГДА — это диагностическая страница, и
   * читать её нужно именно тогда, когда что-то сломано; сообщать об отказе
   * отказом значит прятать ответ. Само состояние — в поле `status`.
   */
  app.get('/health', { config: { rateLimit: false } }, async () => app.health.report());

  const notifier = new MailNotifier(config, logger);

  await app.register(
    async (api) => {
      await authRoutes(api);
      await accountRoutes(api);
      await folderRoutes(api);
      await messageRoutes(api);
      await composeRoutes(api);
      await uploadRoutes(api);
      // Версия сервера для нижней строки состояния в почте
      await versionRoutes(api);
    },
    { prefix: '/api' }
  );

  // Помощник на основе ИИ (см. src/ai/). Регистрируется ДО админки:
  // админский раздел ИИ забирает готовый сервис из декорации aiService.
  await aiRoutes(app);

  // Админка: собственная аутентификация, сессии и права (см. src/admin/)
  await adminRoutes(app);

  // Настройки ящика и правила фильтрации (см. src/settings/),
  // подключение своих и чужих ящиков (см. src/accounts/)
  await settingsRoutes(app);
  await accountsRoutes(app);

  // Логотипы доменов отправителей (см. src/logos/). Регистрируются ПОСЛЕ
  // настроек: маршрут спрашивает у них, разрешил ли человек эту возможность,
  // и ПОСЛЕ ИИ — помощник у них третий источник после BIMI и значка сайта.
  await senderLogosRoutes(app);

  /*
   * Уведомления о новой почте (см. src/push/). Регистрируются ПОСЛЕДНИМИ
   * из разделов: они собирают у себя всё сразу — главный выключатель из
   * настроек ящика, сводку у помощника ИИ и значок отправителя у
   * логотипов. Все три берутся готовыми сервисами из декораций, поэтому
   * порядок здесь не «для красоты»: раньше — и декораций ещё нет.
   */
  await pushNotificationRoutes(app);

  // Наблюдатель за ящиками узнаёт о новых письмах первым — ему и звать
  // рассылку уведомлений (см. ws.ts).
  notifier.attachPush(app.pushService);

  await wsRoutes(app, notifier);

  return { app, notifier };
}
