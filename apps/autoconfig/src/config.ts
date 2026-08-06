/**
 * Конфигурация сервиса автоопределения настроек (autoconfig/autodiscover).
 * Все параметры берутся из переменных окружения и валидируются zod-схемой
 * при старте; ничего не зашито в код.
 */
import 'dotenv/config';
import { z } from 'zod';

// Пустая строка приравнивается к «не задано», и это обязательная оговорка,
// а не вкусовщина. Значения приходят из docker compose, а он передаёт
// переменную ВСЕГДА: `PORT: ${AUTOCONFIG_IMAPS_PORT:-993}` при пустой
// строке в infra/.env даёт именно '', а не отсутствие ключа. Без preprocess
// z.coerce.number() превращает '' в 0, 0 не проходит min(1), и сервис
// автонастройки не стартует вовсе — из-за пустой строки в файле настроек.
const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(def),
  );

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

  /**
   * Анонсируемые клиентам порты — СТАНДАРТНЫЕ, а не порты публикации docker.
   *
   * Разница принципиальная, и из-за неё эти значения нельзя брать из
   * IMAPS_PORT/SUBMISSION_PORT файла infra/.env: там записано, на каком
   * порту ХОСТА опубликован сервис на машине разработчика (их меняют,
   * чтобы развести два стенда). На боевом сервере список портов задан
   * заново в install/compose.prod.yml и всегда стандартный. Взяв те
   * значения, автонастройка на сервере разослала бы клиентам порт
   * с чужой машины. Поэтому у compose для них отдельные имена
   * AUTOCONFIG_*_PORT (см. infra/.env.example).
   */
  IMAP_STARTTLS_PORT: intVar(143, 1, 65535),
  IMAPS_PORT: intVar(993, 1, 65535),
  POP3_STARTTLS_PORT: intVar(110, 1, 65535),
  POP3S_PORT: intVar(995, 1, 65535),
  SUBMISSION_PORT: intVar(587, 1, 65535),
  /** submissions — «TLS сразу», без STARTTLS. Его предпочитают Outlook и почта Apple. */
  SUBMISSIONS_PORT: intVar(465, 1, 65535),

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
  smtp: { startTlsPort: number; sslPort: number };
  dkimSelector: string;
  dkimDnsDir: string;
  dmarcRua: string;
  dnsTtl: number;
}

export function settingsFromEnv(env: AutoconfigEnv): MailSettings {
  // Пустая строка — это НЕ заданное значение, а не «имя провайдера пусто».
  // docker compose передаёт переменную всегда: ключа «не передавать, если
  // не задано» у него нет, и незаполненная строка в infra/.env приходит
  // сюда как ''. Без этой оговорки в мастере настройки Thunderbird
  // получался пустой <displayName>, а в DMARC — `rua=mailto:` без адреса.
  const orDefault = (value: string | undefined, fallback: string): string =>
    value !== undefined && value.trim() !== '' ? value.trim() : fallback;

  return {
    domain: env.MAIL_DOMAIN,
    hostname: env.MAIL_HOSTNAME,
    providerName: orDefault(env.PROVIDER_NAME, 'Mail.True'),
    providerShortName: orDefault(env.PROVIDER_SHORT_NAME, 'Mail.True'),
    imap: { sslPort: env.IMAPS_PORT, startTlsPort: env.IMAP_STARTTLS_PORT },
    pop3: { sslPort: env.POP3S_PORT, startTlsPort: env.POP3_STARTTLS_PORT },
    smtp: { startTlsPort: env.SUBMISSION_PORT, sslPort: env.SUBMISSIONS_PORT },
    dkimSelector: env.DKIM_SELECTOR,
    dkimDnsDir: env.DKIM_DNS_DIR,
    dmarcRua: orDefault(env.DMARC_RUA, `postmaster@${env.MAIL_DOMAIN}`),
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
