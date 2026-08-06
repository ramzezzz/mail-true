/**
 * Реестр тем оформления — единый источник истины.
 *
 * Отсюда берут значения:
 *   - переключатель темы в шапке и раздел «Оформление» настроек
 *     (названия и цвета образцов);
 *   - проверки контраста в tests/themes.test.ts — каждая тема из списка
 *     обязана проходить WCAG AA, иначе ей не место в наборе.
 *
 * Сами CSS-переменные живут в styles/themes.css: цветные темы меняют
 * ТОЛЬКО пять переменных акцента и фон страницы, компоненты о цветах
 * не знают. Значения здесь и в CSS обязаны совпадать — это тоже
 * проверяется тестом, чтобы реестр не разъехался со стилями.
 */

export type ThemeName =
  | 'light'
  | 'dark'
  | 'emerald'
  | 'violet'
  | 'coral'
  | 'lagoon'
  | 'sunset'
  | 'wallpaper';

/** Явный выбор пользователя; 'system' — следовать prefers-color-scheme. */
export type ThemeSetting = ThemeName | 'system';

export interface ThemeMeta {
  id: ThemeName;
  title: string;
  /** Светлая основа, тёмная или обои — определяет базовые цвета текста. */
  kind: 'light' | 'dark' | 'wallpaper';
  /** Акцент и его ступени (hover/press) — то, что тема переопределяет. */
  accent: string;
  accentHover: string;
  accentPress: string;
  /**
   * Подложка выделенной строки списка. Нейтрально-серая, как у mail.ru
   * (#EBECEF — пипетка по research/mailru/10-selection.png), а не тон
   * акцента: тема её не красит. Тёмная берёт свой нейтральный тон.
   */
  selection: string;
  /** Фон страницы вокруг белой карточки (для обоев — усреднённый тон). */
  appBg: string;
  /** Фон карточки контента. */
  contentBg: string;
  /** Основной текст на карточке. */
  textPrimary: string;
  /** Цвет текста на акцентной кнопке. */
  onAccent: string;
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: 'light',
    title: 'Светлая',
    kind: 'light',
    accent: '#006ec6',
    accentHover: '#005ca8',
    accentPress: '#004e8f',
    selection: '#ebecef',
    appBg: '#f0f1f3',
    contentBg: '#ffffff',
    textPrimary: '#2c2d2e',
    onAccent: '#ffffff',
  },
  {
    id: 'dark',
    title: 'Тёмная',
    kind: 'dark',
    accent: '#5ca8f5',
    accentHover: '#7cbaf7',
    accentPress: '#4694e3',
    selection: '#3a3a3b',
    appBg: '#19191a',
    contentBg: '#232324',
    textPrimary: '#e1e3e6',
    onAccent: '#15181d',
  },
  {
    id: 'emerald',
    title: 'Изумруд',
    kind: 'light',
    accent: '#047857',
    accentHover: '#03654a',
    accentPress: '#05543f',
    selection: '#ebecef',
    appBg: '#eaf3ee',
    contentBg: '#ffffff',
    textPrimary: '#2c2d2e',
    onAccent: '#ffffff',
  },
  {
    id: 'violet',
    title: 'Фиалка',
    kind: 'light',
    accent: '#6941c6',
    accentHover: '#5a35ad',
    accentPress: '#4c2c96',
    selection: '#ebecef',
    appBg: '#efecf9',
    contentBg: '#ffffff',
    textPrimary: '#2c2d2e',
    onAccent: '#ffffff',
  },
  {
    id: 'coral',
    title: 'Коралл',
    kind: 'light',
    accent: '#be185d',
    accentHover: '#a31450',
    accentPress: '#8c1145',
    selection: '#ebecef',
    appBg: '#faeef2',
    contentBg: '#ffffff',
    textPrimary: '#2c2d2e',
    onAccent: '#ffffff',
  },
  {
    id: 'lagoon',
    title: 'Лагуна',
    kind: 'light',
    accent: '#0e7490',
    accentHover: '#0c627a',
    accentPress: '#0a5266',
    selection: '#ebecef',
    appBg: '#e9f4f6',
    contentBg: '#ffffff',
    textPrimary: '#2c2d2e',
    onAccent: '#ffffff',
  },
  {
    id: 'sunset',
    title: 'Закат',
    kind: 'light',
    accent: '#c2410c',
    accentHover: '#a8380a',
    accentPress: '#8f2f09',
    selection: '#ebecef',
    appBg: '#f7efe9',
    contentBg: '#ffffff',
    textPrimary: '#2c2d2e',
    onAccent: '#ffffff',
  },
  {
    // Обойная тема: акцент и карточка — как в светлой, вокруг — картинка.
    // appBg здесь — цвет-заглушка под картинкой (как у mail.ru).
    id: 'wallpaper',
    title: 'С картинкой',
    kind: 'wallpaper',
    accent: '#006ec6',
    accentHover: '#005ca8',
    accentPress: '#004e8f',
    selection: '#ebecef',
    appBg: '#4d4d4d',
    contentBg: '#ffffff',
    textPrimary: '#2c2d2e',
    onAccent: '#ffffff',
  },
];

