/**
 * Расчёт контраста по WCAG 2.x — та же формула относительной яркости,
 * которой посчитаны числа в docs/brand.md.
 *
 * Живёт в src, а не в tests: одними и теми же функциями пользуются
 * проверки палитры и расчёт «наихудшего случая» для текста поверх
 * пользовательской фоновой картинки (см. themes.test).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** #RRGGBB → каналы 0–255. Короткую запись не принимаем — в палитре её нет. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (!m) throw new Error(`не hex-цвет: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Относительная яркость sRGB-цвета (WCAG 2.x, п. «relative luminance»). */
export function luminance(color: Rgb | string): number {
  const { r, g, b } = typeof color === 'string' ? hexToRgb(color) : color;
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Коэффициент контраста двух цветов, от 1 до 21. */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Полупрозрачный слой поверх подложки — итоговый непрозрачный цвет.
 * Нужен, чтобы честно посчитать читаемость белого текста на
 * полупрозрачной шапке и меню поверх фоновой картинки.
 */
export function composite(over: Rgb | string, alpha: number, under: Rgb | string): Rgb {
  const o = typeof over === 'string' ? hexToRgb(over) : over;
  const u = typeof under === 'string' ? hexToRgb(under) : under;
  const mix = (a: number, b: number): number => Math.round(a * alpha + b * (1 - alpha));
  return { r: mix(o.r, u.r), g: mix(o.g, u.g), b: mix(o.b, u.b) };
}
