/**
 * Конфигурация раздела настроек и правил фильтрации.
 *
 * Отдельная схема, как у админки и помощника ИИ: почтовый API обязан
 * работать и без базы — просто без настроек и фильтров. В окружении
 * лежит только то, чему в базе места нет: подключение к самой базе и
 * способ добраться до почтового хранилища Dovecot.
 */
import { z } from 'zod';
import type { SieveTransport } from './store.js';

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const settingsEnvSchema = z.object({
  /** Подключение к базе почтового стека. Без него настройки недоступны. */
  SETTINGS_DATABASE_URL: z.string().optional(),
  ADMIN_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  /**
   * Как API добирается до почтового хранилища, чтобы положить туда
   * личный файл правил:
   *   local  — каталог хранилища виден процессу API (боевой Ubuntu);
   *   docker — хранилище внутри контейнера Dovecot (dev-стек);
   *   off    — не класть никуда (правила остаются только в базе).
   */
  SIEVE_TRANSPORT: z.enum(['local', 'docker', 'off']).default('docker'),
  /** Корень почтового хранилища (%d/%n внутри него). */
  SIEVE_ROOT: z.string().default('/var/mail/vhosts'),
  /** Имя контейнера Dovecot для транспорта docker. */
  SIEVE_DOCKER_CONTAINER: z.string().default('mail-dovecot'),
  /** Имя файла скрипта в каталоге sieve/ (без расширения). */
  SIEVE_SCRIPT_NAME: z.string().default('mailtrue'),
  /** Владелец файлов в хранилище: под этим пользователем работает LMTP. */
  SIEVE_OWNER: z.string().default('vmail:vmail'),

  /** Сколько писем максимум перебирать при применении правила к старой почте. */
  FILTER_APPLY_MAX_MESSAGES: intVar(5000, 1, 100_000),
});

export type SettingsEnv = z.infer<typeof settingsEnvSchema>;

export interface SettingsConfig extends SettingsEnv {
  /** Итоговая строка подключения (SETTINGS_DATABASE_URL важнее остальных). */
  databaseUrl: string | null;
  transport: SieveTransport;
}

export function loadSettingsConfig(env: NodeJS.ProcessEnv = process.env): SettingsConfig {
  const parsed = settingsEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация настроек ящика: ${details}`);
  }
  const data = parsed.data;
  return {
    ...data,
    databaseUrl:
      data.SETTINGS_DATABASE_URL || data.ADMIN_DATABASE_URL || data.DATABASE_URL || null,
    transport: data.SIEVE_TRANSPORT,
  };
}
