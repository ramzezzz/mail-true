/**
 * Фоновые картинки «обойной» темы.
 *
 * Набор — двадцать настоящих фотографий, разложенных по настроениям
 * (цветы, абстракция, города, море, компьютерная тематика) плюс восемь
 * простых фонов, нарисованных кодом. Заказчик попросил именно фотографий:
 * «добавь какие-то реальные картинки, а не просто градиент — для разных
 * групп пользователей». Группы нужны затем же: человек выбирает внутри
 * близкого ему настроения, а не из общей кучи двадцати восьми плиток.
 *
 * Откуда взята каждая картинка, кто автор и на каких условиях — в
 * docs/wallpapers-sources.md. Перечень не формальность: файлы уезжают
 * в поставку, и новая картинка без записи в нём — это картинка, за
 * которую через полгода некому будет отвечать. Все лицензии — CC0 либо
 * public domain; людей, логотипов и торговых марок в кадре нет.
 *
 * Простые фоны кодом оставлены и стоят ПОСЛЕ фотографий: они ничего не
 * весят, мгновенно рисуются и годятся тем, кому фотография под письмами
 * мешает.
 *
 * Все фоны среднего или тёмного тона: поверх ложится ещё и затемнение
 * темы (--mt-wallpaper-dim), так что белый текст шапки и меню читается
 * на любом из них. Контраст текста поверх КАЖДОЙ фотографии посчитан —
 * таблица в том же docs/wallpapers-sources.md.
 *
 * ВЫБОР фона хранится за учётной записью на сервере (настройки ящика),
 * как и тема: требование заказчика — «тема оформления должна запоминаться
 * для каждого юзера». На сервер уходит только КОРОТКАЯ строка
 * (`preset:<id>` | `custom`), localStorage остаётся кэшем до ответа
 * (см. cache.ts).
 *
 * САМА пользовательская картинка на сервер не уходит и остаётся в
 * IndexedDB БРАУЗЕРА. Это решение, а не компромисс по остаточному принципу:
 *   - localStorage не годится: он строковый и с квотой ~5 МБ — фотография
 *     в base64 туда не помещается, а попытка класть её туда при каждом
 *     чтении настроек гоняла бы мегабайты строк;
 *   - на сервере маршрута для пользовательских ФАЙЛОВ оформления нет.
 *     Заводить его ради обоев значит гонять мегабайты при каждом входе
 *     и держать их в базе рядом с почтой — цена несоразмерна;
 *   - IndexedDB же хранит Blob как есть, квота — сотни мегабайт, доступ
 *     не блокирует поток. Цена решения: картинка живёт на одном
 *     устройстве.
 *
 * Отсюда правило для другого компьютера: выбор `custom` доедет, а байтов
 * рядом не окажется — тогда показывается первый готовый фон, БЕЗ ошибки
 * и без переписывания серверного выбора (иначе поездка на чужой ноутбук
 * молча стирала бы картинку на своём). Пользователю это объяснено
 * подсказкой на странице оформления.
 */

import { readCachedWallpaper, writeCachedWallpaper } from './cache';
import { persistAppearance } from './persist';

/** Настроение, по которому сгруппированы фоны на странице оформления. */
export type WallpaperGroupId = 'flowers' | 'abstract' | 'city' | 'sea' | 'tech' | 'plain';

export interface WallpaperGroup {
  id: WallpaperGroupId;
  title: string;
}

export const WALLPAPER_GROUPS: readonly WallpaperGroup[] = [
  { id: 'flowers', title: 'Цветы и летний луг' },
  { id: 'abstract', title: 'Абстракция' },
  { id: 'city', title: 'Города и дома' },
  { id: 'sea', title: 'Море и пляж' },
  { id: 'tech', title: 'Компьютерная тематика' },
  { id: 'plain', title: 'Простые фоны' },
];

