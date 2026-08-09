/**
 * Отзыв админских сессий: смена пароля обязана выгонять того, кто уже вошёл.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Отозвать админскую сессию было нечем В ПРИНЦИПЕ. Ключ в Redis именуется
 * идентификатором сессии, указателя «администратор → его сессии» не было,
 * а пароль в проверке сессии не участвует нигде: `loadAdminSession`
 * перечитывает из базы только роль и активность. Срок жизни при этом
 * скользящий — каждый запрос продлевает сессию сам.
 *
 * Итог: тот, кто увёл cookie владельца, сохранял настройки сервера,
 * перезапуск служб, выгрузку копии с хэшами всех паролей и вход в чужие
 * ящики ПОСЛЕ того, как пароль сменили. Смена пароля — единственное, что
 * есть против угнанной сессии, — не делала ничего.
 *
 * ------------------------------------------------------------------
 * ПРО ВТОРУЮ ПРОВЕРКУ: УКАЗАТЕЛЬ ОБЯЗАН ЖИТЬ ДОЛЬШЕ СЕССИИ
 * ------------------------------------------------------------------
 * Ловушка, уже стоившая нам того же дефекта в почтовых сессиях (см.
 * src/session.ts): указатель, получающий срок только при входе, истекает
 * у ЖИВОЙ сессии — она-то продлевается каждым запросом. Дальше отзыв
 * находит пустое множество и честно отвечает «закрыто: 0», ничем не
 * показывая, что не закрыл ничего. Поэтому указатель продлевается вместе
 * с сессией, и здесь это проверяется на часах.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';
import { MemoryAdminSessionStore, RedisAdminSessionStore } from './session.js';

/* ------------------------------------------------------------------ */
/* Redis, которого нет: ровно те команды, что нужны хранилищу           */
/* ------------------------------------------------------------------ */

interface Entry {
  value: string | Set<string>;
  /** Абсолютное время истечения по часам подделки; null — вечно. */
  expiresAt: number | null;
}

/**
 * Подделка Redis со СВОИМИ часами.
 *
 * Часы ручные, потому что проверяется срок жизни указателя: настоящие
 * заставили бы проверку ждать часами, а `expire` в Redis — это не таймер,
 * а отметка времени, и подделать её честнее, чем спать.
 */
class FakeRedis {
  private readonly data = new Map<string, Entry>();
  now = 0;

  private live(key: string): Entry | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.data.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.live(key);
    return entry && typeof entry.value === 'string' ? entry.value : null;
  }

  async set(key: string, value: string, _mode: 'EX', ttl: number): Promise<'OK'> {
    this.data.set(key, { value, expiresAt: this.now + ttl });
    return 'OK';
  }

  async expire(key: string, ttl: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = this.now + ttl;
    return 1;
  }

  async del(key: string): Promise<number> {
    const existed = this.live(key) !== null;
    this.data.delete(key);
    return existed ? 1 : 0;
  }

  async sadd(key: string, member: string): Promise<number> {
    const entry = this.live(key);
    if (entry && entry.value instanceof Set) {
      const had = entry.value.has(member);
      entry.value.add(member);
      return had ? 0 : 1;
    }
    this.data.set(key, { value: new Set([member]), expiresAt: null });
    return 1;
  }

  async srem(key: string, member: string): Promise<number> {
    const entry = this.live(key);
    if (!entry || !(entry.value instanceof Set)) return 0;
    return entry.value.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.live(key);
    return entry && entry.value instanceof Set ? [...entry.value] : [];
  }
}

function redisStore(): { store: RedisAdminSessionStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { store: new RedisAdminSessionStore(redis as unknown as Redis), redis };
}

const sessionOf = (adminId: number, login: string) => ({
  adminId,
  login,
  role: 'owner',
  createdAt: 0,
  ip: null,
});

const TTL = 3600;

/* ------------------------------------------------------------------ */

void test('смена пароля закрывает все сессии администратора — и только его', async () => {
  const { store } = redisStore();
  await store.set('a1', sessionOf(1, 'vladelec'), TTL);
  await store.set('a2', sessionOf(1, 'vladelec'), TTL);
  await store.set('b1', sessionOf(2, 'sosed'), TTL);

  assert.equal(await store.revokeByAdminId(1), 2);

  assert.equal(await store.get('a1'), null, 'угнанная сессия обязана перестать пускать');
  assert.equal(await store.get('a2'), null);
  assert.notEqual(await store.get('b1'), null, 'сосед пароль не менял — выгонять его не за что');
});

void test('указатель живёт, пока живёт сессия: сутки работы не делают её неотзываемой', async () => {
  const { store, redis } = redisStore();
  await store.set('a1', sessionOf(1, 'vladelec'), TTL);

  /*
   * Открытая панель опрашивает сервер сама, и каждый запрос продлевает
   * сессию. Проматываем два часа такой работы: без продления указателя он
   * истёк бы (срок у него — вдвое больше сессии, то есть два часа), и
   * дальше сессия жила бы вечно, не числясь ничьей.
   */
  redis.now += 3000;
  await store.touch('a1', TTL);
  redis.now += 3000;
  await store.touch('a1', TTL);
  redis.now += 2000;

  assert.notEqual(await store.get('a1'), null, 'сессия продлевалась и обязана быть жива');
  assert.equal(await store.revokeByAdminId(1), 1, 'её обязано быть видно указателю');
  assert.equal(await store.get('a1'), null);
});

void test('истёкшая сессия в указателе не превращается в отчёт о закрытии', async () => {
  const { store, redis } = redisStore();
  await store.set('a1', sessionOf(1, 'vladelec'), TTL);
  // Никто не работал: сессия истекла сама, указатель ещё помнит её.
  redis.now += TTL + 1;

  assert.equal(
    await store.revokeByAdminId(1),
    0,
    'закрывать было нечего — говорить обратное значит успокоить зря',
  );
});

void test('выход из панели убирает сессию и из указателя', async () => {
  const { store } = redisStore();
  await store.set('a1', sessionOf(1, 'vladelec'), TTL);
  await store.delete('a1');
  assert.equal(await store.revokeByAdminId(1), 0);
});

void test('хранилище в памяти отзывает так же, как Redis', async () => {
  const store = new MemoryAdminSessionStore();
  await store.set('a1', sessionOf(1, 'vladelec'), TTL);
  await store.set('a2', sessionOf(1, 'vladelec'), TTL);
  await store.set('b1', sessionOf(2, 'sosed'), TTL);

  assert.equal(await store.revokeByAdminId(1), 2);
  assert.equal(await store.get('a1'), null);
  assert.notEqual(await store.get('b1'), null);
});
