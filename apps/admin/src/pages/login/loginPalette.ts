/**
 * Гамма страницы входа в панель управления — «графит и бирюза».
 *
 * Почта встречает человека фирменным синим. Панель управления намеренно
 * встречает другим: холодный графит вместо синего неба и глубокая бирюза
 * вместо True Blue. Администратор с первого взгляда видит, что открыл
 * не почту, — и не вводит вслепую почтовый пароль.
 *
 * Цвета живут здесь, а не в CSS, по одной причине: их же читает проверка
 * контраста (tests/loginPalette.test.ts). Разложи их по двум местам — и
 * однажды в CSS окажется цвет, который никто не считал. Из этого файла
 * значения попадают в разметку как CSS-переменные (`paletteVars`), а CSS
 * берёт их через `var()`.
 */

/** Цвета входа в панель. Только полная запись #RRGGBB — её понимает счётчик. */
export const LOGIN_PALETTE = {
  /** Фон страницы: четыре остановки радиального перехода, от центра к краю. */
  bgCenter: '#16222a',
  bgMiddle: '#101a21',
  bgEdge: '#0b1218',
  /**
   * Самый край. Появился вместе с новым фоном прототипа: раньше переход
   * заканчивался на bgEdge, теперь у него есть ещё одна, более глубокая
   * ступень — на ней белая карточка и звёзды читаются лучше.
   */
  bgDeep: '#070c10',

  /** Действие: кнопка входа, обводка фокуса, галочка. */
  accent: '#0f6a72',
  accentHover: '#0b565d',
  accentPress: '#08444a',

  /** Текст на белой карточке. */
  ink: '#111a1f',
  inkMuted: '#4c5c66',
  card: '#ffffff',

  /** Текст подвала поверх тёмного фона. */
  footer: '#9db8c1',

  /** Созвездие: точки и линии по тёмному фону. */
  dot: '#8fb3bd',

  /** Звёзды заднего слоя — холоднее и светлее точек паутины. */
  star: '#dcecf0',

  /** Волновая сетка в углу. */
  mesh: '#7aa8b2',

  /** Глобус: кружок узла (полупрозрачный) и значок в нём. */
  nodeSurface: '#12252c',
  nodeIcon: '#cfe6ea',

  /** Светящийся шар, бегущий по кольцу сферы. */
  ball: '#8fe0e8',

  /** Отказ во входе: текст и подложка сообщения. */
  danger: '#8c1d18',
  dangerSurface: '#fdecec',
} as const;

/** Прозрачность кружка узла глобуса. Нужна и CSS, и честному счёту контраста. */
export const NODE_SURFACE_ALPHA = 0.72;

/** Прозрачность точек созвездия. */
export const DOT_ALPHA = 0.75;

/**
 * Палитра как набор CSS-переменных для корня страницы.
 * Так значения не приходится дублировать в таблице стилей.
 */
