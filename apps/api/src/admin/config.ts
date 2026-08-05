/**
 * Конфигурация админки. Отдельная от src/config.ts схема, чтобы админка
 * оставалась самостоятельным модулем: почтовый API работает и без неё.
 *
 * Переменные окружения (все со значениями по умолчанию, кроме базы):
 *
 *   ADMIN_DATABASE_URL / DATABASE_URL  подключение к Postgres почтового стека.
 *                                      Без него админские маршруты отвечают 503.
 *   ADMIN_SESSION_COOKIE_NAME          имя cookie админской сессии (mt_admin)
 *   ADMIN_SESSION_TTL_SECONDS          срок жизни админской сессии (8 часов)
 *   ADMIN_LOGIN_MAX_FAILURES           неудач подряд до блокировки (5)
 *   ADMIN_LOCKOUT_MINUTES              на сколько блокировать (15)
 *   DOVECOT_MASTER_USER                служебный пользователь Dovecot
 *   DOVECOT_MASTER_PASSWORD            его пароль
 *   DOVECOT_MASTER_SEPARATOR           разделитель auth_master_user_separator (*)
 *   ADMIN_MAILBOX_TTL_SECONDS          срок жизни сеанса входа в чужой ящик (1 час)
 *   MAIL_DOMAIN / MAIL_HOSTNAME        для подсказок DNS
 *   MAIL_PUBLIC_IPV4                   ожидаемый адрес сервера (проверка PTR/A)
 *   RSPAMD_HOST / RSPAMD_CONTROLLER_PORT / RSPAMD_PASSWORD
 *                                      антиспам и проверка подписи исходящих
 *   RESOLVER_IP                        свой резольвер (unbound) для сводки
 */
import { z } from 'zod';

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const adminEnvSchema = z.object({
  ADMIN_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  ADMIN_SESSION_COOKIE_NAME: z.string().default('mt_admin'),
  ADMIN_SESSION_TTL_SECONDS: intVar(8 * 3600, 60),
  ADMIN_LOGIN_MAX_FAILURES: intVar(5, 1),
  ADMIN_LOCKOUT_MINUTES: intVar(15, 1),

  DOVECOT_MASTER_USER: z.string().default(''),
  DOVECOT_MASTER_PASSWORD: z.string().default(''),
  DOVECOT_MASTER_SEPARATOR: z.string().min(1).max(1).default('*'),
  ADMIN_MAILBOX_TTL_SECONDS: intVar(3600, 60),

  MAIL_DOMAIN: z.string().default('mail.local'),
  MAIL_HOSTNAME: z.string().default('mail.local'),
  MAIL_PUBLIC_IPV4: z.string().default(''),

  /**
   * Антиспам и свой резольвер — для сводки состояния. Ни то, ни другое
   * не мешает почте ходить при отказе, поэтому в пробу контейнера они не
   * входят; зато отказ каждого не виден больше нигде (см. admin/services.ts).
   * Пароль контроллера нужен только для проверки подписи исходящих:
   * без него проверяется лишь «жив ли rspamd».
   */
  RSPAMD_HOST: z.string().default('rspamd'),
  RSPAMD_CONTROLLER_PORT: intVar(11334, 1, 65535),
  RSPAMD_PASSWORD: z.string().default(''),
  RESOLVER_IP: z.string().default(''),

  /** Квота нового ящика по умолчанию, байт (1 ГиБ). */
  ADMIN_DEFAULT_QUOTA_BYTES: intVar(1024 * 1024 * 1024, 0),

  /**
   * Корень почтового хранилища — тот же, что у Dovecot
   * (mail_location = maildir:/var/mail/vhosts/%d/%n). Отсюда уборщик
   * забирает каталог удалённого ящика.
   */
  ADMIN_MAIL_ROOT: z.string().default('/var/mail/vhosts'),

  /**
   * Сколько каталог удалённого ящика лежит в карантине до физического
   * удаления. 0 — убрать при ближайшем проходе уборщика. Отсрочка нужна
   * только чтобы успеть передумать: доступа к почте она не возвращает,
   * каталог уже уведён из-под нового ящика с тем же адресом.
   */
  ADMIN_MAILBOX_PURGE_DELAY_MINUTES: intVar(0, 0, 43_200),

  /** Как часто просыпается уборщик. 0 — не запускать вовсе. */
  ADMIN_JANITOR_INTERVAL_SECONDS: intVar(60, 0, 86_400),

  /**
   * Чем шифруется результат импорта (сгенерированные пароли).
   * Своего секрета у админки нет — берём админский, иначе почтовый.
   * Пустой означает «паролей не храним»: лучше отдать только счётчики,
   * чем положить пароль в базу открытым.
   */
  ADMIN_SESSION_SECRET: z.string().default(''),
  SESSION_SECRET: z.string().default(''),
});

export type AdminEnv = z.infer<typeof adminEnvSchema>;

export interface AdminConfig extends AdminEnv {
  /** Итоговая строка подключения (ADMIN_DATABASE_URL важнее DATABASE_URL). */
  databaseUrl: string | null;
  /** Настроен ли служебный доступ Dovecot (иначе вход в ящик недоступен). */
  masterConfigured: boolean;
  /** Секрет для шифрования результата импорта; пустой — не шифруем и не храним. */
  importSecret: string;
}

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const parsed = adminEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация админки: ${details}`);
  }
  const data = parsed.data;
  const databaseUrl = data.ADMIN_DATABASE_URL || data.DATABASE_URL || null;
  return {
    ...data,
    databaseUrl,
    masterConfigured: data.DOVECOT_MASTER_USER !== '' && data.DOVECOT_MASTER_PASSWORD !== '',
    importSecret: data.ADMIN_SESSION_SECRET || data.SESSION_SECRET,
  };
}
