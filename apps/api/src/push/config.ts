/**
 * Конфигурация уведомлений о новой почте.
 *
 * В окружении лежит только то, чему в базе места нет: подключение к самой
 * базе и контакт администратора для службы доставки. Ключи VAPID сервер
 * создаёт себе сам и хранит в базе — см. пояснение в миграции 0012.
 */
import { z } from 'zod';

const boolFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const pushEnvSchema = z.object({
  /**
   * Общий рубильник. Выключенный означает: подписки не выдаются,
   * уведомления при закрытой вкладке не работают, и интерфейс об этом
   * честно говорит. Уведомления при ОТКРЫТОЙ вкладке продолжают работать
   * и здесь — они не выходят за пределы машины и рубильника не требуют.
   */
  PUSH_ENABLED: boolFlag.default('true'),

  /** Подключение к базе почтового стека. Без него нет ни подписок, ни настроек. */
  PUSH_DATABASE_URL: z.string().optional(),
  SETTINGS_DATABASE_URL: z.string().optional(),
  ADMIN_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  /**
   * Ключи VAPID. Обычно не задаются: сервер создаёт пару сам при первом
   * запуске. Здесь они нужны тому, кто переносит установку вместе с уже
   * выданными подписками — сменить ключ значит обесценить их все.
   */
  PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
  PUSH_VAPID_PRIVATE_KEY: z.string().optional(),

  /**
   * Контакт администратора для службы доставки (RFC 8292 §2.1): mailto:
   * или https://. К нему обращаются, когда с нашего сервера идёт что-то
   * не то. Пустое значение допускают не все службы, поэтому подставляем
   * postmaster@ почтового домена.
   */
  PUSH_CONTACT: z.string().optional(),
  MAIL_DOMAIN: z.string().default('mail.local'),

  /** Предел ожидания ответа службы доставки. */
  PUSH_TIMEOUT_MS: intVar(10_000, 500, 60_000),
  /**
   * Сколько служба доставки хранит недоставленное сообщение.
   * Сутки: письмо, о котором узнали через двое суток, — не новость.
   */
  PUSH_TTL_SECONDS: intVar(24 * 3600, 0, 30 * 24 * 3600),

  /**
   * Сколько уведомлений держим в очереди на ящик, пока их не показали.
   * Больше не нужно: в окне всё равно будет «и ещё N писем», а число N
   * считается по этой очереди.
   */
  PUSH_PENDING_MAX: intVar(50, 1, 500),
  /** Сколько ждёт неувиденное уведомление, прежде чем перестать быть новостью. */
  PUSH_PENDING_TTL_MS: intVar(6 * 3600_000, 60_000, 7 * 24 * 3600_000),
});

export type PushEnv = z.infer<typeof pushEnvSchema>;

export interface PushConfig extends PushEnv {
  databaseUrl: string | null;
  /** Контакт в готовом виде — то, что уходит в поле `sub` токена VAPID. */
  contact: string;
}

export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  const parsed = pushEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация уведомлений: ${details}`);
  }
  const data = parsed.data;
  const contact = (data.PUSH_CONTACT ?? '').trim();
  return {
    ...data,
    databaseUrl:
      data.PUSH_DATABASE_URL ||
      data.SETTINGS_DATABASE_URL ||
      data.ADMIN_DATABASE_URL ||
      data.DATABASE_URL ||
      null,
    contact:
      contact === ''
        ? `mailto:postmaster@${data.MAIL_DOMAIN}`
        : // Голый адрес без схемы службы доставки не принимают
          /^(mailto:|https?:)/u.test(contact)
          ? contact
          : `mailto:${contact}`,
  };
}
