/**
 * Полупрозрачные подложки «обойной» темы: читаемость считается, а не
 * оценивается на глаз.
 *
 * Требование заказчика: «таблица писем должна быть немного прозрачной,
 * чтобы было видно картинку не только под меню», и то же для фона окна
 * настроек и меню. На старом коде картинка была видна только вокруг
 * белой карточки — то есть фактически лишь под левым меню; все проверки
 * этого файла там падают.
 *
 * Наихудший случай для тёмного текста на светлой подложке — СПЛОШЬ
 * ЧЁРНАЯ фотография: подложка светлеет не до белого, и серые мейловой
 * палитры проваливаются. Обои может поставить любые, включая пёстрые,
 * поэтому проверяется именно он, а не «типичная» картинка.
 *
 * Второй наихудший случай — сплошь БЕЛАЯ фотография: на ней подложка
 * почти сливается с фоном, и надо убедиться, что выделенная строка
 * списка всё ещё отличается от невыделенной.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, luminance, type Rgb } from '../src/appearance/contrast';
import {
  WALLPAPER_DARK_SURFACE,
  WALLPAPER_SCRIM,
  WALLPAPER_SURFACE,
  themeMeta,
} from '../src/appearance/themes';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const themesCss = readFileSync(join(SRC, 'styles/themes.css'), 'utf8');

/** Тело CSS-блока обойной темы: светлой или тёмной. */
function blockOf(theme: 'wallpaper' | 'wallpaper-dark'): string {
  const at = themesCss.indexOf(`[data-theme='${theme}']`);
  expect(at, `в themes.css нет блока темы ${theme}`).toBeGreaterThanOrEqual(0);
  const open = themesCss.indexOf('{', at);
  const close = themesCss.indexOf('}', open);
  return themesCss.slice(open + 1, close);
}

