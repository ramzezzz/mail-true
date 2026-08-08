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
import {
  THEMES,
  THEME_IDS,
  WALLPAPER_SCRIM,
  WALLPAPER_SURFACE,
  isThemeName,
  themeMeta,
  type ThemeName,
} from '../src/appearance/themes';
import {
  WALLPAPER_PRESETS,
  parseWallpaperSelection,
  validateWallpaperFile,
  CUSTOM_WALLPAPER_MAX_BYTES,
} from '../src/appearance/wallpapers';
import { resolveTheme } from '../src/app/store';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const themesCss = readFileSync(join(SRC, 'styles/themes.css'), 'utf8');

/** Правила верхнего уровня: селекторы и тело. Внутрь @media не заходим. */
function rules(css: string): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let head = '';
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        head = css.slice(start, i);
        start = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const clean = head.replace(/\/\*[\s\S]*?\*\//gu, '').trim();
        if (clean && !clean.startsWith('@')) {
          out.push({ selectors: clean.split(',').map((s) => s.trim()), body: css.slice(start, i) });
        }
        start = i + 1;
      }
    }
  }
  return out;
}

/** Действует ли правило с таким селектором на эту тему. */
function appliesTo(selector: string, id: string): boolean {
  if (selector === `:root[data-theme='${id}']`) return true;
  // Основа тёмного семейства выписана один раз по суффиксу имени
  return selector === ":root[data-theme$='dark']" && id.endsWith('dark');
}

/**
 * Всё, что CSS говорит о теме, — одной строкой.
 *
 * Раньше здесь был поиск подстроки `[data-theme='id']` и первая пара
 * скобок за ней. Так было можно, пока каждая тема помещалась в один блок.
 * Теперь тёмные темы собраны из ДВУХ: общая основа семейства
 * (`[data-theme$='dark']`, чтобы не переписывать сорок строк шесть раз)
 * и собственный блок с акцентом. Поиск подстроки такого не разбирает —
 * и вдобавок путал бы `[data-theme='dark']` с перечислением, где это имя
 * встречается внутри чужого селектора. Поэтому — честный разбор правил.
 */
function themeBlock(id: string): string {
  const bodies = rules(themesCss)
    .filter((rule) => rule.selectors.some((selector) => appliesTo(selector, id)))
    .map((rule) => rule.body);
  expect(bodies.length, `в themes.css нет правил для темы «${id}»`).toBeGreaterThan(0);
  return bodies.join('\n');
}

