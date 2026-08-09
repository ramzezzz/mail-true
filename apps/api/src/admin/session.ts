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
  /**
   * Закрывает ВСЕ сессии администратора. Возвращает, сколько закрыла.
   *
   * Нужно смене пароля — и до этого способа отозвать админскую сессию не
   * существовало вовсе. Пароль в проверке сессии не участвует нигде:
   * `loadAdminSession` перечитывает из базы только роль и активность, а
   * срок жизни скользящий — каждый запрос продлевает сессию сам. То есть
   * человек, уведший cookie владельца, сохранял настройки сервера,
   * перезапуск служб, выгрузку копии с хэшами всех паролей и вход в чужие
   * ящики ПОСЛЕ того, как пароль сменили. Смена пароля — единственное, что
   * есть у владельца против угнанной сессии, и она не делала ничего.
   */
  revokeByAdminId(adminId: number): Promise<number>;

  getMailbox(id: string): Promise<MailboxSessionData | null>;
  setMailbox(id: string, data: MailboxSessionData, ttlSeconds: number): Promise<void>;
  deleteMailbox(id: string): Promise<void>;
}

const ADMIN_PREFIX = 'mt:admin:sess:';
const MAILBOX_PREFIX = 'mt:admin:mbox:';
/**
 * Указатель «администратор → его сессии».
 *
 * Без него перечислить сессии администратора нечем: ключи именуются
 * идентификатором сессии, а поиск по значению в Redis — это перебор всей
 * базы. Устроен так же, как указатель почтовых сессий (mt:sess:by-email
 * в src/session.ts): держим множество идентификаторов и подчищаем его на
 * лету — в нём могут оставаться уже истёкшие, и это нормально.
 */
const ADMIN_INDEX = 'mt:admin:sess:by-admin:';

function indexKey(adminId: number): string {
  return ADMIN_INDEX + String(adminId);
}

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
    // Указатель живёт вдвое дольше самой сессии: лишний идентификатор в нём
    // безвреден (отзыв проверяет каждую сессию), а потерянный означал бы,
    // что сессию не отозвать.
    await this.redis.sadd(indexKey(data.adminId), id);
    await this.redis.expire(indexKey(data.adminId), ttlSeconds * 2);
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(ADMIN_PREFIX + id, ttlSeconds);
    /*
     * Указатель продлевается ВМЕСТЕ с сессией — ловушка та же, что у
     * почтовых сессий (см. разбор в src/session.ts).
     *
     * Срок у сессии скользящий: открытая панель опрашивает сервер сама и
     * держит сессию сколько угодно долго. Указатель, получивший срок
     * только при входе, истёк бы у живой сессии — и смена пароля нашла бы
     * пустое множество и честно отчиталась «закрыто сессий: 0», не закрыв
     * ту единственную, ради которой пароль и меняли.
     */
    const data = await this.get(id);
    if (!data) return;
    await this.redis.sadd(indexKey(data.adminId), id);
    await this.redis.expire(indexKey(data.adminId), ttlSeconds * 2);
  }

  async delete(id: string): Promise<void> {
    const data = await this.get(id);
    await this.redis.del(ADMIN_PREFIX + id);
    if (data) await this.redis.srem(indexKey(data.adminId), id);
  }

  async revokeByAdminId(adminId: number): Promise<number> {
    const key = indexKey(adminId);
    const ids = await this.redis.smembers(key);
    let closed = 0;
    for (const id of ids) {
      const removed = await this.redis.del(ADMIN_PREFIX + id);
      if (removed > 0) closed += 1;
      /*
       * Убираем ПОИМЁННО прочитанное, а не весь указатель разом: между
       * чтением множества и удалением администратор мог войти заново — он
       * это и делает ровно тогда, когда ему меняют пароль, — и такая
       * сессия выпала бы из указателя навсегда, став неотзываемой.
       */
      await this.redis.srem(key, id);
    }
    return closed;
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

  async revokeByAdminId(adminId: number): Promise<number> {
    let closed = 0;
    for (const [id, entry] of this.admin) {
      if (entry.data.adminId !== adminId) continue;
      // Истёкшая сессия никого уже не пускает — считать её закрытой
      // значило бы отчитаться человеку о работе, которой не было.
      if (entry.expiresAt <= Date.now()) {
        this.admin.delete(id);
        continue;
      }
      this.admin.delete(id);
      closed += 1;
    }
    return closed;
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
