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
import { WALLPAPER_SCRIM, WALLPAPER_SURFACE, themeMeta } from '../src/appearance/themes';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const themesCss = readFileSync(join(SRC, 'styles/themes.css'), 'utf8');

/** Тело CSS-блока «обойной» темы. */
function wallpaperBlock(): string {
  const at = themesCss.indexOf(`[data-theme='wallpaper']`);
  expect(at, 'в themes.css нет блока обойной темы').toBeGreaterThanOrEqual(0);
  const open = themesCss.indexOf('{', at);
  const close = themesCss.indexOf('}', open);
  return themesCss.slice(open + 1, close);
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
    expect(contrastRatio(WALLPAPER_SURFACE.secondaryText, settingsCard)).toBeGreaterThanOrEqual(4.5);
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
  const step = (photo: Rgb, alpha: number): number => {
    const base = surface(photo);
    return contrastRatio(composite(WALLPAPER_SURFACE.rowTint, alpha, base), base);
  };

  it('выделенная строка отличается не хуже, чем на белой карточке', () => {
    // белая карточка mail.ru: #FFFFFF против выделения #EBECEF
    const opaque = contrastRatio('#ffffff', '#ebecef');
    expect(step(BLACK, WALLPAPER_SURFACE.rowSelected)).toBeGreaterThanOrEqual(opaque);
    expect(step(WHITE, WALLPAPER_SURFACE.rowSelected)).toBeGreaterThanOrEqual(opaque);
  });

  it('строка под курсором отличается не хуже, чем на белой карточке', () => {
    const opaque = contrastRatio('#ffffff', '#f5f5f7');
    expect(step(BLACK, WALLPAPER_SURFACE.rowHover)).toBeGreaterThanOrEqual(opaque);
    expect(step(WHITE, WALLPAPER_SURFACE.rowHover)).toBeGreaterThanOrEqual(opaque);
  });

  it('выделение заметнее наведения — иначе их не различить', () => {
    expect(step(WHITE, WALLPAPER_SURFACE.rowSelected)).toBeGreaterThan(
      step(WHITE, WALLPAPER_SURFACE.rowHover),
    );
  });

  it('накладки заданы в CSS теми же числами', () => {
    const block = wallpaperBlock();
    expect(block).toContain(
      `--mt-mail-color-list-letter-background-hover: rgba(0, 16, 61, ${WALLPAPER_SURFACE.rowHover})`,
    );
    expect(block).toContain(`--mt-list-selection: rgba(0, 16, 61, ${WALLPAPER_SURFACE.rowSelected})`);
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
