/**
 * Конфигурация помощника на основе ИИ из переменных окружения.
 *
 * Отдельная схема, как у админки: почтовый API обязан работать и без ИИ.
 * Ни адреса сервиса, ни модели здесь нет — это настройки администратора
 * домена и живут они в базе (см. миграцию 0004). В окружении лежит только
 * то, чему в базе места нет: ключ шифрования и параметры подключения
 * к самой базе.
 */
import { z } from 'zod';

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const boolFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const aiEnvSchema = z.object({
  /** Подключение к базе почтового стека. Без него ИИ выключен целиком. */
  AI_DATABASE_URL: z.string().optional(),
  ADMIN_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  /**
   * Ключ шифрования ключей доступа к сервисам ИИ.
   * Хранится ТОЛЬКО в окружении: см. apps/api/src/ai/secret.ts.
   * Без него можно работать с локальной моделью (ей ключ не нужен),
   * но нельзя сохранить ключ внешнего сервиса.
   */
  AI_ENCRYPTION_KEY: z.string().optional(),

  /**
   * Общий выключатель на весь сервер. Нужен на случай, когда ИИ надо
   * погасить немедленно, не заходя в админку и не трогая базу.
   */
  AI_ENABLED: boolFlag.default('true'),

  /** Сколько держать настройки домена в памяти, не перечитывая базу. */
  AI_SETTINGS_CACHE_MS: intVar(15_000, 0, 600_000),

  /** Префикс ключей ИИ в Redis: кэш результатов и учёт расходов. */
  AI_REDIS_PREFIX: z.string().default('mt:ai:'),
});

export type AiEnv = z.infer<typeof aiEnvSchema>;

export interface AiConfig extends AiEnv {
  /** Итоговая строка подключения (AI_DATABASE_URL важнее остальных). */
  databaseUrl: string | null;
}

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const parsed = aiEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация помощника ИИ: ${details}`);
  }
  const data = parsed.data;
  return {
    ...data,
    databaseUrl: data.AI_DATABASE_URL || data.ADMIN_DATABASE_URL || data.DATABASE_URL || null,
  };
}