export const THEME_IDS: readonly ThemeName[] = THEMES.map((t) => t.id);

export function themeMeta(id: ThemeName): ThemeMeta {
  const meta = THEMES.find((t) => t.id === id);
  if (!meta) throw new Error(`неизвестная тема: ${id}`);
  return meta;
}

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

/**
 * Затемняющие слои «обойной» темы. Числа не украшение, а гарантия
 * читаемости в наихудшем случае — когда пользователь поставил фоном
 * чисто белую фотографию:
 *
 *   - dim ложится на картинку целиком;
 *   - шапка — чёрный 0.40 поверх (как у mail.ru);
 *   - за левым меню — ещё один слой поверх dim.
 *
 * Белый текст шапки и меню обязан держать 4.5:1 даже на белой картинке —
 * это считается в tests/themes.test.ts из этих же констант.
 */
export const WALLPAPER_SCRIM = {
  /** Цвет затемнения (тёмно-синий, а не чёрный — не глушит цвета фото). */
  tint: '#091022',
  /** Доля затемнения всей картинки. */
  dim: 0.3,
  /** Дополнительный слой за левым меню. */
  sidebar: 0.42,
  /** Чёрная полупрозрачная шапка (значение mail.ru). */
  header: 0.4,
  /** Непрозрачный фон выдвижного ящика папок на узком экране. */
  drawerBg: '#232a38',
} as const;

/**
 * Полупрозрачные подложки «обойной» темы.
 *
 * Требование заказчика: картинку должно быть видно не только под левым
 * меню — таблица писем, окно настроек и меню обязаны просвечивать.
 * До этого белая карточка контента закрывала фотографию целиком.
 *
 * Числа не подобраны на глаз. Наихудший фон для тёмного текста на
 * светлой подложке — СПЛОШЬ ЧЁРНАЯ фотография: подложка светлеет не до
 * белого, а до #DCDCDD, и мейловые серые проваливаются ниже 2.2:1.
 * Значения ниже подобраны расчётом так, чтобы в этом наихудшем случае
 * обычный текст держал 4.5:1, а нетекстовые элементы — 3:1
 * (tests/wallpaperSurfaces.test.ts считает это из этих же констант).
 *
 * Размытия (backdrop-filter) в наборе нет намеренно: оно стоит дорого
 * именно на длинном списке писем, а читаемость здесь обеспечена
 * непрозрачностью, а не размытием.
 */
export const WALLPAPER_SURFACE = {
  /**
   * Доля непрозрачности карточки почты и страницы настроек.
   *
   * 0.78 — не «красивое число», а нижняя граница, при которой ещё
   * сохраняется РАЗНИЦА между основным и вторичным текстом. Ниже 0.70
   * вторичному серому приходится быть таким тёмным, что он сливается
   * с основным, и список писем теряет свою иерархию: отправитель, тема
   * и отрывок становятся одинаковыми на вид.
   */
  alpha: 0.78,
  /** Меню, выпадающие панели и модальные окна — плотнее. */
  floatAlpha: 0.9,
  /** Карточка внутри страницы настроек (лежит на её подложке). */
  settingsCardAlpha: 0.55,
  /** Накладка строки списка под курсором. */
  rowHover: 0.05,
  /** Накладка выделенной строки списка. */
  rowSelected: 0.12,
  /** Цвет обеих накладок (мейловый «прозрачный тёмный»). */
  rowTint: '#00103d',
  /** Вторичный текст: на ступень темнее мейлового #93969B. */
  secondaryText: '#515458',
  /** Третичный текст и вторичные значки — им WCAG требует 3:1. */
  tertiaryText: '#6c6f73',
  /** Акцент: #006EC6 на такой подложке даёт лишь 3.03:1. */
  accent: '#004e8f',
} as const;
