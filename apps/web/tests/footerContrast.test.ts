/**
 * Контраст нижней строки состояния — во ВСЕХ восьми темах оформления.
 *
 * Числа здесь СЧИТАЮТСЯ по формуле WCAG 2.1 из настоящих значений в CSS
 * и в реестре тем, а не сверяются со списком «правильных» цветов. Образец
 * такого подхода — apps/admin/tests/logContrast.test.ts и tests/themes.test.ts.
 *
 * Проверка не теоретическая. Общий --mt-color-text-secondary (#87898F),
 * которым красится вся мелочь в интерфейсе, даёт на белой карточке
 * 3,50:1 — если строку состояния покрасить «как принято», она станет
 * первым местом в продукте, не берущим WCAG AA. На старом коде падает
 * весь файл: ни строки состояния, ни её стилей не существовало.
 *
 * Поверхностей под строкой три, а не одна:
 *   - белая карточка #FFFFFF (light, emerald, violet, coral, lagoon, sunset);
 *   - тёмная карточка #232324 (dark);
 *   - ПОЛУПРОЗРАЧНАЯ карточка «обойной» темы, под которой лежит фотография
 *     пользователя. Постоянного цвета у неё нет вовсе, поэтому считается
 *     наихудший случай — сплошь чёрное фото, на котором подложка светлеет
 *     меньше всего, — и заодно самый светлый, сплошь белое фото. Модель та
 *     же, что в tests/wallpaperSurfaces.test.ts, и берётся из тех же
 *     констант: разъехаться им не даст ни один из двух файлов.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, type Rgb } from '../src/appearance/contrast';
import { THEMES, WALLPAPER_SCRIM, WALLPAPER_SURFACE } from '../src/appearance/themes';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const css = readFileSync(join(SRC, 'layout/Footer.module.css'), 'utf8');
const themesCss = readFileSync(join(SRC, 'styles/themes.css'), 'utf8');

/** Тело правила по его селектору (первое вхождение). */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(selector);
  expect(at, `нет правила ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at);
  return source.slice(open + 1, source.indexOf('}', open));
}

/** Какой набор переменных строки состояния действует в теме. */
type Palette = 'light' | 'dark' | 'wallpaper';

const paletteSelector: Record<Palette, string> = {
  light: '.footer {',
  dark: ":global(html[data-theme='dark']) .footer",
  wallpaper: ":global(html[data-theme='wallpaper']) .footer",
};

/** Цвет переменной строки состояния (только сплошной). */
function footerColor(palette: Palette, name: string): string {
  const body = ruleBody(css, paletteSelector[palette]);
  const found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'u').exec(body);
  expect(found?.[1], `в наборе «${palette}» нет цвета ${name}`).toBeDefined();
  return found![1]!.toLowerCase();
}

/** Дорожка шкалы «обойной» темы — затемнение, а не цвет: цвет и доля. */
function wallpaperTrackTint(): { tint: string; alpha: number } {
  const body = ruleBody(css, paletteSelector.wallpaper);
  const found = /--mt-footer-track:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/u.exec(body);
  expect(found, 'дорожка обойной темы должна быть полупрозрачной').not.toBeNull();
  const [, r, g, b, a] = found!;
  const hex = (v: string): string => Number(v).toString(16).padStart(2, '0');
  return { tint: `#${hex(r!)}${hex(g!)}${hex(b!)}`, alpha: Number(a) };
}

