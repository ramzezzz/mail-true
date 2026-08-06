/**
 * Конфигурация сервера из переменных окружения.
 * Валидируется zod-схемой при старте; при ошибке процесс не запускается.
 */
import 'dotenv/config';
import { z } from 'zod';

/** Булево значение из строки окружения: 'true' | 'false' | '1' | '0'. */
const boolFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const DEV_SECRET = 'dev-only-secret-change-me-0123456789abcdef';

/**
 * Во сколько раз вырастает вложение в письме: base64 даёт 4/3, переносы строк
 * каждые 76 символов — ещё около 2.6%, плюс заголовки частей и текст письма.
 */
export const ENCODING_OVERHEAD = 1.4;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /** HTTP-сервер API */
    HOST: z.string().default('127.0.0.1'),
    PORT: intVar(3001, 1, 65535),

    /** Dovecot IMAP */
    IMAP_HOST: z.string().default('127.0.0.1'),
    IMAP_PORT: intVar(143, 1, 65535),
    IMAP_SECURE: boolFlag.default('false'),

    /**
     * Проверять TLS-сертификаты IMAP/SMTP. В dev-стеке сертификаты
     * самоподписанные, поэтому по умолчанию false; в production — включить.
     */
    TLS_REJECT_UNAUTHORIZED: boolFlag.default('false'),

    /** Postfix submission */
    SMTP_HOST: z.string().default('127.0.0.1'),
    SMTP_PORT: intVar(587, 1, 65535),
    SMTP_SECURE: boolFlag.default('false'),

    /**
     * Адреса обратных прокси, которым можно верить в части заголовка
     * X-Forwarded-For. Всё, что приходит не отсюда, считается непосредственным
     * клиентом, и подменить свой адрес такой клиент не может.
     *
     * По умолчанию — петля и внутренняя сеть стека, где стоит nginx.
     * Ставить сюда `true` или `0.0.0.0/0` нельзя: заголовок подставляет
     * сам клиент, и тогда ограничение частоты запросов обходится сменой
     * заголовка, а в журнал аудита пишется любой выдуманный адрес.
     */
    TRUSTED_PROXIES: z
      .string()
      .default('127.0.0.1,::1,172.28.0.0/16')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
    /** Postgres не обязателен: профиль аккаунта деградирует до значений по умолчанию. */
    DATABASE_URL: z.string().optional(),

    /** Хранилище сессий: redis (боевое) или memory (локальная отладка без Redis). */
    SESSION_STORE: z.enum(['redis', 'memory']).default('redis'),
    SESSION_TTL_SECONDS: intVar(7 * 24 * 3600, 60),
    SESSION_COOKIE_NAME: z.string().default('mt_session'),
    /** Секрет для подписи cookie и шифрования пароля в сессии (мин. 32 символа). */
    SESSION_SECRET: z.string().min(32).default(DEV_SECRET),
    COOKIE_SECURE: boolFlag.default('false'),

    /** Временное хранилище загруженных вложений */
    UPLOAD_DIR: z.string().default('./data/uploads'),
    /**
     * Заявленный предел загружаемого файла. Действующий предел — производная
     * ATTACHMENT_MAX_BYTES (см. ниже): вложение при кодировании растёт, и
     * принимать файл, который заведомо не пролезет в письмо, нельзя.
     */
    UPLOAD_MAX_BYTES: intVar(25 * 1024 * 1024, 1024),

    /**
     * Предел размера письма на почтовом сервере (`message_size_limit`
     * в Postfix). Должен совпадать с настройкой Postfix, иначе письмо
     * отклоняется уже после отправки, вместо понятного отказа до неё.
     */
    MESSAGE_MAX_BYTES: intVar(25 * 1024 * 1024, 1024),

    /**
     * Предел тела JSON-запроса для написания письма (`/api/messages/send`,
     * `/api/drafts`). Отдельно от общего предела: HTML письма со вставленными
     * картинками (data:-URI) законно бывает в разы больше обычного запроса.
     */
    COMPOSE_BODY_MAX_BYTES: intVar(12 * 1024 * 1024, 64 * 1024),

    /** Простой IMAP-соединения в пуле до закрытия, мс */
    IMAP_POOL_IDLE_MS: intVar(5 * 60 * 1000, 1000),

    /**
     * Проба состояния (см. src/health.ts).
     *
     * HEALTH_CACHE_MS — сколько живёт готовый результат. Пробу дёргает и
     * контейнер, и обратный прокси, и админка; без кэша каждое такое
     * обращение стучалось бы в Redis, Postgres и Dovecot.
     * HEALTH_PROBE_TIMEOUT_MS — предел ожидания ОДНОЙ проверки: зависшая
     * служба обязана дать отрицательный ответ, а не подвесить пробу.
     *
     * Три секунды, а не полторы, — намеренный запас. При лежащем Redis
     * клиент переподключается в цикле, каждая попытка разрешает имя, и
     * разрешение имён в этом же процессе начинает занимать сотни
     * миллисекунд (проверено на стенде: обычные 30 мс превращались
     * в 600–1500). С коротким пределом соседняя авария выглядела бы
     * отказом Dovecot — проба врала бы о том, что цело.
     * Проверка контейнера ждёт 5 с, так что запас укладывается.
     */
    HEALTH_CACHE_MS: intVar(2000, 0, 60_000),
    HEALTH_PROBE_TIMEOUT_MS: intVar(3000, 100, 30_000),

    RATE_LIMIT_MAX: intVar(300, 1),
    RATE_LIMIT_WINDOW_MS: intVar(60_000, 1000),

    /** Разрешённые Origin для CORS, через запятую */
    CORS_ORIGIN: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production' && cfg.SESSION_SECRET === DEV_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'В production необходимо задать собственный SESSION_SECRET',
      });
    }
  })
  .transform((cfg) => ({
    ...cfg,
    /**
     * Действующий предел вложения.
     *
     * `UPLOAD_MAX_BYTES` в точности равнялся пределу письма в Postfix
     * (26214400) — и это была ловушка: при кодировании base64 вложение растёт
     * примерно на 37%, поэтому файл больше ~19 МБ не уходил НИКОГДА, хотя
     * загрузка принималась. Пользователь ждал отправки, получал «почтовый
     * сервер недоступен» и терял письмо.
     *
     * Теперь предел загрузки выводится из предела письма с запасом на
     * кодирование и служебные части, и заявленное значение не может его
     * превысить.
     */
    ATTACHMENT_MAX_BYTES: Math.min(
      cfg.UPLOAD_MAX_BYTES,
      Math.floor(cfg.MESSAGE_MAX_BYTES / ENCODING_OVERHEAD),
    ),
  }));

export type AppConfig = z.infer<typeof envSchema>;

/** Загружает и валидирует конфигурацию (по умолчанию из process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация окружения: ${details}`);
  }
  return parsed.data;
}