export interface WallpaperPreset {
  id: string;
  title: string;
  group: WallpaperGroupId;
  /** Значение background-image — то, что уходит в --mt-user-wallpaper. */
  css: string;
  /**
   * Значение background-image для ПЛИТКИ в настройках.
   *
   * У фотографий это отдельный файл 480×270, а не тот же самый: страница
   * оформления показывает два с лишним десятка плиток разом, и тянуть
   * ради них два с лишним десятка полноразмерных картинок — это шесть
   * мегабайт на открытие раздела «Оформление». У фонов, нарисованных
   * кодом, плитка совпадает с самим фоном: рисовать нечего.
   */
  thumb: string;
}

/**
 * Фотография из public/wallpapers.
 *
 * В `css` ДВА слоя, и это не украшение. Заказчик просил, чтобы выбранная
 * картинка была видна СРАЗУ при выборе, а полноразмерный файл весит
 * сотни килобайт и приезжает не мгновенно — до этого фон оставался бы
 * прежним, и щелчок выглядел бы не сработавшим. Миниатюра к этому моменту
 * уже загружена (её показывает плитка), поэтому она лежит ВТОРЫМ слоем:
 * браузер показывает её растянутой сразу, а как только доедет верхний
 * слой — он её закрывает. Тот же приём, что и «размытая заглушка» в
 * лентах фотографий, только без единой строчки скрипта.
 */
function photo(id: string, title: string, group: WallpaperGroupId): WallpaperPreset {
  return {
    id,
    title,
    group,
    css: `url("/wallpapers/${id}.webp"), url("/wallpapers/${id}-thumb.webp")`,
    thumb: `url("/wallpapers/${id}-thumb.webp")`,
  };
}

/** Фон, нарисованный кодом: плитка — он же сам. */
function drawn(id: string, title: string, css: string): WallpaperPreset {
  return { id, title, group: 'plain', css, thumb: css };
}

export const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  photo('lupines', 'Луг в горах', 'flowers'),
  photo('lavender', 'Лавандовое поле', 'flowers'),
  photo('poppies', 'Маковое поле', 'flowers'),
  photo('sunflowers', 'Подсолнухи', 'flowers'),

  photo('gradient', 'Плавный градиент', 'abstract'),
  photo('geometry', 'Геометрия', 'abstract'),
  photo('spiral', 'Спираль', 'abstract'),
  photo('facets', 'Грани', 'abstract'),

  photo('riverside', 'Город у реки', 'city'),
  photo('harbour', 'Огни над водой', 'city'),
  photo('glass', 'Стекло и небо', 'city'),
  photo('bridge', 'Мост в огнях', 'city'),

  photo('seasunset', 'Закат на побережье', 'sea'),
  photo('surf', 'Прибой', 'sea'),
  photo('reef', 'Рифы с орбиты', 'sea'),
  photo('seasurface', 'Морская гладь', 'sea'),

  photo('code', 'Строки кода', 'tech'),
  photo('colorcode', 'Цветной код', 'tech'),
  photo('hardware', 'Железо', 'tech'),
  photo('ledscreen', 'Светодиодный экран', 'tech'),

  drawn('depth', 'Глубина', 'linear-gradient(160deg, #1e3c72 0%, #2a5298 45%, #6a85b6 100%)'),
  drawn('dusk', 'Сумерки', 'linear-gradient(135deg, #141e30 0%, #243b55 60%, #3e5c76 100%)'),
  drawn('forest', 'Хвоя', 'linear-gradient(150deg, #0f2f26 0%, #1e5f4e 55%, #3c8d72 100%)'),
  drawn('plum', 'Слива', 'linear-gradient(140deg, #2b1531 0%, #5c2a6e 55%, #9b59b6 100%)'),
  drawn('sunset', 'Закат', 'linear-gradient(150deg, #2d1b4e 0%, #7b2d5e 55%, #e96443 100%)'),
  drawn('aurora', 'Аврора', 'linear-gradient(200deg, #0b1e3d 0%, #155e63 55%, #4ca487 100%)'),
  drawn(
    // Узор поверх градиента: тонкая диагональная штриховка
    'graphite',
    'Графит',
    'repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.05) 0 2px, transparent 2px 24px), ' +
      'linear-gradient(180deg, #23272e 0%, #2e3440 100%)',
  ),
  drawn(
    // Узор «клетка» из двух повторяющихся градиентов
    'grid',
    'Клетка',
    'repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.05) 0 1px, transparent 1px 32px), ' +
      'repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.05) 0 1px, transparent 1px 32px), ' +
      'linear-gradient(160deg, #134e5e 0%, #2e6b63 100%)',
  ),
];

