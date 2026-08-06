/**
 * Оформление ящика: тема и выбор фоновой картинки — контракт, общий для
 * сервера и почты.
 *
 * Требование заказчика: «тема оформления должна запоминаться для КАЖДОГО
 * юзера». Раньше выбор лежал только в localStorage, то есть был привязан
 * к БРАУЗЕРУ: за другим компьютером тема сбрасывалась, а два человека за
 * одним браузером делили одну. Теперь выбор хранится за учётной записью
 * (mail_user_settings.theme / .wallpaper), а localStorage остаётся кэшем
 * для мгновенного применения до ответа сервера.
 *
 * Модуль лежит в общем пакете нарочно: список тем проверяет и сервер
 * (чтобы в базу не попало неизвестное значение), и почта (чтобы не
 * применить то, чего нет в стилях). Пока такие списки лежат в двух
 * местах, они расходятся молча — и расхождение вскрывается уже на экране
 * пользователя: сервер принял тему, которую интерфейс показать не умеет.
 *
 * Про фоновую картинку. Здесь проверяется только ФОРМА выбора
 * (`preset:<id>` либо `custom`), а не список готовых фонов: фоны рисуются
 * кодом в apps/web/src/appearance/wallpapers.ts, и серверу знать их
 * незачем — иначе каждый новый фон требовал бы миграции API. Сами байты
 * пользовательской картинки на сервер не уходят: они лежат в IndexedDB
 * браузера (почему — см. шапку wallpapers.ts), поэтому `custom` на другом
 * устройстве честно откатывается на первый готовый фон.
 *
 * Ни одной зависимости от Node: модуль попадает и в браузерную сборку.
 */

/**
 * Выбор темы. 'system' — следовать prefers-color-scheme; остальное —
 * идентификаторы тем из apps/web/src/appearance/themes.ts. Совпадение
 * этого списка с реестром тем проверяется тестом в почте.
 */
export const THEME_SETTINGS = [
  'system',
  'light',
  'dark',
  'emerald',
  'violet',
  'coral',
  'lagoon',
  'sunset',
  'wallpaper',
] as const;

export type ThemeSetting = (typeof THEME_SETTINGS)[number];

/** Ящик, где тему ни разу не выбирали, следует системной. */
export const DEFAULT_THEME_SETTING: ThemeSetting = 'system';

/**
 * Выбор фона: `preset:<id>` (готовый фон) либо `custom` (своя картинка).
 * Пустая строка — «не выбирали»; интерфейс покажет первый готовый фон.
 */
export const DEFAULT_WALLPAPER_CHOICE = '';

/** Длина колонки mail_user_settings.wallpaper — VARCHAR(64). */
export const WALLPAPER_CHOICE_MAX_CHARS = 64;

/** Идентификатор готового фона: латиница, цифры и дефис. */
const PRESET_ID = /^[a-z0-9-]{1,48}$/;

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return typeof value === 'string' && (THEME_SETTINGS as readonly string[]).includes(value);
}

/**
 * Тема из внешнего источника (база, тело запроса, localStorage).
 * Всё нераспознанное — тема по умолчанию: неизвестное значение нельзя
 * ни применить, ни показать, а падать из-за него незачем.
 */
export function normalizeThemeSetting(value: unknown): ThemeSetting {
  return isThemeSetting(value) ? value : DEFAULT_THEME_SETTING;
}

/** Проверка формы выбора фона (список готовых фонов знает только почта). */
export function isWallpaperChoice(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === 'custom') return true;
  if (!value.startsWith('preset:')) return false;
  return PRESET_ID.test(value.slice('preset:'.length));
}

/** Выбор фона из внешнего источника; мусор — «не выбирали». */
export function normalizeWallpaperChoice(value: unknown): string {
  return isWallpaperChoice(value) ? (value as string) : DEFAULT_WALLPAPER_CHOICE;
}

/** Оформление ящика целиком — то, что ходит между почтой и сервером. */
export interface AppearanceSettings {
  /**
   * Чьё это оформление.
   *
   * Адрес в ответе — не украшение: почта по нему решает, её ли это кэш.
   * Вход другим пользователем на том же компьютере обязан показать ЕГО
   * тему, а не предыдущую, и сравнить адрес — единственный способ отличить
   * «свой кэш» от «чужой» до того, как чужая тема мигнёт на экране.
   */
  email: string;
  theme: ThemeSetting;
  wallpaper: string;
}
