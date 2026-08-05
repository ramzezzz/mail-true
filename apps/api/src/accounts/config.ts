/**
 * Конфигурация подключения чужих ящиков и связывания своих.
 *
 * Отдельная схема, как у админки, помощника ИИ и настроек: почтовый API
 * обязан работать и без этого модуля. В окружении лежит только то, чему
 * в базе места нет: ключ шифрования паролей, доступ к базе и параметры
 * служебного входа в свой ящик (сборщик работает без сессии владельца).
 */
import { z } from 'zod';

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const boolFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const accountsEnvSchema = z.object({
  /** Подключение к базе почтового стека. Без него модуль выключен. */
  ACCOUNTS_DATABASE_URL: z.string().optional(),
  SETTINGS_DATABASE_URL: z.string().optional(),
  ADMIN_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  /**
   * Ключ шифрования паролей чужих ящиков (см. accounts/secret.ts).
   * Хранится ТОЛЬКО в окружении. Без него подключить внешний ящик
   * и связать свои ящики нельзя — открытым текстом пароли не храним.
   */
  EXTERNAL_ACCOUNTS_KEY: z.string().optional(),

  /** Общий выключатель модуля на весь сервер. */
  EXTERNAL_ACCOUNTS_ENABLED: boolFlag.default('true'),

  /**
   * Служебный пользователь Dovecot: сборщик кладёт письма в наш ящик,
   * не зная пароля владельца (владелец в этот момент может спать).
   * Те же переменные, что у админки, — второй копии заводить незачем.
   */
  DOVECOT_MASTER_USER: z.string().default(''),
  DOVECOT_MASTER_PASSWORD: z.string().default(''),
  DOVECOT_MASTER_SEPARATOR: z.string().min(1).max(1).default('*'),

  /** Как часто планировщик проверяет, кому пора забирать почту, мс. */
  COLLECTOR_TICK_MS: intVar(60_000, 5_000, 3_600_000),
  /** Сколько сборов выполнять одновременно. */
  COLLECTOR_CONCURRENCY: intVar(2, 1, 16),
  /** Сколько писем максимум за один запуск сборщика. */
  COLLECTOR_BATCH_SIZE: intVar(50, 1, 1000),
  /** Планировщик включён (в тестах и на репликах — выключить). */
  COLLECTOR_SCHEDULER: boolFlag.default('true'),

  /** Наши собственные домены (через запятую) — для автоопределения настроек. */
  MAIL_DOMAIN: z.string().default('mail.local'),
  MAIL_HOSTNAME: z.string().default('mail.local'),
  IMAPS_PORT: intVar(993, 1, 65535),
  SUBMISSION_PORT: intVar(587, 1, 65535),
  PROVIDER_NAME: z.string().default('Mail.True'),

  /** Ходить ли в сеть при автоопределении настроек (HTTP/DNS). */
  AUTODETECT_NETWORK: boolFlag.default('true'),
  AUTODETECT_TIMEOUT_MS: intVar(4000, 200, 30_000),
});

export type AccountsEnv = z.infer<typeof accountsEnvSchema>;

export interface AccountsConfig extends AccountsEnv {
  databaseUrl: string | null;
  /** Настроен ли служебный вход Dovecot (иначе сборщик работать не сможет). */
  masterConfigured: boolean;
}

export function loadAccountsConfig(env: NodeJS.ProcessEnv = process.env): AccountsConfig {
  const parsed = accountsEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация внешних ящиков: ${details}`);
  }
  const data = parsed.data;
  return {
    ...data,
    databaseUrl:
      data.ACCOUNTS_DATABASE_URL ||
      data.SETTINGS_DATABASE_URL ||
      data.ADMIN_DATABASE_URL ||
      data.DATABASE_URL ||
      null,
    masterConfigured: data.DOVECOT_MASTER_USER !== '' && data.DOVECOT_MASTER_PASSWORD !== '',
  };
}
