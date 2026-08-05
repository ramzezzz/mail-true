/**
 * Темы оформления: контраст, синхронность реестра с CSS, читаемость
 * поверх фоновой картинки, набор готовых фонов.
 *
 * Контраст здесь СЧИТАЕТСЯ по формуле WCAG, а не проверяется на глаз:
 * тема, не добравшая 4.5:1 для текста (3:1 для крупного и значков),
 * в набор не попадает — тест не даст. Все проверки падали на старом
 * коде (тем и реестра не существовало).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio } from '../src/appearance/contrast';
import { THEMES, THEME_IDS, WALLPAPER_SCRIM, isThemeName } from '../src/appearance/themes';
import {
  WALLPAPER_PRESETS,
  parseWallpaperSelection,
  validateWallpaperFile,
  CUSTOM_WALLPAPER_MAX_BYTES,
} from '../src/appearance/wallpapers';
import { resolveTheme } from '../src/app/store';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const themesCss = readFileSync(join(SRC, 'styles/themes.css'), 'utf8');

/** Тело CSS-блока темы по значению data-theme. */
function themeBlock(id: string): string {
  const at = themesCss.indexOf(`[data-theme='${id}']`);
  expect(at, `в themes.css нет блока data-theme='${id}'`).toBeGreaterThanOrEqual(0);
  const open = themesCss.indexOf('{', at);
  const close = themesCss.indexOf('}', open);
  return themesCss.slice(open + 1, close);
}