export type WallpaperSelection = { kind: 'preset'; id: string } | { kind: 'custom' };

/** Своя картинка не больше 10 МБ: хватает любой фотографии с телефона,
 *  а квоту IndexedDB и память под object URL не раздувает. */
export const CUSTOM_WALLPAPER_MAX_BYTES = 10 * 1024 * 1024;

/** Разбор сохранённого выбора; всё непонятное — первый готовый фон. */
export function parseWallpaperSelection(raw: string | null): WallpaperSelection {
  if (raw === 'custom') return { kind: 'custom' };
  if (raw?.startsWith('preset:')) {
    const id = raw.slice('preset:'.length);
    if (WALLPAPER_PRESETS.some((p) => p.id === id)) return { kind: 'preset', id };
  }
  return { kind: 'preset', id: WALLPAPER_PRESETS[0]!.id };
}

/** Короткая запись выбора — она же формат хранения на сервере. */
export function wallpaperChoice(selection: WallpaperSelection): string {
  return selection.kind === 'custom' ? 'custom' : `preset:${selection.id}`;
}

export function readWallpaperSelection(): WallpaperSelection {
  return parseWallpaperSelection(readCachedWallpaper());
}

function saveSelection(selection: WallpaperSelection): void {
  writeCachedWallpaper(wallpaperChoice(selection));
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
 *
 * Для своей картинки блоб читается из IndexedDB. Его может не быть по двум
 * разным причинам, и обе кончаются одинаково — первым готовым фоном, молча:
 * либо почистили данные сайта, либо человек вошёл в тот же ящик С ДРУГОГО
 * компьютера, где его картинки просто нет (на сервере хранится выбор, а не
 * байты). Запасной фон при этом НИКУДА НЕ ЗАПИСЫВАЕТСЯ: запиши его — и
 * поездка на чужой ноутбук стёрла бы картинку на своём.
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
    releaseCustomUrl();
    setCssVar(WALLPAPER_PRESETS[0]!.css);
    return;
  }
  releaseCustomUrl();
  customUrl = URL.createObjectURL(blob);
  setCssVar(`url("${customUrl}")`);
}

/** Есть ли своя картинка в этом браузере (для страницы оформления). */
export async function hasCustomWallpaper(): Promise<boolean> {
  return (await dbGet()) !== null;
}

/**
 * Выбрать фон: запомнить (кэш + сервер) и применить.
 * Отправка на сервер — потому что выбор фона, как и тема, принадлежит
 * учётной записи, а не браузеру.
 */
export async function selectWallpaper(selection: WallpaperSelection): Promise<void> {
  saveSelection(selection);
  persistAppearance({ wallpaper: wallpaperChoice(selection) });
  await applyWallpaper(selection);
}

/**
 * Применить выбор, ПРИШЕДШИЙ С СЕРВЕРА: кэш обновляем, обратно не шлём.
 * Отдельно от `selectWallpaper` нарочно — иначе ответ сервера тут же
 * уехал бы обратно на сервер, и каждая загрузка почты писала бы в базу.
 */
export async function adoptWallpaperChoice(choice: string): Promise<void> {
  const selection = parseWallpaperSelection(choice);
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
  await selectWallpaper({ kind: 'custom' });
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
