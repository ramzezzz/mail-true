/**
 * Восстановление копии: отказ оформления не должен стирать след операции.
 *
 * ПОЧЕМУ ЭТО ВАЖНЕЕ, ЧЕМ КАЖЕТСЯ
 *
 * Восстановление идёт в таком порядке: одной транзакцией — домены, ящики,
 * алиасы и УЧЁТНЫЕ ЗАПИСИ АДМИНИСТРАТОРОВ; затем, уже вне транзакции, —
 * логотип и подписи оформления (это файлы в томе, а не строки в базе);
 * и только после всего — запись в журнал аудита.
 *
 * Пока отказ логотипа бросался наружу, эта последовательность давала
 * худший из возможных исходов: пароли всей организации и учётные записи
 * администраторов уже перезаписаны, транзакция закоммичена, откатывать
 * нечего — а маршрут до записи в журнал не доходит. Операция, меняющая
 * пароль администратора, не оставляла в аудите НИ ОДНОЙ строки.
 *
 * Проверяем именно это: битая картинка внутри копии не должна превращать
 * восстановление в исключение. Она должна вернуться текстом.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestError } from '../errors.js';
import { applyRestore } from './backup-store.js';
import { buildSettingsBackup, type SettingsBackupFile } from './backup-format.js';
import type { AdminDb } from './db.js';
import type { BrandingStore } from './branding.js';

/** Копия, в которой есть только оформление. */
function backupWithBranding(): SettingsBackupFile {
  return buildSettingsBackup({
    source: { hostname: 'mail.staraya.ru', domain: 'staraya.ru' },
    data: {
      domains: [],
      mailboxes: [],
      aliases: [],
      admins: [],
      userSettings: [],
      ai: [],
      branding: {
        companyName: 'ООО «Ромашка»',
        productName: null,
        logo: null,
        // Байты, которые не опознаются ни одним из разрешённых форматов:
        // именно на них спотыкается inspectLogo при восстановлении.
        logoBase64: Buffer.from('это не картинка').toString('base64'),
      },
    },
  });
}

/** База, до которой в этом сценарии дело не доходит: разделов нет. */
function emptyDb(): AdminDb {
  return {
    transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async () => {
          throw new Error('в этом сценарии запросов быть не должно');
        },
      }),
  } as unknown as AdminDb;
}

void test('битый логотип в копии не роняет восстановление, а возвращается текстом', async () => {
  const rejecting = {
    importSnapshot: async () => {
      // Ровно то, что бросает inspectLogo на неопознанной картинке.
      throw new BadRequestError('Файл не опознан как картинка (PNG, JPEG, WEBP, GIF, SVG)');
    },
  } as unknown as BrandingStore;

  const outcome = await applyRestore(emptyDb(), rejecting, backupWithBranding(), ['branding']);

  // Главное: исключения нет. Значит вызывающий дойдёт до записи в аудит.
  assert.equal(typeof outcome.brandingError, 'string');
  assert.match(outcome.brandingError ?? '', /не опознан как картинка/u);
  // И оформление честно не числится применённым.
  assert.equal(outcome.applied.branding, undefined);
});

void test('целое оформление применяется и об ошибке не сообщается', async () => {
  let called = 0;
  const accepting = {
    importSnapshot: async () => {
      called += 1;
    },
  } as unknown as BrandingStore;

  const outcome = await applyRestore(emptyDb(), accepting, backupWithBranding(), ['branding']);

  assert.equal(called, 1);
  assert.equal(outcome.brandingError, null);
  assert.deepEqual(outcome.applied.branding, { created: 0, updated: 1 });
});

void test('без раздела «оформление» логотип не трогают вовсе', async () => {
  const forbidden = {
    importSnapshot: async () => {
      throw new Error('оформление не просили — трогать его нельзя');
    },
  } as unknown as BrandingStore;

  const outcome = await applyRestore(emptyDb(), forbidden, backupWithBranding(), []);
  assert.equal(outcome.brandingError, null);
});

