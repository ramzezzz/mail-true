/**
 * Кэш оформления в localStorage — и признак того, ЧЬЁ это оформление.
 *
 * Источник истины для темы и фона теперь сервер (настройки ящика,
 * см. apps/api/src/settings/appearance.ts): требование заказчика — «тема
 * оформления должна запоминаться для каждого юзера», то есть за учётной
 * записью, а не за браузером.
 *
 * Но одного сервера мало. Ответ приходит через сотни миллисекунд после
 * первого кадра, и всё это время почта должна быть уже в нужной теме —
 * иначе при каждой загрузке экран мигал бы светлой темой. Поэтому
 * localStorage остаётся КЭШЕМ: применили из кэша сразу, дождались ответа
 * сервера, при расхождении применили серверное и обновили кэш.
 *
 * Отсюда третий ключ — `mt-appearance-account`. Кэш без имени владельца
 * опаснее, чем отсутствие кэша: на общем компьютере вошедший вторым
 * увидел бы тему первого — ровно тот дефект, ради которого всё и
 * затевалось. Поэтому кэш всегда подписан адресом ящика, а чужой кэш
 * стирается ДО запроса к серверу, а не после ответа.
 *
 * Ключи `mt-theme` и `mt-wallpaper` оставлены прежними нарочно: у людей,
 * которые уже выбрали тему до этой правки, она не должна пропасть при
 * обновлении почты — до первого ответа сервера действует их старый выбор.
 */

import {
  normalizeThemeSetting,
  normalizeWallpaperChoice,
  type ThemeSetting,
} from '@mail-true/shared';

const THEME_KEY = 'mt-theme';
const WALLPAPER_KEY = 'mt-wallpaper';
const ACCOUNT_KEY = 'mt-appearance-account';

/** Хранилище браузера есть не всегда (тесты, отрисовка на сервере). */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // приватный режим может запрещать доступ
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Тема                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Тема из кэша. Пока пользователь не выбирал её явно, действует системная
 * (prefers-color-scheme); всё нераспознанное считается «как в системе».
 */
export function readCachedTheme(): ThemeSetting {
  return normalizeThemeSetting(storage()?.getItem(THEME_KEY));
}

export function writeCachedTheme(setting: ThemeSetting): void {
  // «Как в системе» храним явной строкой: отличать «не выбирал» от
  // «выбрал следовать системе» не нужно — поведение одно и то же
  storage()?.setItem(THEME_KEY, setting);
}

/* ------------------------------------------------------------------ */
/* Фон                                                                  */
/* ------------------------------------------------------------------ */

export function readCachedWallpaper(): string {
  return normalizeWallpaperChoice(storage()?.getItem(WALLPAPER_KEY));
}

export function writeCachedWallpaper(choice: string): void {
  storage()?.setItem(WALLPAPER_KEY, choice);
  notifyWallpaper();
}

/* ------------------------------------------------------------------ */
/* Владелец кэша                                                        */
/* ------------------------------------------------------------------ */

/** Адрес ящика, которому принадлежит кэш; null — кэш ничей. */
export function cachedAccount(): string | null {
  const value = storage()?.getItem(ACCOUNT_KEY);
  return value === null || value === undefined || value === '' ? null : value.toLowerCase();
}

export function writeCachedAccount(email: string): void {
  storage()?.setItem(ACCOUNT_KEY, email.toLowerCase());
}

/**
 * Забыть оформление целиком.
 *
 * Вызывается при выходе и при обнаружении чужого кэша. Стереть — а не
 * оставить «до ответа сервера»: пока кэш чужой, любое его применение
 * показывает следующему пользователю тему предыдущего.
 */
export function clearAppearanceCache(): void {
  const store = storage();
  if (!store) return;
  store.removeItem(THEME_KEY);
  store.removeItem(WALLPAPER_KEY);
  store.removeItem(ACCOUNT_KEY);
  notifyWallpaper();
}

/* ------------------------------------------------------------------ */
/* Оповещение о смене фона                                              */
/* ------------------------------------------------------------------ */

/*
 * Страница «Оформление» держит выбранный фон в своём состоянии — она
 * открыта, когда фон меняют. Но фон может измениться и мимо неё: ответ
 * сервера приезжает уже после первого рендера, а вход другим
 * пользователем стирает кэш. Без оповещения отметка «выбран» на плитке
 * осталась бы от прошлого владельца — интерфейс показывал бы одно,
 * а на фоне было бы другое.
 */
type WallpaperListener = () => void;

const listeners = new Set<WallpaperListener>();

export function onWallpaperChange(listener: WallpaperListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyWallpaper(): void {
  for (const listener of [...listeners]) listener();
}
