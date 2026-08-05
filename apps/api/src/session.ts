/**
 * Сессии пользователей: httpOnly-cookie на клиенте, данные — в Redis
 * (или в памяти процесса для локальной отладки без Redis).
 */
import type { Redis } from 'ioredis';

export interface SessionData {
  email: string;
  /** Пароль, зашифрованный SecretBox (нужен для IMAP/SMTP-подключений). */
  passwordEnc: string;
  createdAt: number;
}

export interface SessionStore {
  get(id: string): Promise<SessionData | null>;
  set(id: string, data: SessionData, ttlSeconds: number): Promise<void>;
  /** Продлевает срок жизни сессии. */
  touch(id: string, ttlSeconds: number): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Отвечает ли хранилище. Нужна пробе состояния: без хранилища сессий
   * ни один вошедший пользователь не сделает ни одного запроса.
   * Проверка идёт по УЖЕ ОТКРЫТОМУ соединению — своего не заводит.
   */
  ping(): Promise<ProbeOutcome>;
}

/** Ответ хранилища пробе: жив ли и что сказать человеку. */
export interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

const PREFIX = 'mt:sess:';

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async get(id: string): Promise<SessionData | null> {
    const raw = await this.redis.get(PREFIX + id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  async set(id: string, data: SessionData, ttlSeconds: number): Promise<void> {
    await this.redis.set(PREFIX + id, JSON.stringify(data), 'EX', ttlSeconds);
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(PREFIX + id, ttlSeconds);
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(PREFIX + id);
  }

  async ping(): Promise<ProbeOutcome> {
    // Состояние клиента спрашивается ПЕРЕД командой. Пока соединения нет,
    // ioredis складывает команды в очередь и держит их до переподключения —
    // проба висела бы вместо того, чтобы честно покраснеть.
    const status = this.redis.status;
    if (status !== 'ready') {
      return { ok: false, detail: `Соединение с Redis в состоянии «${status}» — сессии недоступны` };
    }
    const answer = await this.redis.ping();
    return answer === 'PONG'
      ? { ok: true, detail: 'Отвечает; сессии читаются и продлеваются' }
      : { ok: false, detail: `Redis ответил «${answer}» вместо PONG` };
  }
}

interface MemoryEntry {
  data: SessionData;
  expiresAt: number;
}

/** Хранилище в памяти процесса — только для разработки и тестов. */
export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, MemoryEntry>();

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(id);
    }
  }

  async get(id: string): Promise<SessionData | null> {
    this.sweep();
    const entry = this.map.get(id);
    return entry && entry.expiresAt > Date.now() ? entry.data : null;
  }

  async set(id: string, data: SessionData, ttlSeconds: number): Promise<void> {
    this.sweep();
    this.map.set(id, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    const entry = this.map.get(id);
    if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }

  async ping(): Promise<ProbeOutcome> {
    return { ok: true, detail: 'Сессии в памяти процесса (SESSION_STORE=memory)' };
  }
}
