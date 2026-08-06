/**
 * Реестр тем оформления панели управления — единый источник истины.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ОТДЕЛЬНЫЙ РЕЕСТР, А НЕ ИМПОРТ ИЗ ПОЧТЫ
 * ------------------------------------------------------------------
 * Дизайн-система одна: те же токены --mt-*, тот же признак data-theme на
 * <html>, те же значения акцентов, что в apps/web/src/appearance/themes.ts.
 * Второго набора цветов здесь нет — светлые темы берут акценты почты слово
 * в слово.
 *
 * Но проверять в панели нужно ДРУГИЕ пары. Почта набрана крупнее, а здесь
 * 11–13px на плотной таблице, свои служебные цвета состояний и цветные
 * строки журнала. Поэтому реестр перечисляет не «акцент и фон», а всё, на
 * чём в панели лежит текст: поверхность, подложка страницы, подложка
 * активного пункта меню, тонированные плашки, строки журнала. Из этих же
 * значений считает контраст tests/adminThemes.test.ts — по формуле WCAG 2.1,
 * а не сверкой со списком «правильных» строк.
 *
 * ------------------------------------------------------------------
 * СВОЯ ГАММА ПАНЕЛИ
 * ------------------------------------------------------------------
 * Тема «Графит» — фирменная для панели и стоит по умолчанию. Это не копия
 * тёмной темы почты: она продолжает гамму страницы входа (графит и бирюза,
 * pages/login/loginPalette.ts). Администратор с первого взгляда видит, что
 * открыл панель управления, а не почту, — ровно того заказчик и просил.
 * Тёмная тема почты («Тёмная») тоже доступна: обе собраны из одних токенов.
 *
 * Значения отсюда обязаны совпадать с styles/adminThemes.css и
 * styles/logLevels.css — это тоже проверка, иначе реестр разъедется
 * со стилями и в панели окажется цвет, который никто не считал.
 */

import { LOG_LEVELS, type LevelColors, type LogLevel } from '../lib/logLevels';

export type AdminThemeName =
  'graphite' | 'light' | 'dark' | 'emerald' | 'violet' | 'coral' | 'lagoon' | 'sunset';

/** Явный выбор администратора; 'system' — следовать prefers-color-scheme. */
export type AdminThemeSetting = AdminThemeName | 'system';

export interface AdminThemeMeta {
  id: AdminThemeName;
  title: string;
  /** Светлая основа или тёмная — от этого зависят цвета текста и логотип. */
  kind: 'light' | 'dark';
  /** Заливка первичной кнопки и значка администратора. */
  accent: string;
  accentHover: string;
  accentPress: string;
  /** Текст на акцентной заливке. */
  onAccent: string;
  /**
   * Цвет ссылок и активного пункта меню.
   *
   * На светлом это САМАЯ ТЁМНАЯ ступень акцента, а не сам акцент: пункт
   * лежит на тонированной акцентом подложке, и на ней акцент себя не
   * показывает. На тёмном наоборот — ink совпадает с акцентом.
   */
  ink: string;
  /** Фон страницы вокруг карточек (--mt-app-bg). */
  appBg: string;
  /** Карточка, таблица, шапка, левое меню (--mt-color-background-content). */
  surface: string;
  /** Вторая поверхность: плашка администратора, наведение, погашенная кнопка. */
  surfaceAlt: string;
  textPrimary: string;
  textSecondary: string;
  /** Служебные состояния: «работает», «внимание», «не отвечает». */
  ok: string;
  warn: string;
  fail: string;
  /** Тонированные подложки под теми же состояниями. */
  okTint: string;
  failTint: string;
  /** Цвета строк журнала почты — по уровню сообщения. */
  log: Readonly<Record<LogLevel, LevelColors>>;
}

/**
 * Доля акцента в подложке активного пункта меню.
 *
 * Раньше подложка была прибита к синему rgba(0,119,255,.2) из выгрузки
 * токенов: при любой теме пилюля оставалась синей, а в изумрудной ещё и
 * спорила с зелёным акцентом. Теперь это акцент ТЕМЫ, разбавленный
 * поверхностью, и долю знает и CSS (color-mix), и проверка контраста —
 * иначе считать было бы нечего.
 *
 * 0.14, а не прежние 0.20: на 0.20 светло-синий акцент тёмной темы давал
 * себе же 4,37:1 на собственной подложке.
 */
export const NAV_ACTIVE_ALPHA = 0.14;

/** Цвета строк журнала для семейства тем — из реестра уровней. */
function logOf(kind: 'light' | 'dark'): Readonly<Record<LogLevel, LevelColors>> {
  return Object.fromEntries(LOG_LEVELS.map((level) => [level.id, level[kind]])) as Record<
    LogLevel,
    LevelColors
  >;
}

/**
 * Поправки для мелкого шрифта, общие всем светлым темам.
 *
 * Палитровый вторичный #87898F даёт 3,50:1 на белом — им подписаны плитки
 * сводки, заголовки таблиц и роль в шапке. Служебные цвета взяты из палитры
 * и доведены до нормы (пояснения и замеры — в styles/admin.css).
 */
