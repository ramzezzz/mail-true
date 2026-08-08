/**
 * Контраст нижней строки состояния — во ВСЕХ темах оформления, светлых и
 * тёмных.
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
 * Поверхностей под строкой четыре, а не одна:
 *   - белая карточка #FFFFFF (все светлые темы);
 *   - тёмная карточка #232324 (всё тёмное семейство);
 *   - ПОЛУПРОЗРАЧНАЯ карточка «обойной» темы, под которой лежит фотография
 *     пользователя. Постоянного цвета у неё нет вовсе, поэтому считаются
 *     оба крайних случая — сплошь чёрное и сплошь белое фото. Модель та
 *     же, что в tests/wallpaperSurfaces.test.ts, и берётся из тех же
 *     констант: разъехаться им не даст ни один из двух файлов;
 *   - полупрозрачная ТЁМНАЯ карточка обойной тёмной темы: там наихудший
 *     случай зеркальный — белое фото, на котором подложка светлеет
 *     сильнее всего и светлому тексту не на чем держаться.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, type Rgb } from '../src/appearance/contrast';
import {
  THEMES,
  WALLPAPER_DARK_SURFACE,
  WALLPAPER_SCRIM,
  WALLPAPER_SURFACE,
} from '../src/appearance/themes';

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

/**
 * Какой набор переменных строки состояния действует в теме.
 *
 * Наборов четыре, а тем четырнадцать: у всех светлых карточка белая, у
 * всего тёмного семейства — #232324, и только у двух обойных тем
 * постоянного цвета нет вовсе. Тёмное семейство ловится в CSS по суффиксу
 * имени (`-dark`), а не перечислением — иначе список приходилось бы
 * дописывать при каждой новой тёмной теме.
 */
type Palette = 'light' | 'dark' | 'wallpaper' | 'wallpaper-dark';

const paletteSelector: Record<Palette, string> = {
  light: '.footer {',
  dark: ":global(html[data-theme$='dark']) .footer",
  wallpaper: ":global(html[data-theme='wallpaper']) .footer",
  'wallpaper-dark': ":global(html[data-theme='wallpaper-dark']) .footer",
};

/** Цвет переменной строки состояния (только сплошной). */
function footerColor(palette: Palette, name: string): string {
  const body = ruleBody(css, paletteSelector[palette]);
  const found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'u').exec(body);
  expect(found?.[1], `в наборе «${palette}» нет цвета ${name}`).toBeDefined();
  return found![1]!.toLowerCase();
}

/**
 * Дорожка шкалы обойных тем — не цвет, а ПЛЁНКА: цвет и доля.
 * У светлой она затемняющая, у тёмной осветляющая — сплошной серый
 * пропадал бы и там, и там, а плёнка одинаково работает поверх любой
 * фотографии.
 */
function wallpaperTrackTint(palette: Palette = 'wallpaper'): { tint: string; alpha: number } {
  const body = ruleBody(css, paletteSelector[palette]);
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
function wallpaperSurface(photo: Rgb, card = '#ffffff', alpha = WALLPAPER_SURFACE.alpha): Rgb {
  const dimmed = composite(WALLPAPER_SCRIM.tint, WALLPAPER_SCRIM.dim, photo);
  return composite(card, alpha, dimmed);
}

/** Наихудшая и самая светлая подложки «обойной» темы. */
const WALLPAPER_SURFACES: Array<[what: string, bg: Rgb]> = [
  ['сплошь чёрное фото', wallpaperSurface(BLACK)],
  ['сплошь белое фото', wallpaperSurface(WHITE)],
];

/** То же для обойной тёмной: там подложка тёмная и полупрозрачная. */
const DARK_WALLPAPER_SURFACES: Array<[what: string, bg: Rgb]> = [
  ['сплошь чёрное фото', wallpaperSurface(BLACK, '#232324', WALLPAPER_DARK_SURFACE.alpha)],
  ['сплошь белое фото', wallpaperSurface(WHITE, '#232324', WALLPAPER_DARK_SURFACE.alpha)],
];

/** Все подложки темы: у обычных одна, у обойных — крайние случаи. */
function surfaces(id: string, contentBg: string): Array<[what: string, bg: Rgb | string]> {
  if (id === 'wallpaper') return WALLPAPER_SURFACES;
  if (id === 'wallpaper-dark') return DARK_WALLPAPER_SURFACES;
  return [['карточка', contentBg]];
}

function palette(id: string): Palette {
  if (id === 'wallpaper') return 'wallpaper';
  if (id === 'wallpaper-dark') return 'wallpaper-dark';
  // Имена тёмных тем кончаются на -dark; CSS выбирает набор так же
  return id.endsWith('dark') ? 'dark' : 'light';
}

/** Норма WCAG AA: текст 4,5:1, нетекстовые элементы 3:1 (1.4.11). */
const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

/** Подложка кнопки «Обновить» под курсором. Значения из styles/themes.css. */
const HOVER_BG: Record<Palette, string | null> = {
  light: '#f0f1f3',
  dark: '#232324',
  // В обойных темах и она полупрозрачна — проверяется на самой подложке
  wallpaper: null,
  'wallpaper-dark': null,
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
          const film = kind === 'wallpaper' || kind === 'wallpaper-dark';
          const track = film
            ? composite(wallpaperTrackTint(kind).tint, wallpaperTrackTint(kind).alpha, bg)
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

  it('в обойных темах — на любой фотографии', () => {
    // Сплошной серый здесь пропадал: #DADCE0 на светлой подложке даёт
    // 1,22:1. Плёнка работает одинаково поверх чего угодно — в светлой
    // теме затемняющая, в тёмной осветляющая.
    for (const [palette, list] of [
      ['wallpaper', WALLPAPER_SURFACES],
      ['wallpaper-dark', DARK_WALLPAPER_SURFACES],
    ] as Array<[Palette, typeof WALLPAPER_SURFACES]>) {
      const { tint, alpha } = wallpaperTrackTint(palette);
      for (const [what, bg] of list) {
        const value = contrastRatio(composite(tint, alpha, bg), bg);
        expect(value, `${palette}/${what}: дорожка = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          MIN_BAND,
        );
      }
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

  it('в обойных темах текст строки — тот же, что и во всей теме', () => {
    // Иначе подвал выбивался бы из темы, а расчёт разъехался бы с
    // tests/wallpaperSurfaces.test.ts
    expect(footerColor('wallpaper', '--mt-footer-text')).toBe(
      WALLPAPER_SURFACE.secondaryText.toLowerCase(),
    );
    expect(footerColor('wallpaper-dark', '--mt-footer-text')).toBe(
      WALLPAPER_DARK_SURFACE.secondaryText.toLowerCase(),
    );
  });

  it('у каждой поверхности свой набор, а не унаследованный', () => {
    for (const name of ['--mt-footer-text', '--mt-footer-alert']) {
      expect(footerColor('dark', name), name).not.toBe(footerColor('light', name));
      expect(footerColor('wallpaper', name), name).not.toBe(footerColor('light', name));
      // Обойная тёмная тоже своя: серые тёмной темы на подложке поверх
      // белой фотографии дают 3,50:1 вместо 4,79:1 на сплошном #232324
      expect(footerColor('wallpaper-dark', name), name).not.toBe(footerColor('dark', name));
    }
  });
});
