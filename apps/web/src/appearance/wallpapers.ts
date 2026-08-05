/**
 * Фоновые картинки «обойной» темы.
 *
 * Готовые фоны нарисованы кодом (градиенты и узоры из повторяющихся
 * градиентов) — растровых файлов в репозитории нет. Все они среднего или
 * тёмного тона: поверх ложится ещё и затемнение темы (--mt-wallpaper-dim),
 * так что белый текст шапки и меню читается на любом из них.
 *
 * Своя картинка хранится в IndexedDB БРАУЗЕРА, и это решение, а не
 * компромисс по остаточному принципу:
 *   - localStorage не годится: он строковый и с квотой ~5 МБ — фотография
 *     в base64 туда не помещается, а попытка класть её туда при каждом
 *     чтении настроек гоняла бы мегабайты строк;
 *   - на сервере маршрута для пользовательских файлов оформления нет,
 *     выдумывать его нельзя (что нужно от API — см. отчёт: PUT/GET/DELETE
 *     /api/settings/wallpaper, multipart, лимит размера);
 *   - IndexedDB же хранит Blob как есть, квота — сотни мегабайт, доступ
 *     не блокирует поток. Цена решения: картинка живёт на одном
 *     устройстве и не переезжает за ящиком — до появления маршрута API.
 *
 * В localStorage лежит только КОРОТКИЙ выбор (`preset:<id>` | `custom`),
 * сама картинка — никогда.
 */

export interface WallpaperPreset {
  id: string;
  title: string;
  /** Значение background-image — то, что уходит в --mt-user-wallpaper. */
  css: string;
}

export const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  {
    id: 'depth',
    title: 'Глубина',
    css: 'linear-gradient(160deg, #1e3c72 0%, #2a5298 45%, #6a85b6 100%)',
  },
  {
    id: 'dusk',
    title: 'Сумерки',
    css: 'linear-gradient(135deg, #141e30 0%, #243b55 60%, #3e5c76 100%)',
  },
  {
    id: 'forest',
    title: 'Хвоя',
    css: 'linear-gradient(150deg, #0f2f26 0%, #1e5f4e 55%, #3c8d72 100%)',
  },
  {
    id: 'plum',
    title: 'Слива',
    css: 'linear-gradient(140deg, #2b1531 0%, #5c2a6e 55%, #9b59b6 100%)',
  },
  {
    id: 'sunset',
    title: 'Закат',
    css: 'linear-gradient(150deg, #2d1b4e 0%, #7b2d5e 55%, #e96443 100%)',
  },
  {
    id: 'aurora',
    title: 'Аврора',
    css: 'linear-gradient(200deg, #0b1e3d 0%, #155e63 55%, #4ca487 100%)',
  },
  {
    // Узор поверх градиента: тонкая диагональная штриховка
    id: 'graphite',
    title: 'Графит',
    css:
      'repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.05) 0 2px, transparent 2px 24px), ' +
      'linear-gradient(180deg, #23272e 0%, #2e3440 100%)',
  },
  {
    // Узор «клетка» из двух повторяющихся градиентов
    id: 'grid',
    title: 'Клетка',
    css:
      'repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.05) 0 1px, transparent 1px 32px), ' +
      'repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.05) 0 1px, transparent 1px 32px), ' +
      'linear-gradient(160deg, #134e5e 0%, #2e6b63 100%)',
  },
];

export type WallpaperSelection = { kind: 'preset'; id: string } | { kind: 'custom' };

const SELECTION_KEY = 'mt-wallpaper';

/** Своя картинка не больше 10 МБ: хватает любой фотографии с телефона,
 *  а квоту IndexedDB и память под object URL не раздувает. */
export const CUSTOM_WALLPAPER_MAX_BYTES = 10 * 1024 * 1024;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Разбор сохранённого выбора; всё непонятное — первый готовый фон. */
export function parseWallpaperSelection(raw: string | null): WallpaperSelection {
  if (raw === 'custom') return { kind: 'custom' };
  if (raw?.startsWith('preset:')) {
    const id = raw.slice('preset:'.length);
    if (WALLPAPER_PRESETS.some((p) => p.id === id)) return { kind: 'preset', id };
  }
  return { kind: 'preset', id: WALLPAPER_PRESETS[0]!.id };
}