/** Тон цвета в градусах — по нему сверяется «личность» темы. */
function hue(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((v) => v / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const raw = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (raw * 60 + 360) % 360;
}

/** Светлые и тёмные темы одного тона: «Изумруд» и «Тёмный изумруд». */
const TWINS: readonly [light: ThemeName, dark: ThemeName][] = [
  ['light', 'dark'],
  ['emerald', 'emerald-dark'],
  ['violet', 'violet-dark'],
  ['coral', 'coral-dark'],
  ['lagoon', 'lagoon-dark'],
  ['sunset', 'sunset-dark'],
  ['wallpaper', 'wallpaper-dark'],
];

/** Цветные темы на светлой основе — те, что меняют только акцент и фон. */
const COLOURED_LIGHT = ['emerald', 'violet', 'coral', 'lagoon', 'sunset'] as const;
/** Их тёмные близнецы. */
const COLOURED_DARK = COLOURED_LIGHT.map((id) => `${id}-dark`);

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
       * ровно как в привычных почтовых интерфейсах (#0077FF на #EBECEF даёт 4.16:1).
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
   * Выделение строки списка в привычных почтовых интерфейсах нейтрально-серое при любой теме
   * (#EBECEF, пипетка по эталонные снимки интерфейса). Раньше базовый
   * блок держал светлый тон акцента #E7F1FB, и каждая цветная тема
   * переопределяла его своим — выделение было голубым, зелёным, лиловым.
   */
  it('подложка выделенной строки — нейтральная и своя только у тёмного семейства', () => {
    expect(themesCss).toMatch(/--mt-list-selection:\s*#ebecef/u);
    expect(themesCss).not.toMatch(/--mt-accent-selection/u);
    for (const id of COLOURED_LIGHT) {
      expect(themeBlock(id), `${id}: своей подложки выделения быть не должно`).not.toContain(
        '--mt-list-selection',
      );
    }
    // У тёмных она своя, но ОДНА на всё семейство: цвет выделения не
    // зависит от расцветки темы ни на светлом, ни на тёмном.
    for (const [, dark] of TWINS) {
      if (dark === 'wallpaper-dark') continue; // там она полупрозрачная накладка
      expect(themeBlock(dark), `${dark}: подложка выделения`).toContain(
        `--mt-list-selection: ${themeMeta(dark).selection}`,
      );
    }
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

  it('токен со словом themed в имени и правда зависит от темы', () => {
    /*
     * «Themed» — это обещание. Токен --mt-color-icon-accent-themed стоял
     * со значением из выгрузки привычный почтовый интерфейс (#0077ff) и не переопределялся
     * НИГДЕ: ни в тёмной теме, ни в цветных. То есть имя обещало
     * зависимость от темы, а цвет её не имел, и опиравшиеся на него места
     * (полоса хода переноса в панели, рамка фокуса строки) оставались
     * синими в «Изумруде» и в «Графите».
     *
     * Проверка не на конкретный цвет, а на САМУ зависимость: значение
     * обязано быть выражено через переменную акцента — тогда любая тема,
     * переопределившая акцент, переопределяет и его.
     */
    for (const token of [
      '--mt-color-icon-accent-themed',
      '--mt-color-icon-accent-themed-hover',
      '--mt-color-icon-accent-themed-press',
    ]) {
      const declared = new RegExp(`${token}:\\s*([^;]+);`, 'u').exec(themesCss);
      expect(declared, `${token} нигде не привязан к теме`).not.toBeNull();
      expect(declared![1]!.trim(), `${token}`).toMatch(/^var\(--mt-accent/u);
    }
  });

  it('цветные темы меняют только переменные, а не компоненты', () => {
    // В блоке цветной темы не должно быть ничего, кроме custom properties
    for (const id of [...COLOURED_LIGHT, ...COLOURED_DARK]) {
      const lines = themeBlock(id)
        // Пояснения вырезаем целиком: построчная отсечка не справлялась
        // с многострочным комментарием, у которого середина — обычный текст
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        expect(line, `${id}: «${line}»`).toMatch(/^(--mt-|color-scheme)/u);
      }
    }
  });
});

describe('у каждой темы есть пара на другой основе', () => {
  /*
   * Раньше набор был перекошен: восемь тем, из них семь на светлой основе
   * и одна тёмная. Человек, работающий в тёмном интерфейсе, выбирал не
   * между расцветками, а между «тёмной» и ничем. Пары ниже — и есть
   * требование заказчика: та же личность темы, но на другой основе.
   */
  it('ни одна тема не осталась без близнеца', () => {
    const paired = new Set(TWINS.flat());
    for (const id of THEME_IDS) {
      expect(paired.has(id), `тема «${id}» не входит ни в одну пару`).toBe(true);
    }
    expect(paired.size).toBe(THEME_IDS.length);
  });

  it('светлая и тёмная стороны набора равны по числу', () => {
    const dark = THEMES.filter((t) => t.id.endsWith('dark'));
    expect(dark.length).toBe(TWINS.length);
    expect(THEMES.length - dark.length).toBe(TWINS.length);
  });

  it('близнец сохраняет тон: «Тёмный изумруд» остаётся изумрудом', () => {
    // Иначе получился бы не тёмный вариант темы, а новая тема с тем же
    // названием: тёмный акцент выводится из светлого подъёмом светлоты,
    // тон не трогается.
    for (const [light, dark] of TWINS) {
      const distance = Math.abs(hue(themeMeta(light).accent) - hue(themeMeta(dark).accent));
      expect(
        Math.min(distance, 360 - distance),
        `«${themeMeta(light).title}» и «${themeMeta(dark).title}» разошлись по тону`,
      ).toBeLessThanOrEqual(10);
    }
  });

  it('тёмные близнецы стоят на одной основе — карточка у всех одна', () => {
    // Цвет карточки не вкусовщина: под него посчитаны цвета графиков
    // панели управления и полосы журнала. Разойдись он по темам —
    // и считать пришлось бы каждую заново.
    for (const [, dark] of TWINS) {
      const meta = themeMeta(dark);
      if (meta.kind === 'wallpaper') continue; // там подложка полупрозрачная
      expect(meta.contentBg, dark).toBe(themeMeta('dark').contentBg);
      expect(meta.textPrimary, dark).toBe(themeMeta('dark').textPrimary);
      expect(meta.onAccent, dark).toBe(themeMeta('dark').onAccent);
    }
  });

  it('имя тёмной темы кончается на -dark: на это опираются стили', () => {
    // Общая тёмная основа выписана в themes.css один раз селектором
    // [data-theme$='dark'], и по тому же суффиксу выбирают начертание
    // логотипа и палитру строки состояния. Тема с другим именем молча
    // получила бы светлые цвета текста на тёмной карточке.
    for (const [light, dark] of TWINS) {
      expect(dark.endsWith('dark'), `«${dark}» не кончается на -dark`).toBe(true);
      expect(light.endsWith('dark'), `«${light}» кончается на -dark, а тема светлая`).toBe(false);
    }
    expect(themesCss).toContain(":root[data-theme$='dark']");
  });

  it('каждая цветная тёмная тема меняет ровно акцент и фон страницы', () => {
    for (const id of COLOURED_DARK) {
      const own = rules(themesCss).find((r) =>
        r.selectors.includes(`:root[data-theme='${id}']`),
      )?.body;
      const names = [...(own ?? '').matchAll(/(--mt-[\w-]+):/gu)].map((m) => m[1]);
      expect(names.sort(), id).toEqual(
        [
          '--mt-accent',
          '--mt-accent-hover',
          '--mt-accent-press',
          '--mt-app-bg',
          '--mt-settings-bg',
        ].sort(),
      );
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

  /*
   * Раньше здесь стояло обратное требование — «карточка контента остаётся
   * непрозрачной». Заказчик попросил её открыть: «таблица писем должна быть
   * немного прозрачной, чтобы было видно картинку не только под меню».
   * Читаемость теперь держится не непрозрачностью, а расчётом доли —
   * им занят отдельный файл tests/wallpaperSurfaces.test.ts.
   */
  it('карточка контента полупрозрачна, но не настолько, чтобы потерять текст', () => {
    const block = themeBlock('wallpaper');
    expect(block).toContain('--mt-app-content-bg: rgba(255, 255, 255,');
    expect(WALLPAPER_SURFACE.alpha).toBeGreaterThanOrEqual(0.7);
    expect(WALLPAPER_SURFACE.alpha).toBeLessThan(1);
  });
});

describe('готовые фоны и своя картинка', () => {
  /*
   * Раньше здесь стояло «всё нарисовано кодом, никаких url(...)»: растровых
   * файлов в репозитории не было вовсе. Заказчик попросил обратного —
   * «добавь какие-то реальные картинки, а не просто градиент». Проверки
   * самого набора фотографий (лицензии, вес, читаемость) живут в
   * tests/wallpaperSet.test.ts, здесь остаётся только общая целостность.
   */
  it('набор непустой, идентификаторы уникальны, у каждого фона есть плитка', () => {
    expect(WALLPAPER_PRESETS.length).toBeGreaterThanOrEqual(6);
    const ids = new Set(WALLPAPER_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(WALLPAPER_PRESETS.length);
    for (const p of WALLPAPER_PRESETS) {
      expect(p.css).toMatch(/gradient\(|url\(/u);
      expect(p.thumb).toBeTruthy();
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