function wallpaperBlock(): string {
  return blockOf('wallpaper');
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Фотография после общего затемнения темы (--mt-wallpaper-dim). */
function dimmed(photo: Rgb): Rgb {
  return composite(WALLPAPER_SCRIM.tint, WALLPAPER_SCRIM.dim, photo);
}

/** Подложка карточки поверх такой фотографии. */
function surface(photo: Rgb, alpha = WALLPAPER_SURFACE.alpha): Rgb {
  return composite('#ffffff', alpha, dimmed(photo));
}

/** Самая тёмная подложка, какая вообще возможна, — чёрная фотография. */
const worst = surface(BLACK);
/** Самая светлая — белая фотография. */
const lightest = surface(WHITE);

describe('карточка почты просвечивает', () => {
  it('подложка списка полупрозрачна, а не белая', () => {
    const block = wallpaperBlock();
    expect(block).toContain(
      `--mt-app-content-bg: rgba(255, 255, 255, var(--mt-wallpaper-surface-alpha))`,
    );
    expect(block).toContain(`--mt-wallpaper-surface-alpha: ${WALLPAPER_SURFACE.alpha}`);
    expect(WALLPAPER_SURFACE.alpha).toBeLessThan(1);
  });

  it('строки списка своей заливки не имеют — иначе слои сложатся', () => {
    /*
     * Подложки складываются: две по 0.78 дают 0.95, и от картинки под
     * таблицей писем остались бы 5% вместо 22% — то есть ровно то, на
     * что жаловался заказчик. Поэтому полупрозрачна карточка, а строка
     * своей заливки не имеет вовсе.
     */
    const doubled = 1 - (1 - WALLPAPER_SURFACE.alpha) ** 2;
    expect(1 - doubled).toBeLessThan((1 - WALLPAPER_SURFACE.alpha) / 3);
    expect(wallpaperBlock()).toContain('--mt-mail-color-list-letter-background: transparent');
  });

  it('фон окна настроек и меню тоже полупрозрачны', () => {
    const block = wallpaperBlock();
    expect(block).toContain(
      `--mt-settings-bg: rgba(240, 241, 243, var(--mt-wallpaper-surface-alpha))`,
    );
    expect(block).toContain(
      `--mt-color-background-modal: rgba(255, 255, 255, var(--mt-wallpaper-float-alpha))`,
    );
    expect(block).toContain(`--mt-wallpaper-float-alpha: ${WALLPAPER_SURFACE.floatAlpha}`);
    expect(block).toContain(
      `--mt-settings-card-bg: rgba(255, 255, 255, ${WALLPAPER_SURFACE.settingsCardAlpha})`,
    );
  });
});

describe('читаемость в наихудшем случае (чёрная фотография)', () => {
  it('основной текст ≥ 4.5:1', () => {
    expect(contrastRatio(themeMeta('wallpaper').textPrimary, worst)).toBeGreaterThanOrEqual(4.5);
  });

  it('вторичный текст списка ≥ 4.5:1', () => {
    expect(contrastRatio(WALLPAPER_SURFACE.secondaryText, worst)).toBeGreaterThanOrEqual(4.5);
    // мейловый серый на этой подложке не проходит — ради этого он и заменён
    expect(contrastRatio('#93969b', worst)).toBeLessThan(4.5);
  });

  it('акцент (ссылки, имена отправителей) ≥ 4.5:1', () => {
    expect(contrastRatio(WALLPAPER_SURFACE.accent, worst)).toBeGreaterThanOrEqual(4.5);
    // фирменный #006EC6 здесь недобирает — отсюда своя ступень акцента
    expect(contrastRatio('#006ec6', worst)).toBeLessThan(4.5);
  });

  it('третичный текст и вторичные значки ≥ 3:1', () => {
    expect(contrastRatio(WALLPAPER_SURFACE.tertiaryText, worst)).toBeGreaterThanOrEqual(3);
  });

  it('текст на акцентной кнопке ≥ 4.5:1', () => {
    expect(contrastRatio('#ffffff', WALLPAPER_SURFACE.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('меню плотнее карточки, значит там не хуже', () => {
    const menu = surface(BLACK, WALLPAPER_SURFACE.floatAlpha);
    expect(contrastRatio(WALLPAPER_SURFACE.secondaryText, menu)).toBeGreaterThanOrEqual(
      contrastRatio(WALLPAPER_SURFACE.secondaryText, worst),
    );
  });

  /*
   * Страница настроек — два слоя: подложка самой страницы и карточка
   * раздела поверх неё. Снаружи карточки живут только заголовок и левое
   * меню, и оба покрашены ОСНОВНЫМ текстом (SettingsLayout.module.css:
   * .navItem { color: var(--mt-color-text-primary) }), поэтому 4.5:1
   * там требуется от него. Весь вторичный текст раздела — внутри
   * карточки, и он считается на её, более плотной, подложке.
   */
  const settingsPage = composite('#f0f1f3', WALLPAPER_SURFACE.alpha, dimmed(BLACK));
  const settingsCard = composite('#ffffff', WALLPAPER_SURFACE.settingsCardAlpha, settingsPage);

  it('заголовок и меню настроек на подложке страницы ≥ 4.5:1', () => {
    expect(contrastRatio('#2c2d2e', settingsPage)).toBeGreaterThanOrEqual(4.5);
  });

  it('текст внутри карточки настроек ≥ 4.5:1, включая вторичный', () => {
    expect(contrastRatio('#2c2d2e', settingsCard)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(WALLPAPER_SURFACE.secondaryText, settingsCard)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('карточка настроек светлее своей страницы — иначе она не карточка', () => {
    expect(luminance(settingsCard)).toBeGreaterThan(luminance(settingsPage));
  });
});

describe('строки списка различимы поверх картинки', () => {
  /*
   * Заказчик отдельно оговорил: невыделенная и выделенная строки не
   * должны сливаться. Считаем при обоих крайних фонах — на белой
   * фотографии разница накладки заметна хуже всего.
   */
  const step = (base: Rgb, alpha: number): number =>
    contrastRatio(composite(WALLPAPER_SURFACE.rowTint, alpha, base), base);

  it('выделенная строка отличается не хуже, чем на белой карточке', () => {
    // белая карточка привычный почтовый интерфейс: #FFFFFF против выделения #EBECEF
    const opaque = contrastRatio('#ffffff', '#ebecef');
    expect(step(worst, WALLPAPER_SURFACE.rowSelected)).toBeGreaterThanOrEqual(opaque);
    expect(step(lightest, WALLPAPER_SURFACE.rowSelected)).toBeGreaterThanOrEqual(opaque);
  });

  it('строка под курсором отличается не хуже, чем на белой карточке', () => {
    const opaque = contrastRatio('#ffffff', '#f5f5f7');
    expect(step(worst, WALLPAPER_SURFACE.rowHover)).toBeGreaterThanOrEqual(opaque);
    expect(step(lightest, WALLPAPER_SURFACE.rowHover)).toBeGreaterThanOrEqual(opaque);
  });

  it('выделение заметнее наведения — иначе их не различить', () => {
    expect(step(lightest, WALLPAPER_SURFACE.rowSelected)).toBeGreaterThan(
      step(lightest, WALLPAPER_SURFACE.rowHover),
    );
  });

  it('накладки заданы в CSS теми же числами', () => {
    const block = wallpaperBlock();
    expect(block).toContain(
      `--mt-mail-color-list-letter-background-hover: rgba(0, 16, 61, ${WALLPAPER_SURFACE.rowHover})`,
    );
    expect(block).toContain(
      `--mt-list-selection: rgba(0, 16, 61, ${WALLPAPER_SURFACE.rowSelected})`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Обойная тема на тёмной основе                                        */
/* ------------------------------------------------------------------ */
/*
 * Всё то же самое, но наихудший случай ЗЕРКАЛЬНЫЙ. Для тёмного текста на
 * светлой подложке хуже всего чёрное фото; для светлого текста на ТЁМНОЙ
 * подложке — белое: карточка светлеет, и держаться тексту не на чем.
 * Пока обойная тема была одна (светлая), человек с фоновой картинкой был
 * обязан работать в светлом интерфейсе, каким бы тёмным ни было фото.
 */
describe('обойная тёмная: читаемость на белой фотографии', () => {
  const darkSurface = (photo: Rgb, alpha = WALLPAPER_DARK_SURFACE.alpha): Rgb =>
    composite(themeMeta('wallpaper-dark').contentBg, alpha, dimmed(photo));

  /** Самая светлая подложка, какая возможна, — белая фотография. */
  const worstDark = darkSurface(WHITE);
  /** Самая тёмная — чёрная. */
  const darkest = darkSurface(BLACK);

  it('карточка полупрозрачна теми же числами, что в реестре', () => {
    const block = blockOf('wallpaper-dark');
    expect(block).toContain(
      '--mt-app-content-bg: rgba(35, 35, 36, var(--mt-wallpaper-surface-alpha))',
    );
    expect(block).toContain(`--mt-wallpaper-surface-alpha: ${WALLPAPER_DARK_SURFACE.alpha}`);
    expect(block).toContain(`--mt-wallpaper-float-alpha: ${WALLPAPER_DARK_SURFACE.floatAlpha}`);
    expect(block).toContain('--mt-mail-color-list-letter-background: transparent');
    expect(WALLPAPER_DARK_SURFACE.alpha).toBeLessThan(1);
  });

  it('основной текст ≥ 4.5:1', () => {
    expect(
      contrastRatio(themeMeta('wallpaper-dark').textPrimary, worstDark),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('вторичный текст списка ≥ 4.5:1', () => {
    expect(contrastRatio(WALLPAPER_DARK_SURFACE.secondaryText, worstDark)).toBeGreaterThanOrEqual(
      4.5,
    );
    // серый тёмной темы почты здесь не проходит — ради этого он и заменён
    expect(contrastRatio('#8c8e94', worstDark)).toBeLessThan(4.5);
  });

  it('акцент (ссылки, имена отправителей) ≥ 4.5:1', () => {
    expect(contrastRatio(WALLPAPER_DARK_SURFACE.accent, worstDark)).toBeGreaterThanOrEqual(4.5);
    // акцент тёмной темы здесь недобирает — отсюда своя, более светлая ступень
    expect(contrastRatio('#5ca8f5', worstDark)).toBeLessThan(4.5);
  });

  it('третичный текст и вторичные значки ≥ 3:1', () => {
    expect(contrastRatio(WALLPAPER_DARK_SURFACE.tertiaryText, worstDark)).toBeGreaterThanOrEqual(3);
  });

  it('текст на акцентной кнопке ≥ 4.5:1', () => {
    expect(
      contrastRatio(themeMeta('wallpaper-dark').onAccent, WALLPAPER_DARK_SURFACE.accent),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('меню плотнее карточки, значит там не хуже', () => {
    const menu = darkSurface(WHITE, WALLPAPER_DARK_SURFACE.floatAlpha);
    expect(contrastRatio(WALLPAPER_DARK_SURFACE.secondaryText, menu)).toBeGreaterThanOrEqual(
      contrastRatio(WALLPAPER_DARK_SURFACE.secondaryText, worstDark),
    );
  });

  const settingsPage = (photo: Rgb): Rgb =>
    composite(WALLPAPER_DARK_SURFACE.settingsBg, WALLPAPER_DARK_SURFACE.alpha, dimmed(photo));
  const settingsCard = (photo: Rgb): Rgb =>
    composite(
      WALLPAPER_DARK_SURFACE.settingsCard,
      WALLPAPER_DARK_SURFACE.settingsCardAlpha,
      settingsPage(photo),
    );

  it('текст настроек читается и на странице, и в карточке', () => {
    const ink = themeMeta('wallpaper-dark').textPrimary;
    for (const photo of [WHITE, BLACK]) {
      expect(contrastRatio(ink, settingsPage(photo))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ink, settingsCard(photo))).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(WALLPAPER_DARK_SURFACE.secondaryText, settingsCard(photo)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('карточка настроек светлее своей страницы на любой фотографии', () => {
    /*
     * На белом фото светлеют обе подложки сразу, и разница между ними
     * съедается фотографией: на цвете карточки почты (#3A3A3B) оставалось
     * 1.06:1 — карточки было не видно. Отсюда более светлый цвет.
     */
    for (const photo of [WHITE, BLACK]) {
      expect(luminance(settingsCard(photo))).toBeGreaterThan(luminance(settingsPage(photo)));
      expect(contrastRatio(settingsCard(photo), settingsPage(photo))).toBeGreaterThanOrEqual(1.15);
    }
  });

  it('строки списка различимы: накладки светлые, а не тёмные', () => {
    // Тёмная плёнка на тёмной подложке читается провалом, а не выбором.
    expect(WALLPAPER_DARK_SURFACE.rowTint).toBe('#ffffff');
    const step = (base: Rgb, alpha: number): number =>
      contrastRatio(composite(WALLPAPER_DARK_SURFACE.rowTint, alpha, base), base);
    const selected = contrastRatio('#ffffff', '#ebecef');
    const hovered = contrastRatio('#ffffff', '#f5f5f7');
    for (const base of [worstDark, darkest]) {
      expect(step(base, WALLPAPER_DARK_SURFACE.rowSelected)).toBeGreaterThanOrEqual(selected);
      expect(step(base, WALLPAPER_DARK_SURFACE.rowHover)).toBeGreaterThanOrEqual(hovered);
      expect(step(base, WALLPAPER_DARK_SURFACE.rowSelected)).toBeGreaterThan(
        step(base, WALLPAPER_DARK_SURFACE.rowHover),
      );
    }
  });

  it('накладки заданы в CSS теми же числами', () => {
    const block = blockOf('wallpaper-dark');
    expect(block).toContain(
      `--mt-mail-color-list-letter-background-hover: rgba(255, 255, 255, ${WALLPAPER_DARK_SURFACE.rowHover})`,
    );
    expect(block).toContain(
      `--mt-list-selection: rgba(255, 255, 255, ${WALLPAPER_DARK_SURFACE.rowSelected})`,
    );
    expect(block).toContain(`--mt-accent: ${WALLPAPER_DARK_SURFACE.accent}`);
    expect(block).toContain(`--mt-list-secondary-text: ${WALLPAPER_DARK_SURFACE.secondaryText}`);
  });

  it('фотография видна не меньше, чем в светлой обойной теме', () => {
    // Иначе «тёмный вариант» превратился бы в тему со случайной картинкой
    // за окном: смысл обоев в том, что их видно сквозь интерфейс.
    expect(1 - WALLPAPER_DARK_SURFACE.alpha).toBeGreaterThanOrEqual(0.15);
  });
});

describe('без обоев интерфейс остаётся прежним', () => {
  /*
   * Это тот же продукт для тех, кто обои не включал: ни одна подложка
   * не должна стать полупрозрачной ни в светлой, ни в тёмной теме.
   */
  const blocksBefore = themesCss.slice(0, themesCss.indexOf(`[data-theme='wallpaper']`));

  it('прозрачных подложек нет ни в одной другой теме', () => {
    expect(blocksBefore).not.toContain('--mt-wallpaper-surface-alpha');
    for (const token of [
      '--mt-app-content-bg',
      '--mt-settings-bg',
      '--mt-settings-card-bg',
      '--mt-color-background-modal',
      '--mt-mail-color-list-letter-background',
    ]) {
      const re = new RegExp(`${token}:\\s*rgba\\([^)]*0\\.\\d`, 'g');
      expect(blocksBefore.match(re), `${token} стал полупрозрачным вне обойной темы`).toBeNull();
    }
  });

  it('серые и акцент подменены только в обойной теме', () => {
    const block = wallpaperBlock();
    expect(block).toContain(`--mt-list-secondary-text: ${WALLPAPER_SURFACE.secondaryText}`);
    expect(block).toContain(`--mt-accent: ${WALLPAPER_SURFACE.accent}`);
    // в светлой теме остаётся фирменный True Blue
    expect(blocksBefore).toContain('--mt-accent: #006ec6');
  });
});