export function paletteVars(): Record<string, string> {
  return {
    '--mt-adm-login-bg-center': LOGIN_PALETTE.bgCenter,
    '--mt-adm-login-bg-middle': LOGIN_PALETTE.bgMiddle,
    '--mt-adm-login-bg-edge': LOGIN_PALETTE.bgEdge,
    '--mt-adm-login-bg-deep': LOGIN_PALETTE.bgDeep,
    /* Подсветка верхнего левого угла — там, где стоит сфера. */
    '--mt-adm-login-bg-glow': rgba(LOGIN_PALETTE.accent, 0.3),
    '--mt-adm-login-accent': LOGIN_PALETTE.accent,
    '--mt-adm-login-accent-hover': LOGIN_PALETTE.accentHover,
    '--mt-adm-login-accent-press': LOGIN_PALETTE.accentPress,
    '--mt-adm-login-ink': LOGIN_PALETTE.ink,
    '--mt-adm-login-ink-muted': LOGIN_PALETTE.inkMuted,
    '--mt-adm-login-card': LOGIN_PALETTE.card,
    '--mt-adm-login-footer': LOGIN_PALETTE.footer,
    '--mt-adm-login-node': LOGIN_PALETTE.nodeSurface,
    '--mt-adm-login-node-alpha': String(NODE_SURFACE_ALPHA),
    '--mt-adm-login-node-icon': LOGIN_PALETTE.nodeIcon,
    '--mt-adm-login-danger': LOGIN_PALETTE.danger,
    '--mt-adm-login-danger-surface': LOGIN_PALETTE.dangerSurface,
    /*
     * Сцена со сферой — общий компонент из apps/web (pages/login). Её цвета
     * заданы переменными `--mt-login-*` с синими значениями по умолчанию;
     * здесь мы подменяем их на свои. Компонент от этого не знает ничего про
     * панель управления, а панель не держит второй копии той же сцены.
     */
    '--mt-login-aura': rgba(LOGIN_PALETTE.accent, 0.24),
    '--mt-login-aura-ring': rgba(LOGIN_PALETTE.dot, 0.1),
    '--mt-login-aura-ring-far': rgba(LOGIN_PALETTE.dot, 0.07),
    '--mt-login-ring': rgba(LOGIN_PALETTE.dot, 0.28),
    '--mt-login-ring-bright': rgba(LOGIN_PALETTE.nodeIcon, 0.44),
    '--mt-login-node-bg': rgba(LOGIN_PALETTE.nodeSurface, NODE_SURFACE_ALPHA),
    '--mt-login-node-border': rgba(LOGIN_PALETTE.dot, 0.45),
    '--mt-login-node-icon': LOGIN_PALETTE.nodeIcon,
    '--mt-login-node-glow': rgba(LOGIN_PALETTE.accent, 0.45),
    '--mt-login-center-core': rgba(LOGIN_PALETTE.accent, 0.6),
    '--mt-login-center-shell': rgba(LOGIN_PALETTE.nodeSurface, 0.78),
    '--mt-login-center-border': rgba(LOGIN_PALETTE.nodeIcon, 0.7),
    '--mt-login-center-glow': rgba(LOGIN_PALETTE.accent, 0.55),
    '--mt-login-center-glow-peak': rgba(LOGIN_PALETTE.ball, 0.55),
    '--mt-login-center-inner': rgba(LOGIN_PALETTE.dot, 0.35),
    '--mt-login-center-inner-peak': rgba(LOGIN_PALETTE.nodeIcon, 0.45),
    '--mt-login-ball-mid': rgba(LOGIN_PALETTE.ball, 0.95),
    '--mt-login-ball-edge': rgba(LOGIN_PALETTE.accent, 0.6),
    '--mt-login-ball-halo': rgba(LOGIN_PALETTE.ball, 0.75),
    /*
     * Кнопка входа — общий компонент из apps/web, свои цвета он берёт из
     * фирменных токенов. Подменяем токены на этой странице, а не правим
     * компонент: почте его синий нужен нетронутым.
     */
    '--mt-color-background-accent': LOGIN_PALETTE.accent,
    '--mt-color-background-accent-hover': LOGIN_PALETTE.accentHover,
    '--mt-color-background-accent-press': LOGIN_PALETTE.accentPress,
    '--mt-focus-ring-color': LOGIN_PALETTE.accent,
    /*
     * Вход не участвует в темах — у него СВОЯ гамма, посчитанная целиком.
     * Пока тем не было, это подразумевалось само собой; с ними страница
     * стала ломаться: в тёмной теме белая карточка получала белый текст
     * (--mt-color-text-primary), а подчёркивание поля — светлый разделитель
     * на белом, то есть исчезало. Поэтому нейтральные токены, на которые
     * опирается карточка, пришпилены к светлым значениям.
     */
    '--mt-color-text-primary': LOGIN_PALETTE.ink,
    '--mt-color-text-secondary': LOGIN_PALETTE.inkMuted,
    '--mt-color-text-contrast': LOGIN_PALETTE.card,
    '--mt-color-background-content': LOGIN_PALETTE.card,
    '--mt-color-separator-primary': '#dfe4ea',
  };
}

/** Каналы цвета для холста: холст рисует через rgba(), а не через hex. */
export function rgbChannels(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${String((n >> 16) & 0xff)},${String((n >> 8) & 0xff)},${String(n & 0xff)}`;
}

/** Каналы точки созвездия. Оставлено отдельным именем — так его зовут проверки. */
export function dotRgbChannels(): string {
  return rgbChannels(LOGIN_PALETTE.dot);
}

/**
 * Цвет с прозрачностью для CSS.
 *
 * Полупрозрачные цвета сцены собираются здесь, а не пишутся в CSS руками:
 * иначе на странице оказался бы оттенок, которого нет в палитре и контраст
 * которого никто не считал.
 */
function rgba(hex: string, alpha: number): string {
  return `rgba(${rgbChannels(hex)},${String(alpha)})`;
}

/** Гамма фона для холста: точки паутины, звёзды и волновая сетка. */
export function constellationLook(): { web: string; star: string; mesh: string } {
  return {
    web: rgbChannels(LOGIN_PALETTE.dot),
    star: rgbChannels(LOGIN_PALETTE.star),
    mesh: rgbChannels(LOGIN_PALETTE.mesh),
  };
}