const LIGHT_INK = {
  textPrimary: '#2c2d2e',
  textSecondary: '#63666b',
  ok: '#0a7b44',
  warn: '#8a5200',
  fail: '#c42500',
  okTint: '#ecfaf3',
  failTint: '#feefeb',
  surface: '#ffffff',
  surfaceAlt: '#f0f1f3',
  onAccent: '#ffffff',
} as const;

/** Светлая тема почты и её цветные варианты — акценты слово в слово из почты. */
function lightTheme(
  id: AdminThemeName,
  title: string,
  accent: string,
  accentHover: string,
  accentPress: string,
  appBg: string,
  ink = accentPress,
): AdminThemeMeta {
  return {
    id,
    title,
    kind: 'light',
    accent,
    accentHover,
    accentPress,
    ink,
    appBg,
    ...LIGHT_INK,
    log: logOf('light'),
  };
}

export const ADMIN_THEMES: readonly AdminThemeMeta[] = [
  {
    /*
     * Фирменная гамма панели: графит и бирюза со страницы входа.
     * Поверхность #16222A — тот самый --mt-adm-login-bg-center, с которого
     * начинается вход: панель и вход выглядят одним продуктом.
     */
    id: 'graphite',
    title: 'Графит',
    kind: 'dark',
    accent: '#3ec7cf',
    accentHover: '#62d5db',
    accentPress: '#2fb2ba',
    onAccent: '#06171a',
    ink: '#3ec7cf',
    appBg: '#0d151a',
    surface: '#16222a',
    surfaceAlt: '#1e2c35',
    textPrimary: '#e4ecef',
    textSecondary: '#9fb4bc',
    ok: '#5fd69f',
    warn: '#f2c469',
    fail: '#ff9d88',
    okTint: '#0f2d24',
    failTint: '#38211e',
    /*
     * Журнал в графите — свои подложки, не мейловские: тёмные строки почты
     * нейтрально-серые и посреди графитовой карточки читались бы заплаткой.
     * Тона те же (красный, оранжевый), холоднее только основа.
     */
    log: {
      error: { text: '#ff9d88', background: '#3a1f1b' },
      warn: { text: '#f2c469', background: '#352c17' },
      info: { text: '#e4ecef', background: '#16222a' },
      debug: { text: '#9fb4bc', background: '#1e2c35' },
    },
  },
  lightTheme(
    'light',
    'Светлая',
    '#006ec6',
    '#005ca8',
    '#004e8f',
    '#f0f1f3',
    // Светлая досталась в наследство со своим синим #0059C2: он подобран
    // и измерен раньше (styles/admin.css), менять его не на что.
    '#0059c2',
  ),
  {
    /* Тёмная тема почты — для тех, кто держит открытыми оба приложения. */
    id: 'dark',
    title: 'Тёмная',
    kind: 'dark',
    accent: '#5ca8f5',
    accentHover: '#7cbaf7',
    accentPress: '#4694e3',
    onAccent: '#15181d',
    ink: '#5ca8f5',
    appBg: '#19191a',
    surface: '#232324',
    surfaceAlt: '#2c2d2e',
    textPrimary: '#e1e3e6',
    // #8C8E94 из тёмной темы почты даёт 4,21:1 на третичной подложке —
    // почте хватает, панели с её 11px нет. Тот же тон, светлее на ступень.
    textSecondary: '#9ea1a6',
    ok: '#5fd693',
    warn: '#f5c164',
    fail: '#ff9c85',
    okTint: '#12301f',
    failTint: '#3b1f1a',
    log: logOf('dark'),
  },
  lightTheme('emerald', 'Изумруд', '#047857', '#03654a', '#05543f', '#eaf3ee'),
  lightTheme('violet', 'Фиалка', '#6941c6', '#5a35ad', '#4c2c96', '#efecf9'),
  lightTheme('coral', 'Коралл', '#be185d', '#a31450', '#8c1145', '#faeef2'),
  lightTheme('lagoon', 'Лагуна', '#0e7490', '#0c627a', '#0a5266', '#e9f4f6'),
  lightTheme('sunset', 'Закат', '#c2410c', '#a8380a', '#8f2f09', '#f7efe9'),
];

export const ADMIN_THEME_IDS: readonly AdminThemeName[] = ADMIN_THEMES.map((theme) => theme.id);

export function adminThemeMeta(id: AdminThemeName): AdminThemeMeta {
  const meta = ADMIN_THEMES.find((theme) => theme.id === id);
  if (!meta) throw new Error(`неизвестная тема панели: ${id}`);
  return meta;
}

export function isAdminThemeName(value: unknown): value is AdminThemeName {
  return typeof value === 'string' && (ADMIN_THEME_IDS as readonly string[]).includes(value);
}

/**
 * Подложка активного пункта меню — акцент темы, разбавленный поверхностью.
 * Считается здесь, а не в тесте: CSS смешивает ровно так же (color-mix),
 * и цвет, на котором лежит подпись пункта, должен быть один и тот же.
 */
export function navActiveBackground(theme: AdminThemeMeta): string {
  const channels = (hex: string): number[] => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  };
  const over = channels(theme.accent);
  const under = channels(theme.surface);
  return `#${over
    .map((value, i) =>
      Math.round(value * NAV_ACTIVE_ALPHA + under[i]! * (1 - NAV_ACTIVE_ALPHA))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
