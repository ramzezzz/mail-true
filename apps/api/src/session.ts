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
  /**
   * Откуда пришли переключением между своими ящиками — и чем вернуться.
   *
   * Живёт В СЕССИИ, а не в таблице связей, и это главное в устройстве.
   * Раньше связывание ящика заводило связь В ОБЕ СТОРОНЫ: тот, кто
   * доказал пароль ЧУЖОГО ящика B, тем самым дарил владельцу B вход в
   * СВОЙ ящик A — с сохранённым паролем A и без спроса. Администратор,
   * заглянувший в ящик сотрудника (пароль от которого он сам и выдавал),
   * отдавал сотруднику ключ от своей почты; тот видел ящик в списке
   * связанных и входил одним нажатием.
   *
   * Право вернуться нужно ровно тому, кто переключился, и ровно в этом
   * сеансе — что сессия и выражает. Чужая учётная запись никаких прав
   * при этом не получает.
   */
  returnTo?: { email: string; passwordEnc: string };
}

export interface SessionStore {
  get(id: string): Promise<SessionData | null>;
  set(id: string, data: SessionData, ttlSeconds: number): Promise<void>;
  /** Продлевает срок жизни сессии. */
  touch(id: string, ttlSeconds: number): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Закрывает ВСЕ сессии ящика. Возвращает, сколько закрыла.
   *
   * Нужен смене пароля и блокировке ящика. До этого способа отозвать
   * сессию не существовало вовсе: сессия хранит пароль, каким он был при
   * входе, и продлевается на каждом запросе — то есть смена пароля,
   * единственное средство владельца против угнанной сессии, не делала
   * ничего. Уволенный сотрудник с открытой вкладкой точно так же
   * продолжал читать почту после блокировки: Dovecot отсеивает
   * заблокированных только при проверке пароля.
   */
  revokeByEmail(email: string): Promise<number>;
  /**
   * Сколько живых сессий у ящика.
   *
   * Нужно выходу: наблюдатель за ящиком держит своё соединение с паролем
   * и живёт до суток без единой вкладки — ради уведомлений. Гасить его
   * можно только тогда, когда ушёл последний: иначе выход на телефоне
   * лишал бы уведомлений человека, оставшегося в почте на рабочем
   * компьютере.
   */
  countByEmail(email: string): Promise<number>;
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
/**
 * Указатель «ящик → его сессии».
 *
 * Без него перечислить сессии ящика нечем: ключи именуются
 * идентификатором сессии, а поиск по значению в Redis — это перебор всей
 * базы. Держим множество идентификаторов и подчищаем его на лету: в нём
 * могут оставаться уже истёкшие, и это нормально — читатель их
 * пропускает.
 */
const EMAIL_INDEX = 'mt:sess:by-email:';

function indexKey(email: string): string {
  return EMAIL_INDEX + email.trim().toLowerCase();
}

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
    // Указатель живёт дольше самой сессии: лишний идентификатор в нём
    // безвреден (читатель проверяет каждую сессию), а потерянный означал
    // бы, что сессию не отозвать.
    await this.redis.sadd(indexKey(data.email), id);
    await this.redis.expire(indexKey(data.email), ttlSeconds * 2);
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(PREFIX + id, ttlSeconds);
    /*
     * Указатель продлевается ВМЕСТЕ с сессией.
     *
     * Сессия живёт скользящим сроком: браузер опрашивает сервер сам, и
     * открытая вкладка держит её сколько угодно долго без повторного
     * входа. А указатель получал срок только при входе — и через две
     * недели истекал у живой сессии. Дальше revokeByEmail находил пустое
     * множество и честно возвращал ноль: смена пароля, блокировка и
     * удаление ящика переставали закрывать доступ, ничем этого не
     * показывая.
     *
     * Стоит это дороже, чем кажется: чтение почты у такой сессии
     * отвалится (новый вход в Dovecot со старым паролем не пройдёт), а
     * вот выгрузка ящика идёт СЛУЖЕБНЫМ пользователем — то есть угнанная
     * сессия и после смены пароля могла заказать и скачать архив со всей
     * перепиской.
     */
    const data = await this.get(id);
    if (!data) return;
    await this.redis.sadd(indexKey(data.email), id);
    await this.redis.expire(indexKey(data.email), ttlSeconds * 2);
  }

  async delete(id: string): Promise<void> {
    const data = await this.get(id);
    await this.redis.del(PREFIX + id);
    if (data) await this.redis.srem(indexKey(data.email), id);
  }

  async revokeByEmail(email: string): Promise<number> {
    const key = indexKey(email);
    const ids = await this.redis.smembers(key);
    if (ids.length === 0) return 0;
    let closed = 0;
    for (const id of ids) {
      const removed = await this.redis.del(PREFIX + id);
      if (removed > 0) closed += 1;
      /*
       * Убираем ПОИМЁННО то, что прочитали, а не весь указатель разом.
       *
       * `del(key)` в конце сносил и те идентификаторы, что появились
       * между чтением множества и удалением, — а появиться они успевают:
       * человек входит заново ровно тогда, когда ему меняют пароль.
       * Такая сессия выпадала из указателя навсегда и становилась
       * неотзываемой: следующая попытка закрыть доступ её уже не видела.
       */
      await this.redis.srem(key, id);
    }
    return closed;
  }

  async countByEmail(email: string): Promise<number> {
    const ids = await this.redis.smembers(indexKey(email));
    if (ids.length === 0) return 0;
    let alive = 0;
    // Указатель может помнить и уже истёкшие: проверяем каждую.
    for (const id of ids) {
      const exists = await this.redis.exists(PREFIX + id);
      if (exists > 0) alive += 1;
      else await this.redis.srem(indexKey(email), id);
    }
    return alive;
  }

  async ping(): Promise<ProbeOutcome> {
    // Состояние клиента спрашивается ПЕРЕД командой. Пока соединения нет,
    // ioredis складывает команды в очередь и держит их до переподключения —
    // проба висела бы вместо того, чтобы честно покраснеть.
    const status = this.redis.status;
    if (status !== 'ready') {
      return {
        ok: false,
        detail: `Соединение с Redis в состоянии «${status}» — сессии недоступны`,
      };
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

  async revokeByEmail(email: string): Promise<number> {
    this.sweep();
    const wanted = email.trim().toLowerCase();
    let closed = 0;
    for (const [id, entry] of this.map) {
      if (entry.data.email.trim().toLowerCase() !== wanted) continue;
      this.map.delete(id);
      closed += 1;
    }
    return closed;
  }

  async countByEmail(email: string): Promise<number> {
    this.sweep();
    const wanted = email.trim().toLowerCase();
    let alive = 0;
    for (const entry of this.map.values()) {
      if (entry.data.email.trim().toLowerCase() === wanted) alive += 1;
    }
    return alive;
  }

  async ping(): Promise<ProbeOutcome> {
    return { ok: true, detail: 'Сессии в памяти процесса (SESSION_STORE=memory)' };
  }
}
