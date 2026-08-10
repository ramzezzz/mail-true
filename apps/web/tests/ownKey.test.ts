/**
 * Отпечаток ящика для Service Worker.
 *
 * ЧТО БЫЛО. Отпечаток сообщался работнику ровно из одного места — из
 * запроса состояния раздела «Уведомления», — то есть менялся только у
 * того, кто в этот раздел заходил. Вход, выход и смена ящика его не
 * трогали. На общем компьютере это значило: A включил «класть содержимое
 * в push» и закрыл вкладку не нажав «Выйти», за компьютер сел B и вошёл
 * под собой — и на письмо, адресованное A, B видел отправителя и тему.
 * Единственная защита в этом пути — сверка отпечатка, а отпечаток был
 * чужой.
 *
 * Здесь проверяется главное: расчёт совпадает с серверным (иначе сверка
 * не сойдётся НИКОГДА и содержимое из push перестанет показываться
 * вообще) и выход отпечаток стирает.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { accountKeyOf, announceOwnKey } from '../src/notifications/ownKey';

/** Тот же расчёт, что в apps/api/src/push/service.ts (accountKey). */
function serverKey(email: string): string {
  return createHash('sha256').update(email.toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

describe('отпечаток ящика', () => {
  it('считается ровно так же, как на сервере', async () => {
    for (const email of ['Petr@Example.COM', 'admin@home.local', 'ящик@почта.рф']) {
      expect(await accountKeyOf(email)).toBe(serverKey(email));
    }
  });

  it('регистр и пробелы по краям ничего не меняют', async () => {
    expect(await accountKeyOf('  Admin@Home.Local ')).toBe(serverKey('admin@home.local'));
  });

  it('выход стирает отпечаток, а не оставляет прежний', async () => {
    const posted: unknown[] = [];
    const registration = { active: { postMessage: (m: unknown) => posted.push(m) } };
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve(registration) },
    });
    try {
      await announceOwnKey(null);
      expect(posted).toEqual([{ type: 'mt-own-key', key: '' }]);
      await announceOwnKey('admin@home.local');
      expect(posted[1]).toEqual({
        type: 'mt-own-key',
        key: serverKey('admin@home.local'),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