/* ------------------------------------------------------------------ */
/* Нарушенное правило базы — отказ человеку, а не «внутренняя ошибка»   */
/* ------------------------------------------------------------------ */

/** Копия с одним администратором: роль подставляется проверкой. */
function backupWithAdmin(role: string): SettingsBackupFile {
  return buildSettingsBackup({
    source: { hostname: 'mail.staraya.ru', domain: 'staraya.ru' },
    data: {
      domains: [],
      mailboxes: [],
      aliases: [],
      admins: [
        {
          login: 'petrov',
          displayName: 'Пётр Петров',
          role,
          active: true,
          passwordHash: '$2y$10$нечитаемыйхэш',
        },
      ],
      userSettings: [],
      ai: [],
      branding: null,
    },
  });
}

/**
 * База, отвечающая тем же, чем ответил бы Postgres на запрещённое
 * значение: код 23514 и имя нарушенного ограничения.
 */
function checkViolatingDb(constraint: string): AdminDb {
  return {
    transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async () => {
          const err = new Error(
            `new row for relation "admin_users" violates check constraint "${constraint}"`,
          ) as Error & { code: string; constraint: string };
          err.code = '23514';
          err.constraint = constraint;
          throw err;
        },
      }),
  } as unknown as AdminDb;
}

void test('запрещённая роль в копии — понятный отказ, а не «внутренняя ошибка»', async () => {
  const branding = { importSnapshot: async () => undefined } as unknown as BrandingStore;

  await assert.rejects(
    applyRestore(checkViolatingDb('admin_users_role_check'), branding, backupWithAdmin('hacker'), [
      'admins',
    ]),
    (err: unknown) => {
      // Именно 400: файл принесли не тот, сервер цел. С 500 человек имел
      // полное право считать, что сломан сервер, и файл не проверял.
      assert.ok(err instanceof BadRequestError, `ожидался BadRequestError, пришло ${String(err)}`);
      assert.equal(err.statusCode, 400);
      // Сказано, ГДЕ именно: раздел и запись. Без этого в копии на тысячу
      // ящиков неверную строку пришлось бы искать глазами.
      assert.match(err.message, /Администраторы/u);
      assert.match(err.message, /petrov/u);
      // И сказано, что допустимо, — иначе отказ не отвечает «что делать».
      assert.match(err.message, /owner/u);
      assert.match(err.message, /user_manager/u);
      assert.match(err.message, /readonly/u);
      return true;
    },
  );
});

void test('незнакомое ограничение тоже объясняется, а не выпадает пятисоткой', async () => {
  const branding = { importSnapshot: async () => undefined } as unknown as BrandingStore;

  await assert.rejects(
    applyRestore(
      checkViolatingDb('nekoe_novoe_ogranichenie'),
      branding,
      backupWithAdmin('owner'),
      ['admins'],
    ),
    (err: unknown) => {
      assert.ok(err instanceof BadRequestError);
      // Названия ограничения хватает, чтобы найти правило в схеме; главное
      // — что это по-прежнему отказ по файлу, а не «внутренняя ошибка».
      assert.match(err.message, /nekoe_novoe_ogranichenie/u);
      return true;
    },
  );
});

void test('поломка сервера остаётся поломкой сервера, а не отказом по файлу', async () => {
  // Обратный ход: не всякая ошибка базы — вина принесённого файла.
  // Выдать обрыв соединения за 400 значило бы заставить человека править
  // копию, тогда как чинить надо сервер.
  const brokenDb = {
    transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async () => {
          const err = new Error('connection terminated unexpectedly') as Error & { code: string };
          err.code = '08006';
          throw err;
        },
      }),
  } as unknown as AdminDb;
  const branding = { importSnapshot: async () => undefined } as unknown as BrandingStore;

  await assert.rejects(
    applyRestore(brokenDb, branding, backupWithAdmin('owner'), ['admins']),
    (err: unknown) => {
      assert.ok(!(err instanceof BadRequestError), 'обрыв связи с базой — не ошибка файла');
      return true;
    },
  );
});
