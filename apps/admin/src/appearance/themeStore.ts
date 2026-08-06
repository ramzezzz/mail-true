/**
 * Выбранная тема панели: чтение, применение, память ЗА УЧЁТНОЙ ЗАПИСЬЮ.
 *
 * ------------------------------------------------------------------
 * ГДЕ ЛЕЖИТ ВЫБОР
 * ------------------------------------------------------------------
 * На сервере, в admin_users.theme (миграция 0009). Раньше он лежал только
 * в localStorage, то есть был привязан к КОМПЬЮТЕРУ: сел за другую машину —
 * тема сбросилась; два администратора за одной машиной делили одну тему.
 * Заказчик просил помнить оформление за человеком.
 *
 * localStorage остался, но сменил роль — это КЭШ на время загрузки. Ответ
 * о сессии приходит через сеть, и без кэша панель на каждой загрузке
 * показывала бы графит и только потом перекрашивалась. Порядок такой:
 *
 *   1. initAdminTheme() — применили тему из кэша (мгновенно, до отрисовки);
 *   2. пришёл ответ /auth/session — adoptServerTheme();
 *   3. серверная отличается от кэша — применили серверную и обновили кэш.
 *
 * ------------------------------------------------------------------
 * ЧУЖАЯ ТЕМА СЛЕДУЮЩЕМУ НЕ ДОСТАЁТСЯ
 * ------------------------------------------------------------------
 * В кэше лежит не только тема, но и ЛОГИН, которому она принадлежит. Если
 * вошёл другой администратор, кэш чужой: его значение не в счёт, берётся
 * серверное (а нет серверного — умолчание). Плюс выход из панели кэш
 * стирает, поэтому следующий вход начинается с графита, а не с чужой
 * расцветки. Логин в кэше — не тайна: он и так виден в шапке.
 *
 * Признак на <html> тот же, что в почте, — data-theme. Рядом ставится
 * data-theme-kind (light|dark): по нему стили выбирают тёмное начертание
 * логотипа и прочее, что зависит не от конкретной темы, а от того, светлая
 * она или тёмная. Без него каждая новая тёмная тема требовала бы правки
 * во всех местах, где перечислены тёмные.
 */

import {
  ADMIN_THEMES,
  adminThemeMeta,
  isAdminThemeName,
  type AdminThemeName,
  type AdminThemeSetting,
} from './adminThemes';

const STORAGE_KEY = 'mt-admin-theme';

/**
 * Тема по умолчанию — фирменный графит, а не светлая.
 *
 * Заказчик просил для панели особую цветовую гамму: открыв её, человек
 * обязан видеть, что это не почта. Вход уже встречает графитом и бирюзой,
 * и панель за ним продолжает ту же гамму, а не сбрасывается в белое.
 */
export const DEFAULT_ADMIN_THEME: AdminThemeSetting = 'graphite';

/** Хранилище браузера есть не всегда (тесты, приватный режим). */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Кэш: чей выбор и какой. Логин нужен, чтобы не выдать чужую тему за свою. */
interface ThemeCache {
  login: string | null;
  setting: AdminThemeSetting;
}

/** Годное значение выбора или null: всё нераспознанное — не выбор. */
function asSetting(value: unknown): AdminThemeSetting | null {
  if (value === 'system') return 'system';
  return isAdminThemeName(value) ? value : null;
}

/**
 * Прочитать кэш. Понимает и старую запись — голое имя темы без логина:
 * панель уже стоит у людей, и после обновления их выбор не должен пропасть.
 * Такая запись считается ничьей: её применяют до ответа сервера, но спорить
 * с сервером она не может.
 */
function readCache(): ThemeCache {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return { login: null, setting: DEFAULT_ADMIN_THEME };

  const plain = asSetting(raw);
  if (plain) return { login: null, setting: plain };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const setting = asSetting((parsed as { setting?: unknown }).setting);
      const login = (parsed as { login?: unknown }).login;
      if (setting) {
        return { login: typeof login === 'string' ? login : null, setting };
      }
    }
  } catch {
    // Испорченная запись — не повод падать: берём умолчание
  }
  return { login: null, setting: DEFAULT_ADMIN_THEME };
}

function writeCache(cache: ThemeCache): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(cache));
}

/** Что выбрано сейчас (из кэша) — до ответа сервера. */
export function readAdminThemeSetting(): AdminThemeSetting {
  return readCache().setting;
}

/**
 * Системная тема ОС. Тёмной соответствует ГРАФИТ, а не тёмная тема почты:
 * фирменная гамма панели не должна теряться от того, что человек выбрал
 * «как в системе».
 */
export function systemAdminTheme(): AdminThemeName {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'graphite';
  }
  return 'light';
}

/** Что реально применять при данном выборе. */
export function resolveAdminTheme(setting: AdminThemeSetting): AdminThemeName {
  return setting === 'system' ? systemAdminTheme() : setting;
}

