/**
 * Админские сессии.
 *
 * Полностью независимы от почтовых: своё имя cookie (mt_admin), свой префикс
 * ключей в Redis, свой срок жизни. Почтовая сессия не даёт никаких прав
 * в админке, админская — никаких прав в почте. Это требование
 * docs/admin-spec.md («разные точки входа и разные сеансы»).
 */
import type { Redis } from 'ioredis';

/** Данные админской сессии. Пароль администратора нигде не хранится. */
export interface AdminSessionData {
  adminId: number;
  login: string;
  role: string;
  createdAt: number;
  ip: string | null;
}

/** Сеанс входа администратора в чужой ящик (отдельно от админской сессии). */
export interface MailboxSessionData {
  adminId: number;
  adminLogin: string;
  mailboxEmail: string;
  reason: string;
  /** id строки admin_mailbox_access — по нему закрываем сеанс. */
  accessId: number;
  createdAt: number;
  /** Всегда true: в этом режиме отправка писем запрещена. */
  readOnly: true;
}

export interface AdminSessionStore {
  get(id: string): Promise<AdminSessionData | null>;
  set(id: string, data: AdminSessionData, ttlSeconds: number): Promise<void>;
  touch(id: string, ttlSeconds: number): Promise<void>;
  delete(id: string): Promise<void>;

  getMailbox(id: string): Promise<MailboxSessionData | null>;
  setMailbox(id: string, data: MailboxSessionData, ttlSeconds: number): Promise<void>;
  deleteMailbox(id: string): Promise<void>;
}

const ADMIN_PREFIX = 'mt:admin:sess:';
const MAILBOX_PREFIX = 'mt:admin:mbox:';

export class RedisAdminSessionStore implements AdminSessionStore {
  constructor(private readonly redis: Redis) {}

  private async read<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  get(id: string): Promise<AdminSessionData | null> {
    return this.read<AdminSessionData>(ADMIN_PREFIX + id);
  }

  async set(id: string, data: AdminSessionData, ttlSeconds: number): Promise<void> {
    await this.redis.set(ADMIN_PREFIX + id, JSON.stringify(data), 'EX', ttlSeconds);
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(ADMIN_PREFIX + id, ttlSeconds);
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(ADMIN_PREFIX + id);
  }

  getMailbox(id: string): Promise<MailboxSessionData | null> {
    return this.read<MailboxSessionData>(MAILBOX_PREFIX + id);
  }

  async setMailbox(id: string, data: MailboxSessionData, ttlSeconds: number): Promise<void> {
    await this.redis.set(MAILBOX_PREFIX + id, JSON.stringify(data), 'EX', ttlSeconds);
  }

  async deleteMailbox(id: string): Promise<void> {
    await this.redis.del(MAILBOX_PREFIX + id);
  }
}

interface Entry<T> {
  data: T;
  expiresAt: number;
}

/** Хранилище в памяти процесса — для отладки без Redis. */
export class MemoryAdminSessionStore implements AdminSessionStore {
  private readonly admin = new Map<string, Entry<AdminSessionData>>();
  private readonly mailbox = new Map<string, Entry<MailboxSessionData>>();

  private static pick<T>(map: Map<string, Entry<T>>, id: string): T | null {
    const entry = map.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      map.delete(id);
      return null;
    }
    return entry.data;
  }

  async get(id: string): Promise<AdminSessionData | null> {
    return MemoryAdminSessionStore.pick(this.admin, id);
  }

  async set(id: string, data: AdminSessionData, ttlSeconds: number): Promise<void> {
    this.admin.set(id, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    const entry = this.admin.get(id);
    if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  async delete(id: string): Promise<void> {
    this.admin.delete(id);
  }

  async getMailbox(id: string): Promise<MailboxSessionData | null> {
    return MemoryAdminSessionStore.pick(this.mailbox, id);
  }

  async setMailbox(id: string, data: MailboxSessionData, ttlSeconds: number): Promise<void> {
    this.mailbox.set(id, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async deleteMailbox(id: string): Promise<void> {
    this.mailbox.delete(id);
  }
}