describe('контраст каждой темы (WCAG AA)', () => {
  for (const t of THEMES) {
    describe(`${t.id} («${t.title}»)`, () => {
      it('основной текст на карточке ≥ 4.5:1', () => {
        expect(contrastRatio(t.textPrimary, t.contentBg)).toBeGreaterThanOrEqual(4.5);
      });

      it('акцент (ссылки) на карточке ≥ 4.5:1', () => {
        expect(contrastRatio(t.accent, t.contentBg)).toBeGreaterThanOrEqual(4.5);
      });

      it('текст на акцентной кнопке ≥ 4.5:1', () => {
        expect(contrastRatio(t.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
      });

      /*
       * На выделенной строке акцентом покрашены только НЕтекстовые вещи —
       * точка непрочитанного и заливка чекбокса, а им WCAG (1.4.11) требует
       * 3:1, не 4.5:1. Пока подложка была светлым тоном акцента, разница не
       * замечалась; на нейтральной мейловой #EBECEF синий даёт 4.39:1 —
       * ровно как у самого mail.ru (#0077FF на #EBECEF даёт 4.16:1).
       * Текст на ней по-прежнему обязан брать полные 4.5:1.
       */
      it('значки на подложке выделенной строки ≥ 3:1, текст ≥ 4.5:1', () => {
        expect(contrastRatio(t.accent, t.selection)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(t.textPrimary, t.selection)).toBeGreaterThanOrEqual(4.5);
      });

      // Фон страницы вокруг карточки: в «обойной» теме на нём лежит
      // картинка, и его читаемость считается отдельным блоком ниже
      if (t.kind !== 'wallpaper') {
        it('текст на фоне страницы ≥ 4.5:1, акцентные значки ≥ 3:1', () => {
          expect(contrastRatio(t.textPrimary, t.appBg)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(t.accent, t.appBg)).toBeGreaterThanOrEqual(3);
        });
      }
    });
  }
});

describe('реестр тем и themes.css не разъехались', () => {
  it('у каждой темы реестра есть CSS-блок', () => {
    for (const id of THEME_IDS) themeBlock(id);
  });

  it('акцент светлой темы — фирменный True Blue в базовом блоке', () => {
    expect(themesCss).toMatch(/--mt-accent:\s*#006ec6/u);
  });

  /**
   * Выделение строки списка у mail.ru нейтрально-серое при любой теме
   * (#EBECEF, пипетка по research/mailru/10-selection.png). Раньше базовый
   * блок держал светлый тон акцента #E7F1FB, и каждая цветная тема
   * переопределяла его своим — выделение было голубым, зелёным, лиловым.
   */
  it('подложка выделенной строки — нейтральная и своя только у тёмной темы', () => {
    expect(themesCss).toMatch(/--mt-list-selection:\s*#ebecef/u);
    expect(themesCss).not.toMatch(/--mt-accent-selection/u);
    for (const id of ['emerald', 'violet', 'coral', 'lagoon', 'sunset']) {
      expect(themeBlock(id), `${id}: своей подложки выделения быть не должно`).not.toContain(
        '--mt-list-selection',
      );
    }
    expect(themeBlock('dark')).toContain(`--mt-list-selection: ${
      THEMES.find((t) => t.id === 'dark')!.selection
    }`);
  });

  it('цветные темы и тёмная переопределяют акцент значениями реестра', () => {
    for (const t of THEMES) {
      if (t.id === 'light' || t.id === 'wallpaper') continue;
      const block = themeBlock(t.id);
      expect(block, `${t.id}: акцент`).toContain(`--mt-accent: ${t.accent}`);
      expect(block, `${t.id}: hover`).toContain(`--mt-accent-hover: ${t.accentHover}`);
      expect(block, `${t.id}: press`).toContain(`--mt-accent-press: ${t.accentPress}`);
    }
  });

  it('«синий кластер» токенов замкнут на переменные акцента', () => {
    // Достаточно ключевых представителей: кнопка, ссылка, значок, непрочитанное
    for (const token of [
      '--mt-color-background-accent: var(--mt-accent)',
      '--mt-color-text-link: var(--mt-accent)',
      '--mt-color-icon-accent: var(--mt-accent)',
      '--mt-mail-color-icon-unread: var(--mt-accent)',
      '--mt-mail-color-list-letter-background-press: var(--mt-list-selection)',
    ]) {
      expect(themesCss).toContain(token);
    }
  });

  it('цветные темы меняют только переменные, а не компоненты', () => {
    // В блоке цветной темы не должно быть ничего, кроме custom properties
    for (const id of ['emerald', 'violet', 'coral', 'lagoon', 'sunset']) {
      const lines = themeBlock(id)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('/*') && !l.startsWith('*') && !l.endsWith('*/'));
      for (const line of lines) {
        expect(line, `${id}: «${line}»`).toMatch(/^(--mt-|color-scheme)/u);
      }
    }
  });
});

describe('читаемость поверх фоновой картинки (наихудший случай — белое фото)', () => {
  const white = '#ffffff';
  // Картинка после общего затемнения темы
  const dimmed = composite(WALLPAPER_SCRIM.tint, WALLPAPER_SCRIM.dim, white);

  it('белый текст полупрозрачной шапки ≥ 4.5:1', () => {
    const underHeader = composite('#000000', WALLPAPER_SCRIM.header, dimmed);
    expect(contrastRatio(white, underHeader)).toBeGreaterThanOrEqual(4.5);
  });

  it('белый текст левого меню (с его подложкой) ≥ 4.5:1', () => {
    const underSidebar = composite(WALLPAPER_SCRIM.tint, WALLPAPER_SCRIM.sidebar, dimmed);
    expect(contrastRatio(white, underSidebar)).toBeGreaterThanOrEqual(4.5);
  });

  it('выдвижной ящик папок непрозрачный и контрастный к белому тексту', () => {
    expect(contrastRatio(white, WALLPAPER_SCRIM.drawerBg)).toBeGreaterThanOrEqual(4.5);
  });

  it('числа слоёв затемнения в CSS совпадают с расчётными', () => {
    const block = themeBlock('wallpaper');
    expect(block).toContain(`--mt-wallpaper-dim: rgba(9, 16, 34, ${WALLPAPER_SCRIM.dim})`);
    expect(block).toContain(`--mt-sidebar-backdrop: rgba(9, 16, 34, ${WALLPAPER_SCRIM.sidebar})`);
    expect(block).toContain(`--mt-sidebar-drawer-bg: ${WALLPAPER_SCRIM.drawerBg}`);
    // Затемнение реально входит в состав фоновой картинки страницы
    expect(block).toMatch(/--mt-app-bg-image:\s*linear-gradient\(var\(--mt-wallpaper-dim\)/u);
  });

  it('карточка контента остаётся непрозрачной — письма читаются на любом фоне', () => {
    const block = themeBlock('wallpaper');
    expect(block).toContain('--mt-app-content-bg: var(--mt-color-background-content)');
  });
});

describe('готовые фоны и своя картинка', () => {
  it('набор непустой, идентификаторы уникальны, всё нарисовано кодом', () => {
    expect(WALLPAPER_PRESETS.length).toBeGreaterThanOrEqual(6);
    const ids = new Set(WALLPAPER_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(WALLPAPER_PRESETS.length);
    for (const p of WALLPAPER_PRESETS) {
      // никаких url(...) — растровые файлы в репозиторий не кладём
      expect(p.css).toMatch(/gradient\(/u);
      expect(p.css).not.toMatch(/url\(/u);
      expect(p.title).toBeTruthy();
    }
  });

  it('разбор сохранённого выбора устойчив к мусору', () => {
    expect(parseWallpaperSelection('custom')).toEqual({ kind: 'custom' });
    const known = WALLPAPER_PRESETS[2]!.id;
    expect(parseWallpaperSelection(`preset:${known}`)).toEqual({ kind: 'preset', id: known });
    const fallback = { kind: 'preset', id: WALLPAPER_PRESETS[0]!.id };
    expect(parseWallpaperSelection(null)).toEqual(fallback);
    expect(parseWallpaperSelection('preset:нет-такого')).toEqual(fallback);
    expect(parseWallpaperSelection('что угодно')).toEqual(fallback);
  });

  it('файл проверяется до сохранения: тип и размер', () => {
    expect(validateWallpaperFile({ type: 'image/jpeg', size: 1024 })).toBeNull();
    expect(validateWallpaperFile({ type: 'application/pdf', size: 1024 })).toBeTruthy();
    expect(
      validateWallpaperFile({ type: 'image/png', size: CUSTOM_WALLPAPER_MAX_BYTES + 1 }),
    ).toBeTruthy();
  });
});

describe('системная тема', () => {
  it('явный выбор возвращается как есть, системная вне браузера — светлая', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('emerald')).toBe('emerald');
    // node-окружение: window нет — «как в системе» значит светлая
    expect(resolveTheme('system')).toBe('light');
  });

  it('распознавание сохранённых имён тем строгое', () => {
    expect(isThemeName('coral')).toBe(true);
    expect(isThemeName('system')).toBe(false);
    expect(isThemeName('немытьё')).toBe(false);
    expect(isThemeName(null)).toBe(false);
  });
});