/** Проставить тему на <html>: сам цвет задаёт CSS, здесь только признаки. */
export function applyAdminTheme(theme: AdminThemeName): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeKind = adminThemeMeta(theme).kind;
}

/* ------------------------------------------------------------------ */
/* Подписка: тему меняют из шапки, а знать о ней должны все            */
/* ------------------------------------------------------------------ */

let current: AdminThemeSetting = readCache().setting;
/** Кому принадлежит текущий выбор; null — ещё не знаем, кто вошёл. */
let owner: string | null = null;
const listeners = new Set<() => void>();

/** Куда отправлять выбор. Подменяется в проверках; по умолчанию — сервер. */
type Saver = (theme: AdminThemeSetting) => Promise<unknown>;
let saveToServer: Saver | null = null;

/**
 * Кому панель отдаёт выбор на хранение. Ставится один раз при запуске
 * (main.tsx), чтобы appearance/ не зависел от api/ — иначе проверки темы
 * тянули бы за собой весь клиент к серверу.
 */
export function setAdminThemeSaver(saver: Saver | null): void {
  saveToServer = saver;
}

export function getAdminThemeSetting(): AdminThemeSetting {
  return current;
}

export function subscribeAdminTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Выбрать тему: применить, положить в кэш, отправить на сервер.
 *
 * Ответа сервера НЕ ждём: цвет меняется мгновенно, иначе нажатие ощущается
 * подвисшим. Не сохранилось — тема останется до конца сеанса и в кэше,
 * а ошибку показывать незачем: на экране всё уже покрашено, и жаловаться
 * на неудавшуюся запись цвета значит пугать без дела.
 */
export function setAdminTheme(setting: AdminThemeSetting): void {
  current = setting;
  writeCache({ login: owner, setting });
  applyAdminTheme(resolveAdminTheme(setting));
  announce();
  void saveToServer?.(setting).catch(() => undefined);
}

/**
 * Пришёл ответ сервера: у этого администратора вот такая тема.
 *
 * `theme` — как есть из базы: null (не выбирал) или строка, которую панель
 * может и не знать. Незнакомое и пустое значит «умолчание».
 *
 * Возвращает применённую тему — по ней проверки видят, что именно
 * оказалось на экране.
 */
export function adoptServerTheme(login: string, theme: string | null): AdminThemeName {
  const fromServer = asSetting(theme);
  const cache = readCache();
  const sameAdmin = cache.login !== null && cache.login === login;

  /*
   * Сервер — источник истины. Кэш перевешивает его в одном случае: тема
   * ещё не доехала до сервера (например, запись не прошла), но выбор был
   * сделан ЭТИМ же администратором на этой машине. Чужой или ничей кэш
   * против сервера не играет никогда — иначе следующий администратор
   * увидел бы расцветку предыдущего.
   */
  const setting = fromServer ?? (sameAdmin ? cache.setting : DEFAULT_ADMIN_THEME);

  owner = login;
  current = setting;
  writeCache({ login, setting });
  const theme_ = resolveAdminTheme(setting);
  applyAdminTheme(theme_);
  announce();

  // Кэш был ничей (старая запись) или чужой, а на сервере пусто — значит
  // выбор этого администратора сервер ещё не видел. Досылаем, чтобы он
  // нашёлся на другом компьютере.
  if (!fromServer && sameAdmin) void saveToServer?.(setting).catch(() => undefined);

  return theme_;
}

/**
 * Выход из панели: кэш стирается, экран возвращается к умолчанию.
 *
 * Иначе следующий администратор за этим же компьютером увидел бы чужую
 * расцветку — ровно то, ради чего выбор и переехал на сервер.
 */
export function forgetAdminTheme(): void {
  owner = null;
  current = DEFAULT_ADMIN_THEME;
  storage()?.removeItem(STORAGE_KEY);
  applyAdminTheme(resolveAdminTheme(DEFAULT_ADMIN_THEME));
  announce();
}

/**
 * Применить тему из кэша при запуске. Зовётся из main.tsx до отрисовки:
 * иначе панель мигала бы графитом на каждой загрузке, пока идёт запрос
 * о сессии. Настоящий выбор приедет следом — adoptServerTheme().
 */
export function initAdminTheme(): AdminThemeName {
  const cache = readCache();
  current = cache.setting;
  owner = cache.login;
  const theme = resolveAdminTheme(current);
  applyAdminTheme(theme);

  // Пока выбрано «как в системе», переключение день/ночь в ОС подхватывается
  // на лету — перезагружать панель ради этого не нужно.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (current !== 'system') return;
      applyAdminTheme(systemAdminTheme());
      announce();
    });
  }
  return theme;
}

/** Список для переключателя: все темы реестра и «как в системе». */
export const ADMIN_THEME_OPTIONS: readonly { value: AdminThemeSetting; title: string }[] = [
  ...ADMIN_THEMES.map((theme) => ({ value: theme.id as AdminThemeSetting, title: theme.title })),
  { value: 'system', title: 'Как в системе' },
];
