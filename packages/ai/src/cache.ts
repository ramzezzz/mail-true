/**
 * Кэш результатов помощника.
 *
 * Зачем: не платить дважды за одно и то же и — что важнее — не отправлять
 * наружу одно и то же письмо повторно. Ключ включает версию запроса,
 * поэтому изменение формулировки автоматически обесценивает старые записи.
 *
 * Хранилище абстрактно: в памяти или в Redis.
 */

import { createHash } from 'node:crypto';
import type { AiFeature } from './types.js';

export interface AiCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Удаляет все записи по письму — нужно для требования «как отключить
   * и удалить уже созданные резюме и метки».
   */
  deleteByMessage(messageId: string): Promise<number>;
}

export interface CacheKeyParts {
  feature: AiFeature;
  /** Версия формулировки запроса. Меняется вместе с текстом запроса. */
  promptVersion: string;
  model: string;
  /** Идентификатор письма или цепочки; для запросов без письма — null. */
  messageId: string | null;
  /** Всё, что влияет на результат: тон, язык, режим правки и т. п. */
  variant?: Record<string, unknown>;
  /**
   * Отпечаток отправляемого текста. Защищает от устаревшего кэша,
   * если письмо перечитали и текст изменился.
   */
  contentFingerprint: string;
}

/** Устойчивый отпечаток содержимого. */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** Собирает ключ кэша. Идентификатор письма входит в ключ явно — по нему чистим. */
export function buildCacheKey(parts: CacheKeyParts): string {
  const variant =
    parts.variant && Object.keys(parts.variant).length > 0
      ? fingerprint(JSON.stringify(sortKeys(parts.variant)))
      : 'default';
  const message = parts.messageId ?? '-';
  return [
    'ai',
    parts.feature,
    parts.promptVersion,
    fingerprint(parts.model),
    encodeURIComponent(message),
    variant,
    parts.contentFingerprint,
  ].join(':');
}

/** Префикс всех ключей одного письма — для удаления. */
export function messageKeyMarker(messageId: string): string {
  return `:${encodeURIComponent(messageId)}:`;
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

interface Entry {
  value: string;
  expiresAt: number;
}

/** Кэш в памяти процесса. Подходит для одного узла и для тестов. */
export class MemoryAiCache implements AiCacheStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(options?: { now?: () => number; maxEntries?: number }) {
    this.#now = options?.now ?? (() => Date.now());
    this.#maxEntries = options?.maxEntries ?? 5000;
  }

  get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }

  deleteByMessage(messageId: string): Promise<number> {
    const marker = messageKeyMarker(messageId);
    let removed = 0;
    for (const key of [...this.#entries.keys()]) {
      if (key.includes(marker)) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Минимальная часть клиента Redis, нужная кэшу. */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
}

/**
 * Кэш в Redis. Клиент передаётся снаружи: пакет не создаёт соединений
 * и не знает адреса Redis.
 */
export class RedisAiCache implements AiCacheStore {
  readonly #redis: RedisCacheClient;
  readonly #prefix: string;

  constructor(redis: RedisCacheClient, options?: { prefix?: string }) {
    this.#redis = redis;
    this.#prefix = options?.prefix ?? '';
  }

  #key(key: string): string {
    return `${this.#prefix}${key}`;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.#redis.get(this.#key(key));
    } catch {
      // Недоступный кэш — не повод ломать работу: считаем, что записи нет.
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.#redis.set(this.#key(key), value, 'EX', ttlSeconds);
    } catch {
      // см. выше
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#redis.del(this.#key(key));
    } catch {
      // см. выше
    }
  }

  async deleteByMessage(messageId: string): Promise<number> {
    const pattern = `${this.#prefix}ai:*${messageKeyMarker(messageId)}*`;
    let cursor = '0';
    let removed = 0;
    try {
      do {
        const [next, keys] = await this.#redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          await this.#redis.del(...keys);
          removed += keys.length;
        }
      } while (cursor !== '0');
    } catch {
      return removed;
    }
    return removed;
  }
}

/** Заглушка: кэш выключен. */
export class NoopAiCache implements AiCacheStore {
  get(): Promise<string | null> {
    return Promise.resolve(null);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  deleteByMessage(): Promise<number> {
    return Promise.resolve(0);
  }
}
