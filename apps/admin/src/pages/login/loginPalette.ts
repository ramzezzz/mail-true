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
  /** Фон страницы: три остановки радиального перехода, от центра к краю. */
  bgCenter: '#16222a',
  bgMiddle: '#101a21',
  bgEdge: '#0b1218',

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

  /** Глобус: кружок узла (полупрозрачный) и значок в нём. */
  nodeSurface: '#12252c',
  nodeIcon: '#cfe6ea',

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
     * Кнопка входа — общий компонент из apps/web, свои цвета он берёт из
     * фирменных токенов. Подменяем токены на этой странице, а не правим
     * компонент: почте его синий нужен нетронутым.
     */
    '--mt-color-background-accent': LOGIN_PALETTE.accent,
    '--mt-color-background-accent-hover': LOGIN_PALETTE.accentHover,
    '--mt-color-background-accent-press': LOGIN_PALETTE.accentPress,
    '--mt-focus-ring-color': LOGIN_PALETTE.accent,
  };
}

/** Каналы точки созвездия для холста: холст рисует через rgba(), не через hex. */
export function dotRgbChannels(): string {
  const hex = LOGIN_PALETTE.dot;
  const n = parseInt(hex.slice(1), 16);
  return `${String((n >> 16) & 0xff)},${String((n >> 8) & 0xff)},${String(n & 0xff)}`;
}
