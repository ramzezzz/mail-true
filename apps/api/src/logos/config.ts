/**
 * Настройки поиска логотипов из окружения.
 *
 * Своя схема, как у помощника ИИ и админки: почта обязана работать, даже
 * если этот раздел выключен целиком. Все значения по умолчанию подобраны
 * так, чтобы включённая опция не стоила заметных денег и времени.
 */
import { z } from 'zod';

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const boolFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const logoEnvSchema = z.object({
  /** Подключение к базе — там живёт кэш. Без базы кэш только в памяти. */
  SETTINGS_DATABASE_URL: z.string().optional(),
  ADMIN_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  /**
   * Общий выключатель на весь сервер. Нужен администратору, который решил,
   * что его сервер в интернет за картинками не ходит ВООБЩЕ, независимо от
   * того, что включили себе пользователи.
   */
  SENDER_LOGOS_ENABLED: boolFlag.default('true'),

  /** Имя нашего почтового узла: чьему Authentication-Results мы верим. */
  MAIL_HOSTNAME: z.string().default('mail.local'),

  /** Предел ожидания одного запроса DNS. */
  SENDER_LOGO_DNS_TIMEOUT_MS: intVar(2500, 200, 15_000),
  /** Предел ожидания одного обращения к чужому серверу по HTTPS. */
  SENDER_LOGO_HTTP_TIMEOUT_MS: intVar(4000, 500, 30_000),

  /**
   * Сколько времени ЗАПРОС ИНТЕРФЕЙСА ждёт ещё не найденные логотипы.
   *
   * Список писем логотипов не ждёт вовсе — они запрашиваются отдельно и
   * появляются, когда приедут. Но и этот отдельный запрос не должен висеть
   * минуту: домены, за которые не успели, отвечаются как «ещё ищем», и
   * интерфейс переспросит.
   */
  SENDER_LOGO_WAIT_MS: intVar(3500, 0, 20_000),

  /** Сколько поисков идёт наружу одновременно на весь сервер. */
  SENDER_LOGO_CONCURRENCY: intVar(4, 1, 32),

  /**
   * Сколько НОВЫХ доменов сервер соглашается искать за минуту.
   *
   * Ограничитель на весь сервер, а не на пользователя: наружу ходим мы, и
   * ограничивать надо наш собственный исходящий поток. Кэш общий, поэтому
   * второй пользователь того же домена платит ноль.
   */
  SENDER_LOGO_LOOKUPS_PER_MINUTE: intVar(60, 1, 10_000),

  /** Сколько держать НАЙДЕННЫЙ логотип, часы. */
  SENDER_LOGO_TTL_HOURS: intVar(30 * 24, 1),
  /**
   * Сколько держать ответ «логотипа нет», часы.
   *
   * Отдельно и намеренно долго. Домены в списке повторяются десятками раз,
   * и большинство из них логотипа не имеют вовсе; без запоминания ОТКАЗА
   * каждое открытие папки заново дёргало бы DNS и чужие сайты по всему
   * списку — то есть опция стоила бы дорого и не давала ничего.
   */
  SENDER_LOGO_MISS_TTL_HOURS: intVar(7 * 24, 1),
  /**
   * Сколько ждать после ошибки связи, часы.
   *
   * Коротко: «не дозвонились» — это не «логотипа нет». Чужой сервер мог
   * лежать десять минут, и наказывать домен неделей забвения не за что.
   */
  SENDER_LOGO_ERROR_TTL_HOURS: intVar(6, 1),
});

export type LogoEnv = z.infer<typeof logoEnvSchema>;

export interface LogoConfig extends LogoEnv {
  databaseUrl: string | null;
  /** Имя узла в нижнем регистре — с ним сравнивается authserv-id. */
  authservId: string;
}

export function loadLogoConfig(env: NodeJS.ProcessEnv = process.env): LogoConfig {
  const parsed = logoEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация логотипов отправителей: ${details}`);
  }
  const data = parsed.data;
  return {
    ...data,
    databaseUrl: data.SETTINGS_DATABASE_URL || data.ADMIN_DATABASE_URL || data.DATABASE_URL || null,
    authservId: data.MAIL_HOSTNAME.trim().toLowerCase(),
  };
}
