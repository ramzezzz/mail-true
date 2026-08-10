/**
 * Смена пароля администратора обязана выгонять того, кто вошёл по старому.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * `set-password` в консольной утилите делала ровно один шаг —
 * `UPDATE admin_users SET password_hash = …` — и на этом считала работу
 * выполненной. Её же зовёт install/reset-admin-password.sh, штатный
 * способ «вернуть контроль», когда на сервере уже кто-то есть.
 *
 * Контроль не возвращался. Админская сессия живёт ключом в Redis и о
 * пароле не знает ничего: проверка перечитывает из базы только роль и
 * активность, а срок жизни скользящий — злоумышленник продлевает сессию
 * сам каждым запросом. То есть после «сброса пароля» человек с уведённой
 * cookie в роли владельца по-прежнему правил настройки сервера,
 * перезапускал службы, заказывал резервную копию с хэшами паролей всех
 * ящиков и входил в чужую почту.
 *
 * Здесь проверяется, что смена пароля и отзыв сессий — одно действие, а
 * не два, о втором из которых можно забыть.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { changeAdminPassword } from './admin-password.js';
import type { AdminDb, AdminUserRow } from './db.js';
import { verifyAdminPassword } from './passwords.js';
import { MemoryAdminSessionStore, type AdminSessionStore } from './session.js';

const TTL = 8 * 3600;

/** База с одним администратором; запоминает, что ей записали. */
function fakeDb(): {
  db: AdminDb;
  written: () => string | null;
  clearedLocks: () => string[];
} {
  let hash: string | null = null;
  const cleared: string[] = [];
  const db = {
    findAdminByLogin: async (login: string): Promise<AdminUserRow | null> =>
      login === 'vladelec'
        ? ({ id: 42, login: 'vladelec', role: 'owner', active: true } as AdminUserRow)
        : null,
    query: async (_text: string, values: unknown[] = []): Promise<never[]> => {
      hash = String(values[1] ?? '');
      return [];
    },
    clearAdminLoginFailures: async (login: string): Promise<number> => {
      cleared.push(login);
      return 1;
    },
  } as unknown as AdminDb;
  return { db, written: () => hash, clearedLocks: () => cleared };
}

const sessionOf = (adminId: number) => ({
  adminId,
  login: 'vladelec',
  role: 'owner',
  createdAt: 0,
  ip: null,
});

void test('смена пароля закрывает открытые сессии панели', async () => {
  const { db, written } = fakeDb();
  const sessions = new MemoryAdminSessionStore();
  // Две вкладки владельца — и одна из них у того, кто увёл cookie.
  await sessions.set('svoya', sessionOf(42), TTL);
  await sessions.set('ugnannaya', sessionOf(42), TTL);

  const result = await changeAdminPassword({ db, sessions }, 'vladelec', 'novyy-parol-1234');

  assert.equal(result?.closedSessions, 2, 'обе сессии обязаны закрыться');
  assert.equal(result?.sessionsProblem, null);
  assert.equal(await sessions.get('ugnannaya'), null, 'по уведённой cookie больше не входят');
  assert.equal(await sessions.get('svoya'), null);

  // И пароль записан хэшем, а не как есть.
  const hash = written();
  assert.ok(hash && hash !== 'novyy-parol-1234');
  assert.ok(verifyAdminPassword('novyy-parol-1234', hash));
});

void test('сессии соседнего администратора не трогают', async () => {
  const { db } = fakeDb();
  const sessions = new MemoryAdminSessionStore();
  await sessions.set('moya', sessionOf(42), TTL);
  await sessions.set('sosedskaya', { ...sessionOf(7), login: 'sosed' }, TTL);

  await changeAdminPassword({ db, sessions }, 'vladelec', 'novyy-parol-1234');

  assert.notEqual(await sessions.get('sosedskaya'), null, 'сосед пароль не менял');
});

void test('недоступное хранилище сессий не отменяет смену пароля, но и не молчит', async () => {
  const { db, written } = fakeDb();
  const broken = {
    revokeByAdminId: async (): Promise<number> => {
      throw new Error('Redis недоступен');
    },
  } as unknown as AdminSessionStore;

  const result = await changeAdminPassword(
    { db, sessions: broken },
    'vladelec',
    'novyy-parol-1234',
  );

  /*
   * Пароль к этому моменту уже изменён, и уронить команду нельзя: человек
   * прочитал бы «сменить не удалось» про пароль, который сменился, и
   * повторил бы попытку с другим. Но и промолчать нельзя — он меняет
   * пароль именно затем, чтобы выгнать чужого.
   */
  assert.ok(written(), 'пароль обязан быть записан');
  assert.equal(result?.closedSessions, null);
  assert.match(result?.sessionsProblem ?? '', /Redis/u);
});

void test('нет такого администратора — ничего не меняем и не выдумываем', async () => {
  const { db, written } = fakeDb();
  const result = await changeAdminPassword(
    { db, sessions: new MemoryAdminSessionStore() },
    'takogo-net',
    'novyy-parol-1234',
  );
  assert.equal(result, null);
  assert.equal(written(), null);
});

void test('смена пароля снимает и поадресный замок, а не только счётчик учётки', async () => {
  /*
   * ЧТО БЫЛО. Чистился только admin_users, а ОСНОВНОЙ замок с миграции
   * 0037 живёт в admin_login_failures — пять промахов против тридцати. И
   * проверяется он РАНЬШЕ пароля, поэтому новый, правильный пароль не
   * помогал. Ломалось это ровно в том сценарии, ради которого сброс и
   * написан: человек забыл пароль, промахнулся пять раз со своего адреса
   * и пошёл на сервер сбрасывать. Скрипт печатал «блокировка снята»,
   * форма отвечала «вход заблокирован ещё на 15 мин».
   */
  const { db, clearedLocks } = fakeDb();
  const sessions = new MemoryAdminSessionStore();

  const result = await changeAdminPassword({ db, sessions }, 'vladelec', 'novyy-parol-ochen');

  assert.ok(result);
  assert.deepEqual(clearedLocks(), ['vladelec']);
});