/** Действующий акцент темы: у «обойной» он свой в themes.css. */
function themeAccent(id: string, fallback: string): string {
  if (id === 'light') return fallback;
  const at = themesCss.indexOf(`[data-theme='${id}']`);
  if (at < 0) return fallback;
  const open = themesCss.indexOf('{', at);
  const block = themesCss.slice(open + 1, themesCss.indexOf('}', open));
  const found = /--mt-accent:\s*(#[0-9a-fA-F]{6})/u.exec(block);
  return (found?.[1] ?? fallback).toLowerCase();
}

/* --- Поверхность «обойной» темы --------------------------------------- */

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Фотография после общего затемнения темы, затем полупрозрачная карточка. */
function wallpaperSurface(photo: Rgb): Rgb {
  const dimmed = composite(WALLPAPER_SCRIM.tint, WALLPAPER_SCRIM.dim, photo);
  return composite('#ffffff', WALLPAPER_SURFACE.alpha, dimmed);
}

/** Наихудшая и самая светлая подложки «обойной» темы. */
const WALLPAPER_SURFACES: Array<[what: string, bg: Rgb]> = [
  ['сплошь чёрное фото', wallpaperSurface(BLACK)],
  ['сплошь белое фото', wallpaperSurface(WHITE)],
];

/** Все подложки темы: у обычных одна, у «обойной» — крайние случаи. */
function surfaces(id: string, contentBg: string): Array<[what: string, bg: Rgb | string]> {
  if (id === 'wallpaper') return WALLPAPER_SURFACES;
  return [['карточка', contentBg]];
}

function palette(id: string): Palette {
  if (id === 'dark') return 'dark';
  if (id === 'wallpaper') return 'wallpaper';
  return 'light';
}

/** Норма WCAG AA: текст 4,5:1, нетекстовые элементы 3:1 (1.4.11). */
const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

/** Подложка кнопки «Обновить» под курсором. Значения из styles/themes.css. */
const HOVER_BG: Record<Palette, string | null> = {
  light: '#f0f1f3',
  dark: '#232324',
  // В «обойной» теме и она полупрозрачна — проверяется на самой подложке
  wallpaper: null,
};

describe('строка состояния читается в каждой теме', () => {
  for (const theme of THEMES) {
    describe(`${theme.id} («${theme.title}»)`, () => {
      const kind = palette(theme.id);
      const accent = themeAccent(theme.id, theme.accent);

      for (const [what, bg] of surfaces(theme.id, theme.contentBg)) {
        it(`${what}: основной текст ≥ 4,5:1`, () => {
          const color = footerColor(kind, '--mt-footer-text');
          const value = contrastRatio(color, bg);
          expect(value, `${color} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
        });

        it(`${what}: слова об отказе связи ≥ 4,5:1`, () => {
          const color = footerColor(kind, '--mt-footer-alert');
          const value = contrastRatio(color, bg);
          expect(value, `${color} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
        });

        it(`${what}: кнопка «Обновить» ≥ 4,5:1`, () => {
          const value = contrastRatio(accent, bg);
          expect(value, `${accent} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
        });

        it(`${what}: шкала занятого места — заливка к дорожке ≥ 3:1`, () => {
          // Шкала не текст, ей WCAG 1.4.11 требует 3:1, а не 4,5:1.
          // Само число при этом всегда написано словами рядом.
          const track =
            theme.id === 'wallpaper'
              ? composite(wallpaperTrackTint().tint, wallpaperTrackTint().alpha, bg)
              : footerColor(kind, '--mt-footer-track');
          const fill = contrastRatio(accent, track);
          expect(fill, `заливка ${accent} = ${fill.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            NON_TEXT_MIN,
          );
          const alert = footerColor(kind, '--mt-footer-alert');
          const full = contrastRatio(alert, track);
          expect(full, `тревожная заливка ${alert} = ${full.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            NON_TEXT_MIN,
          );
        });
      }

      const hover = HOVER_BG[kind];
      if (hover) {
        it('кнопка «Обновить» ≥ 4,5:1 и под курсором', () => {
          const value = contrastRatio(accent, hover);
          expect(value, `${accent} на ${hover} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            TEXT_MIN,
          );
        });
      }
    });
  }
});

describe('дорожка шкалы видна на своей подложке', () => {
  /*
   * Требование мягче текстового: это различение поверхностей. Мерка —
   * та же, что даёт сплошной #DADCE0 на белом в светлой теме (1,37:1):
   * полоса должна читаться как полоса.
   */
  const MIN_BAND = 1.3;

  it('в светлой и тёмной темах', () => {
    for (const [kind, bg] of [
      ['light', '#ffffff'],
      ['dark', '#232324'],
    ] as Array<[Palette, string]>) {
      const track = footerColor(kind, '--mt-footer-track');
      const value = contrastRatio(track, bg);
      expect(value, `${kind}: ${track} на ${bg} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        MIN_BAND,
      );
    }
  });

  it('в «обойной» теме — на любой фотографии', () => {
    // Сплошной серый здесь пропадал: #DADCE0 на светлой подложке даёт
    // 1,22:1. Затемнение работает одинаково поверх чего угодно.
    const { tint, alpha } = wallpaperTrackTint();
    for (const [what, bg] of WALLPAPER_SURFACES) {
      const value = contrastRatio(composite(tint, alpha, bg), bg);
      expect(value, `${what}: дорожка = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN_BAND);
    }
  });
});

describe('почему цвета свои, а не общие', () => {
  it('общий --mt-color-text-secondary не взял бы норму — потому он и не взят', () => {
    // #87898F из styles/tokens.css: на белой карточке 3,50:1 при норме 4,5
    expect(contrastRatio('#87898f', '#ffffff')).toBeLessThan(TEXT_MIN);
    expect(css).not.toMatch(/color:\s*var\(--mt-color-text-secondary\)/u);
  });

  it('прозрачности, съедающей контраст, у текста нет', () => {
    // opacity 0.85 роняет #6B6E76 на белом с 5,10:1 до 3,72:1
    expect(css).not.toMatch(/opacity:\s*0?\.\d/u);
  });

  it('в «обойной» теме текст строки — тот же, что и во всей теме', () => {
    // Иначе подвал выбивался бы из темы, а расчёт разъехался бы с
    // tests/wallpaperSurfaces.test.ts
    expect(footerColor('wallpaper', '--mt-footer-text')).toBe(
      WALLPAPER_SURFACE.secondaryText.toLowerCase(),
    );
  });

  it('у каждой поверхности свой набор, а не унаследованный', () => {
    for (const name of ['--mt-footer-text', '--mt-footer-alert']) {
      expect(footerColor('dark', name), name).not.toBe(footerColor('light', name));
      expect(footerColor('wallpaper', name), name).not.toBe(footerColor('light', name));
    }
  });
});