export function readWallpaperSelection(): WallpaperSelection {
  return parseWallpaperSelection(storage()?.getItem(SELECTION_KEY) ?? null);
}

function saveSelection(selection: WallpaperSelection): void {
  storage()?.setItem(
    SELECTION_KEY,
    selection.kind === 'custom' ? 'custom' : `preset:${selection.id}`,
  );
}

/** Проверка файла до сохранения; текст отказа или null, если всё хорошо. */
export function validateWallpaperFile(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('image/')) return 'Это не изображение';
  if (file.size > CUSTOM_WALLPAPER_MAX_BYTES) {
    return `Картинка больше ${Math.round(CUSTOM_WALLPAPER_MAX_BYTES / 1024 / 1024)} МБ`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* IndexedDB: одна база, одно хранилище, одна запись                    */
/* ------------------------------------------------------------------ */

const DB_NAME = 'mt-appearance';
const STORE = 'wallpaper';
const RECORD_KEY = 'custom';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB недоступна'));
  });
}

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('операция IndexedDB не удалась'));
  });
}

async function dbPut(blob: Blob): Promise<void> {
  const db = await openDb();
  if (!db) throw new Error('браузер не даёт сохранить картинку (нет IndexedDB)');
  try {
    await requestDone(db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, RECORD_KEY));
  } finally {
    db.close();
  }
}

async function dbGet(): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const value = await requestDone(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_KEY),
    );
    return value instanceof Blob ? value : null;
  } finally {
    db.close();
  }
}

async function dbDelete(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await requestDone(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(RECORD_KEY));
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Применение                                                           */
/* ------------------------------------------------------------------ */

/** Действующий object URL своей картинки — старый освобождаем при замене. */
let customUrl: string | null = null;

function setCssVar(value: string | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (value === null) root.style.removeProperty('--mt-user-wallpaper');
  else root.style.setProperty('--mt-user-wallpaper', value);
}

function releaseCustomUrl(): void {
  if (customUrl !== null) {
    URL.revokeObjectURL(customUrl);
    customUrl = null;
  }
}

/**
 * Применить выбор: выставить --mt-user-wallpaper на <html>.
 * Для своей картинки блоб читается из IndexedDB; если его там уже нет
 * (почистили данные сайта) — молча откатываемся на первый готовый фон.
 */
export async function applyWallpaper(selection: WallpaperSelection): Promise<void> {
  if (selection.kind === 'preset') {
    releaseCustomUrl();
    const preset = WALLPAPER_PRESETS.find((p) => p.id === selection.id) ?? WALLPAPER_PRESETS[0]!;
    setCssVar(preset.css);
    return;
  }
  const blob = await dbGet();
  if (!blob) {
    saveSelection({ kind: 'preset', id: WALLPAPER_PRESETS[0]!.id });
    releaseCustomUrl();
    setCssVar(WALLPAPER_PRESETS[0]!.css);
    return;
  }
  releaseCustomUrl();
  customUrl = URL.createObjectURL(blob);
  setCssVar(`url("${customUrl}")`);
}

/** Выбрать фон (и запомнить выбор). */
export async function selectWallpaper(selection: WallpaperSelection): Promise<void> {
  saveSelection(selection);
  await applyWallpaper(selection);
}

/** Выбрать готовый фон по идентификатору. */
export async function setWallpaperPreset(id: string): Promise<void> {
  await selectWallpaper({ kind: 'preset', id });
}

/** Сохранить свою картинку и сделать её текущей. */
export async function setCustomWallpaper(blob: Blob): Promise<void> {
  await dbPut(blob);
  saveSelection({ kind: 'custom' });
  await applyWallpaper({ kind: 'custom' });
}

/** Убрать свою картинку (и из IndexedDB тоже); вернуться к первому фону. */
export async function clearCustomWallpaper(): Promise<void> {
  await dbDelete();
  await setWallpaperPreset(WALLPAPER_PRESETS[0]!.id);
}

/** Есть ли сохранённая своя картинка; url — для миниатюры в настройках. */
export async function loadCustomWallpaperUrl(): Promise<string | null> {
  const blob = await dbGet();
  return blob ? URL.createObjectURL(blob) : null;
}

/** Восстановить сохранённый выбор при старте приложения. */
export async function initWallpaper(): Promise<void> {
  await applyWallpaper(readWallpaperSelection());
}
