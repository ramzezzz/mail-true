/**
 * Своя фоновая картинка принадлежит человеку, а не браузеру.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Картинка лежала в хранилище браузера под одним ключом на всех —
 * 'custom'. Отсюда две беды сразу, и лечили их друг за счёт друга.
 *
 * Сперва на общем компьютере следующий вошедший открывал «Оформление» и
 * видел там чужое личное фото — мог рассмотреть и применить. Тогда
 * картинку стали стирать вместе со сбросом оформления. Но сброс зовётся
 * и при обычном выходе, и при переключении между СВОИМИ связанными
 * ящиками, а на сервер картинка не уходит никогда — значит человек,
 * вышедший из почты на собственном ноутбуке, терял загруженный файл
 * насовсем, без предупреждения и без отмены.
 *
 * Ключ по владельцу закрывает обе беды: чужому картинки не видно, своя
 * переживает и выход, и переключение ящиков.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCustomWallpaper,
  hasCustomWallpaper,
  loadCustomWallpaperUrl,
  setCustomWallpaper,
  setWallpaperOwner,
} from '../src/appearance/wallpapers';

/** Минимальная замена IndexedDB: одно хранилище «ключ → значение». */
function fakeIndexedDb(): Map<string, unknown> {
  const data = new Map<string, unknown>();

  const request = <T>(value: T): Record<string, unknown> => {
    const req: Record<string, unknown> = { result: value, error: null };
    queueMicrotask(() => (req.onsuccess as (() => void) | undefined)?.());
    return req;
  };

  const store = {
    put: (value: unknown, key: string) => {
      data.set(key, value);
      return request(undefined);
    },
    get: (key: string) => request(data.get(key) ?? undefined),
    delete: (key: string) => {
      data.delete(key);
      return request(undefined);
    },
  };

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
    close: () => undefined,
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = { result: db, error: null };
      queueMicrotask(() => (req.onsuccess as (() => void) | undefined)?.());
      return req;
    },
  };
  // URL.createObjectURL в jsdom нет — картинку мы всё равно не рисуем.
  (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
    'blob:тест';
  (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  return data;
}

describe('своя картинка принадлежит владельцу ящика', () => {
  let storage: Map<string, unknown>;

  beforeEach(() => {
    storage = fakeIndexedDb();
  });

  it('чужой не видит картинку — под его ключом её нет', async () => {
    setWallpaperOwner('ivan@mail.local');
    await setCustomWallpaper(new Blob(['фото'], { type: 'image/jpeg' }));
    expect(await hasCustomWallpaper()).toBe(true);

    // На том же компьютере входит другой человек.
    setWallpaperOwner('anna@mail.local');
    expect(await hasCustomWallpaper()).toBe(false);
    expect(await loadCustomWallpaperUrl()).toBe(null);
  });

  it('выход не стирает файл: хозяин вернётся и найдёт его на месте', async () => {
    setWallpaperOwner('ivan@mail.local');
    await setCustomWallpaper(new Blob(['фото'], { type: 'image/jpeg' }));

    setWallpaperOwner(''); // выход
    expect(await hasCustomWallpaper()).toBe(false);

    setWallpaperOwner('ivan@mail.local'); // вошёл снова
    expect(await hasCustomWallpaper()).toBe(true);
  });

  it('переключение между своими ящиками картинки не путает и не теряет', async () => {
    setWallpaperOwner('ivan@mail.local');
    await setCustomWallpaper(new Blob(['первое'], { type: 'image/jpeg' }));

    setWallpaperOwner('ivan.work@mail.local');
    expect(await hasCustomWallpaper()).toBe(false);
    await setCustomWallpaper(new Blob(['второе'], { type: 'image/jpeg' }));

    setWallpaperOwner('ivan@mail.local');
    expect(await hasCustomWallpaper()).toBe(true);
    expect(storage.size).toBe(2);
  });

  it('удаление трогает только свою запись', async () => {
    setWallpaperOwner('ivan@mail.local');
    await setCustomWallpaper(new Blob(['моё'], { type: 'image/jpeg' }));
    setWallpaperOwner('anna@mail.local');
    await setCustomWallpaper(new Blob(['её'], { type: 'image/jpeg' }));

    await clearCustomWallpaper();
    expect(await hasCustomWallpaper()).toBe(false);

    setWallpaperOwner('ivan@mail.local');
    expect(await hasCustomWallpaper()).toBe(true);
  });

  it('тот же адрес с заглавной буквы — тот же человек', async () => {
    setWallpaperOwner('ivan@mail.local');
    await setCustomWallpaper(new Blob(['фото'], { type: 'image/jpeg' }));

    setWallpaperOwner('Ivan@Mail.Local');
    expect(await hasCustomWallpaper()).toBe(true);
  });

  it('без вошедшего сохранять некому — молча в общий ключ не пишем', async () => {
    setWallpaperOwner('');
    await expect(setCustomWallpaper(new Blob(['ничьё'], { type: 'image/jpeg' }))).rejects.toThrow();
    expect(storage.size).toBe(0);
  });
});
