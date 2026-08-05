/**
 * Конфигурация сервиса автоопределения настроек (autoconfig/autodiscover).
 * Все параметры берутся из переменных окружения и валидируются zod-схемой
 * при старте; ничего не зашито в код.
 */
import 'dotenv/config';
import { z } from 'zod';

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** HTTP-сервер */
  HOST: z.string().default('127.0.0.1'),
  PORT: intVar(8080, 1, 65535),

  /** Основной почтовый домен (часть адреса после @) */
  MAIL_DOMAIN: z.string().default('mail.local'),
  /** Имя хоста, которое анонсируется клиентам как IMAP/POP3/SMTP-сервер */
  MAIL_HOSTNAME: z.string().default('mail.local'),

  /** Отображаемое имя провайдера в мастерах настройки */
  PROVIDER_NAME: z.string().default('Mail.True'),
  PROVIDER_SHORT_NAME: z.string().default('Mail.True'),

  /** Анонсируемые клиентам порты (стандартные, не порты публикации docker) */
  IMAP_STARTTLS_PORT: intVar(143, 1, 65535),
  IMAPS_PORT: intVar(993, 1, 65535),
  POP3_STARTTLS_PORT: intVar(110, 1, 65535),
  POP3S_PORT: intVar(995, 1, 65535),
  SUBMISSION_PORT: intVar(587, 1, 65535),

  /** DKIM: селектор и каталог с ключами rspamd (там лежит <домен>.<селектор>.dns.txt) */
  DKIM_SELECTOR: z.string().default('mail'),
  DKIM_DNS_DIR: z.string().default('/rspamd/dkim'),

  /** Адрес для отчётов DMARC (rua); по умолчанию postmaster@<домен> */
  DMARC_RUA: z.string().optional(),

  /** TTL, который проставляется в рекомендуемые DNS-записи */
  DNS_TTL: intVar(3600, 60),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type AutoconfigEnv = z.infer<typeof envSchema>;

/** Развёрнутые настройки почтовых сервисов, которые анонсируются клиентам. */
export interface MailSettings {
  /** Основной почтовый домен */
  domain: string;
  /** Хост IMAP/POP3/SMTP */
  hostname: string;
  providerName: string;
  providerShortName: string;
  imap: { sslPort: number; startTlsPort: number };
  pop3: { sslPort: number; startTlsPort: number };
  smtp: { startTlsPort: number };
  dkimSelector: string;
  dkimDnsDir: string;
  dmarcRua: string;
  dnsTtl: number;
}

export function settingsFromEnv(env: AutoconfigEnv): MailSettings {
  return {
    domain: env.MAIL_DOMAIN,
    hostname: env.MAIL_HOSTNAME,
    providerName: env.PROVIDER_NAME,
    providerShortName: env.PROVIDER_SHORT_NAME,
    imap: { sslPort: env.IMAPS_PORT, startTlsPort: env.IMAP_STARTTLS_PORT },
    pop3: { sslPort: env.POP3S_PORT, startTlsPort: env.POP3_STARTTLS_PORT },
    smtp: { startTlsPort: env.SUBMISSION_PORT },
    dkimSelector: env.DKIM_SELECTOR,
    dkimDnsDir: env.DKIM_DNS_DIR,
    dmarcRua: env.DMARC_RUA ?? `postmaster@${env.MAIL_DOMAIN}`,
    dnsTtl: env.DNS_TTL,
  };
}

export function loadConfig(): AutoconfigEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${details}`);
  }
  return parsed.data;
}
