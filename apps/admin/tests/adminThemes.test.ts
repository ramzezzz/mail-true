/**
 * Темы панели управления: контраст в КАЖДОЙ теме и связь стилей с реестром.
 *
 * Контраст здесь СЧИТАЕТСЯ по формуле WCAG 2.1, а не сверяется со списком
 * «правильных» строк: цвет, подкрученный однажды на глаз, проверка заметит.
 * Считаются те пары, которые в панели реально видит человек, — текст на
 * поверхности, на фоне страницы и на второй поверхности, подпись активного
 * пункта на его подложке, подпись на акцентной кнопке, значки состояния на
 * своих плашках и цветные строки журнала (в том числе на подложке соседней
 * строки: полосы стоят вплотную).
 *
 * На прежнем коде падает всё: тем в панели не было вовсе — ни реестра
 * src/appearance/adminThemes.ts, ни файла styles/adminThemes.css. А из тех
 * цветов, что были, тёмная тема получала #0A7B44 на #232324 (2,94:1) для
 * значка «работает» и #63666B на #232324 (2,20:1) на погашенной кнопке:
 * пока тёмных тем не существовало, это никого не задевало.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/appearance/contrast';
import {
  ADMIN_THEMES,
  ADMIN_THEME_IDS,
  NAV_ACTIVE_ALPHA,
  adminThemeMeta,
  isAdminThemeName,
  navActiveBackground,
  type AdminThemeMeta,
  type AdminThemeName,
} from '../src/appearance/adminThemes';
import { DEFAULT_ADMIN_THEME } from '../src/appearance/themeStore';
import { LEVEL_IDS } from '../src/lib/logLevels';

const file = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

const themesCss = file('src/styles/adminThemes.css');
const adminCss = file('src/styles/admin.css');
const logCss = file('src/styles/logLevels.css');
const layoutCss = file('src/app/AdminLayout.module.css');

/** Норма WCAG AA для обычного текста. Панель набрана мелко — послаблений нет. */
const TEXT_MIN = 4.5;

/* ------------------------------------------------------------------ */
/* Разбор стилей: значения берём из САМИХ стилей, а не из головы        */
/* ------------------------------------------------------------------ */

interface CssRule {
  selectors: string[];
  body: string;
}

/**
 * Правила верхнего уровня. Внутрь @media не заходим: тем там нет, а
 * вложенные скобки сбили бы простой разбор.
 */
function rules(css: string): CssRule[] {
  const out: CssRule[] = [];
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

/** Объявления всех правил, чей селектор точно равен указанному. */
function declarations(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of rules(css)) {
    if (!rule.selectors.includes(selector)) continue;
    for (const line of rule.body.replace(/\/\*[\s\S]*?\*\//gu, '').split(';')) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      found.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  return found;
}

/**
 * Значение переменной темы из adminThemes.css.
 *
 * Тёмное семейство описано ОДНИМ правилом по суффиксу имени
 * (`[data-theme$='dark']`), а не блоком на каждую тему: шесть копий одних
 * и тех же служебных цветов разошлись бы при первой правке. Поэтому здесь
 * повторяется каскад — сначала правило семейства, потом собственное
 * правило темы; иначе проверка искала бы блок, которого нет, и решила бы,
 * что цвет не задан вовсе.
 */
function themeVar(theme: string, name: string): string | undefined {
  const merged = new Map<string, string>();
  const selectors = theme.endsWith('dark')
    ? [":root[data-theme$='dark']", `:root[data-theme='${theme}']`]
    : [`:root[data-theme='${theme}']`];
  for (const selector of selectors) {
    for (const [key, value] of declarations(themesCss, selector)) merged.set(key, value);
  }
  return merged.get(name);
}

/** Цвета строк журнала одной темы — из logLevels.css. */
function logColors(selector: string): Map<string, string> {
  return declarations(logCss, selector);
}

/* ------------------------------------------------------------------ */
/* Контраст в каждой теме                                              */
/* ------------------------------------------------------------------ */

/** Все пары «текст на подложке», которые тема обязана вытянуть. */
function textPairs(theme: AdminThemeMeta): { what: string; fg: string; bg: string }[] {
  const pill = navActiveBackground(theme);
  return [
    { what: 'основной текст на карточке', fg: theme.textPrimary, bg: theme.surface },
    { what: 'основной текст на фоне страницы', fg: theme.textPrimary, bg: theme.appBg },
    { what: 'основной текст на второй поверхности', fg: theme.textPrimary, bg: theme.surfaceAlt },
    // Им подписаны плитки сводки, заголовки таблиц, роль в шапке и «скоро»
    { what: 'вторичный текст на карточке', fg: theme.textSecondary, bg: theme.surface },
    { what: 'вторичный текст на фоне страницы', fg: theme.textSecondary, bg: theme.appBg },
    {
      what: 'вторичный текст на второй поверхности',
      fg: theme.textSecondary,
      bg: theme.surfaceAlt,
    },
    { what: 'ссылка на карточке', fg: theme.ink, bg: theme.surface },
    { what: 'ссылка на фоне страницы', fg: theme.ink, bg: theme.appBg },
    { what: 'активный пункт меню на своей подложке', fg: theme.ink, bg: pill },
    { what: 'подпись на акцентной кнопке', fg: theme.onAccent, bg: theme.accent },
    { what: 'подпись на кнопке под курсором', fg: theme.onAccent, bg: theme.accentHover },
    { what: 'подпись на нажатой кнопке', fg: theme.onAccent, bg: theme.accentPress },
    { what: '«работает» на своей плашке', fg: theme.ok, bg: theme.okTint },
    { what: '«работает» на карточке', fg: theme.ok, bg: theme.surface },
    { what: '«не отвечает» на своей плашке', fg: theme.fail, bg: theme.failTint },
    { what: '«не отвечает» на карточке', fg: theme.fail, bg: theme.surface },
    { what: 'предупреждение на карточке', fg: theme.warn, bg: theme.surface },
  ];
}

describe('контраст в каждой теме панели', () => {
  for (const theme of ADMIN_THEMES) {
    describe(`«${theme.title}»`, () => {
      for (const pair of textPairs(theme)) {
        it(`${pair.what} ≥ 4,5:1`, () => {
          const value = contrastRatio(pair.fg, pair.bg);
          expect(value, `${pair.fg} на ${pair.bg} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            TEXT_MIN,
          );
        });
      }

      it('цветные строки журнала читаются на своих подложках', () => {
        for (const id of LEVEL_IDS) {
          const level = theme.log[id];
          const value = contrastRatio(level.text, level.background);
          expect(
            value,
            `${id}: ${level.text} на ${level.background} = ${value.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(TEXT_MIN);
        }
      });

      it('строка журнала читается и на подложке соседней строки', () => {
        // Полосы разных уровней стоят вплотную, и при прокрутке взгляд то и
        // дело попадает на границу: подложка соседа — это фон для глаза.
        for (const id of LEVEL_IDS) {
          for (const other of LEVEL_IDS) {
            const value = contrastRatio(theme.log[id].text, theme.log[other].background);
            expect(
              value,
              `${id} на подложке ${other} = ${value.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(TEXT_MIN);
          }
        }
      });

      it('у каждого уровня своя подложка', () => {
        // Строка «событие» намеренно не красится — она и есть поверхность
        // карточки; остальные обязаны отличаться и от неё, и друг от друга,
        // иначе цвет строки ничего не сообщает.
        expect(theme.log.info.background).toBe(theme.surface);
        const backgrounds = LEVEL_IDS.map((id) => theme.log[id].background);
        expect(new Set(backgrounds).size, `подложки повторяются: ${backgrounds.join(', ')}`).toBe(
          LEVEL_IDS.length,
        );
      });

      it('ошибка и предупреждение различаются подложками', () => {
        const value = contrastRatio(theme.log.error.background, theme.log.warn.background);
        expect(value, `= ${value.toFixed(3)}:1`).toBeGreaterThan(1.06);
      });
    });
  }
});

/* ------------------------------------------------------------------ */
/* Реестр и стили не разъезжаются                                       */
/* ------------------------------------------------------------------ */

describe('графит задан в стилях ровно так, как в реестре', () => {
  const graphite = adminThemeMeta('graphite');
  const pairs: [string, string][] = [
    ['--mt-accent', graphite.accent],
    ['--mt-accent-hover', graphite.accentHover],
    ['--mt-accent-press', graphite.accentPress],
    ['--mt-color-text-contrast', graphite.onAccent],
    ['--mt-color-text-primary', graphite.textPrimary],
    ['--mt-color-text-secondary', graphite.textSecondary],
    ['--mt-app-bg', graphite.appBg],
    ['--mt-color-background-content', graphite.surface],
    ['--mt-color-background-secondary', graphite.surfaceAlt],
    ['--mt-admin-ok', graphite.ok],
    ['--mt-admin-warn', graphite.warn],
    ['--mt-admin-fail', graphite.fail],
    ['--mt-color-background-positive-tint', graphite.okTint],
    ['--mt-color-background-negative-tint', graphite.failTint],
  ];
  for (const [name, expected] of pairs) {
    it(`${name} — ${expected}`, () => {
      expect(themeVar('graphite', name)?.toLowerCase()).toBe(expected.toLowerCase());
    });
  }

  it('графит переопределяет светлую основу целиком, а не наполовину', () => {
    // Своего блока в themes.css у графита нет: без переопределения он
    // унаследовал бы светлые значения из :root — белую карточку с белым
    // текстом. Перечислены токены, на которых держится тёмный вид.
    for (const name of [
      'color-scheme',
      '--mt-color-icon-primary',
      '--mt-color-separator-primary',
      '--mt-color-field-background',
      '--mt-color-background-tertiary',
      '--mt-color-background-modal',
    ]) {
      expect(themeVar('graphite', name), `у графита не задан ${name}`).toBeDefined();
    }
  });
});

describe('тёмное семейство почты получает служебные цвета панели', () => {
  // Проверяется КАЖДАЯ тёмная тема почты, а не только «Тёмная»: правило в
  // стилях одно на всё семейство, и если оно вдруг перестанет их накрывать,
  // цветная тёмная тема молча получит светлые значки состояний.
  const family = ADMIN_THEMES.filter((theme) => theme.id.endsWith('dark'));

  it('семейство не пустое — иначе проверка ничего не проверяет', () => {
    expect(family.length).toBeGreaterThan(1);
  });

  for (const theme of family) {
    describe(`«${theme.title}»`, () => {
      it('значки состояния перекрашены: светлые на тёмном не читались', () => {
        expect(themeVar(theme.id, '--mt-admin-ok')?.toLowerCase()).toBe(theme.ok);
        expect(themeVar(theme.id, '--mt-admin-warn')?.toLowerCase()).toBe(theme.warn);
        expect(themeVar(theme.id, '--mt-admin-fail')?.toLowerCase()).toBe(theme.fail);
      });

      it('плашки под значками тоже тёмные', () => {
        expect(themeVar(theme.id, '--mt-color-background-positive-tint')?.toLowerCase()).toBe(
          theme.okTint,
        );
        expect(themeVar(theme.id, '--mt-color-background-negative-tint')?.toLowerCase()).toBe(
          theme.failTint,
        );
      });

      it('вторичный текст и вторая поверхность взяты панельные', () => {
        expect(themeVar(theme.id, '--mt-color-text-secondary')?.toLowerCase()).toBe(
          theme.textSecondary,
        );
        expect(themeVar(theme.id, '--mt-color-background-secondary')?.toLowerCase()).toBe(
          theme.surfaceAlt,
        );
      });
    });
  }
});

describe('у каждой цветной темы есть пара: светлая и тёмная', () => {
  /*
   * Раньше цветных тем было пять и все светлые: администратор, работающий
   * в тёмном интерфейсе, выбирал между «Графитом» и «Тёмной», а вся
   * цветная часть набора была для него закрыта. Пара — это та же личность
   * темы на другой основе, а не новая тема с похожим названием.
   */
  const TWINS: readonly [light: AdminThemeName, dark: AdminThemeName][] = [
    ['light', 'dark'],
    ['emerald', 'emerald-dark'],
    ['violet', 'violet-dark'],
    ['coral', 'coral-dark'],
    ['lagoon', 'lagoon-dark'],
    ['sunset', 'sunset-dark'],
  ];
  const twins = TWINS.map(([, dark]) => adminThemeMeta(dark)).filter((t) => t.id !== 'dark');

  it('ни одна тема, кроме графита, не осталась без близнеца', () => {
    // Графит — сам себе тема: это не тёмный вариант чего-то, а фирменная
    // гамма панели, светлого близнеца у неё нет и не нужно.
    const paired = new Set<string>(TWINS.flat());
    for (const theme of ADMIN_THEMES) {
      if (theme.id === 'graphite') continue;
      expect(paired.has(theme.id), `тема «${theme.title}» не входит ни в одну пару`).toBe(true);
    }
    expect(paired.size + 1).toBe(ADMIN_THEME_IDS.length);
  });

  it('близнец сохраняет тон акцента', () => {
    /** Тон цвета в градусах. */
    const hue = (hex: string): number => {
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
    };
    for (const [lightId, darkId] of TWINS) {
      const light = adminThemeMeta(lightId);
      const dark = adminThemeMeta(darkId);
      const distance = Math.abs(hue(light.accent) - hue(dark.accent));
      expect(
        Math.min(distance, 360 - distance),
        `«${light.title}» и «${dark.title}» разошлись по тону`,
      ).toBeLessThanOrEqual(10);
    }
  });

  it('тёмные близнецы стоят на той же основе, что тёмная тема почты', () => {
    // Поверхность у них общая не для красоты: под неё посчитаны цвета
    // графиков и полос журнала (tests/chartContrast.test.ts).
    const dark = adminThemeMeta('dark');
    for (const theme of twins) {
      expect(theme.surface, theme.id).toBe(dark.surface);
      expect(theme.surfaceAlt, theme.id).toBe(dark.surfaceAlt);
      expect(theme.textPrimary, theme.id).toBe(dark.textPrimary);
      expect(theme.textSecondary, theme.id).toBe(dark.textSecondary);
      expect(theme.onAccent, theme.id).toBe(dark.onAccent);
    }
  });

  it('светлых и тёмных тем поровну, если не считать графит', () => {
    const dark = ADMIN_THEMES.filter((t) => t.id.endsWith('dark'));
    const light = ADMIN_THEMES.filter((t) => t.kind === 'light');
    expect(dark.length).toBe(light.length);
  });
});

describe('цветные светлые темы поправлены под мелкий шрифт', () => {
  const coloured = ADMIN_THEMES.filter(
    (theme) => theme.kind === 'light' && theme.id !== 'light',
  ).map((theme) => `:root[data-theme='${theme.id}']`);

  const rule = rules(themesCss).find((r) => coloured.every((s) => r.selectors.includes(s)));

  it('поправка выписана на все цветные темы разом, а не на часть', () => {
    expect(rule, `нет правила, охватывающего ${coloured.join(', ')}`).toBeDefined();
  });

  it('вторичный текст тот же, что у светлой темы (#87898F даёт 3,50:1)', () => {
    const light = adminThemeMeta('light');
    expect(rule?.body).toContain(light.textSecondary);
    // И это ровно то же значение, что admin.css задаёт светлой теме
    expect(adminCss).toContain(light.textSecondary);
  });

  it('ссылка — самая тёмная ступень акцента темы, а не общий синий', () => {
    // На подложке активного пункта, тонированной этим же акцентом, сам
    // акцент себя не показывает: изумруд на своей пилюле — 4,49:1.
    expect(rule?.body).toMatch(/--mt-color-text-link:\s*var\(--mt-accent-press\)/u);
    for (const theme of ADMIN_THEMES) {
      if (theme.kind === 'light' && theme.id !== 'light') {
        expect(theme.ink, `у «${theme.title}» ссылка не равна ступени press`).toBe(
          theme.accentPress,
        );
      }
    }
  });

  it('на тёмных темах ссылка, наоборот, равна самому акценту', () => {
    for (const theme of ADMIN_THEMES) {
      if (theme.kind === 'dark') expect(theme.ink).toBe(theme.accent);
    }
  });
});

describe('строки журнала расписаны на все темы', () => {
  /** Какой блок logLevels.css действует в теме. */
  function selectorFor(theme: AdminThemeMeta): string {
    // Всё тёмное семейство почты обслуживает одно правило по суффиксу
    // имени: карточка у этих тем одна, значит и полосы журнала одни.
    if (theme.id.endsWith('dark')) return ":root[data-theme$='dark']";
    if (theme.id === 'graphite') return ":root[data-theme='graphite']";
    return ':root';
  }

  for (const theme of ADMIN_THEMES) {
    it(`«${theme.title}»: цвета в logLevels.css те же, что в реестре`, () => {
      const declared = logColors(selectorFor(theme));
      for (const id of LEVEL_IDS) {
        expect(declared.get(`--mt-log-${id}-text`)?.toLowerCase()).toBe(theme.log[id].text);
        expect(declared.get(`--mt-log-${id}-bg`)?.toLowerCase()).toBe(theme.log[id].background);
      }
    });
  }

  it('у графита свой блок: серые полосы почты на нём читались бы заплаткой', () => {
    expect(logCss).toContain(":root[data-theme='graphite']");
    const graphite = adminThemeMeta('graphite');
    const dark = adminThemeMeta('dark');
    for (const id of LEVEL_IDS) {
      expect(graphite.log[id].background).not.toBe(dark.log[id].background);
    }
  });

  it('цветным светлым темам своего блока не нужно: карточка у них белая', () => {
    for (const theme of ADMIN_THEMES) {
      if (theme.kind !== 'light') continue;
      expect(theme.surface).toBe(adminThemeMeta('light').surface);
      expect(theme.log.info.background).toBe(theme.surface);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Каркас знает про темы                                                */
/* ------------------------------------------------------------------ */

describe('каркас панели живёт по темам, а не по одной зашитой', () => {
  it('подложка активного пункта меню — акцент темы, а не синий из выгрузки', () => {
    // rgba(0,119,255,.2) из --mt-color-background-accent-themed-alpha
    // оставался синим при любой теме
    const pointer = layoutCss.slice(layoutCss.indexOf('.navPointer {'));
    const body = pointer.slice(0, pointer.indexOf('}'));
    expect(body).not.toContain('--mt-color-background-accent-themed-alpha');
    expect(body).toContain('var(--mt-accent)');
    const percent = /(\d+)%/u.exec(body)?.[1];
    expect(Number(percent) / 100, 'доля акцента разошлась с реестром').toBe(NAV_ACTIVE_ALPHA);
  });

  it('тёмное начертание логотипа включается на любой тёмной теме', () => {
    // Графит — тоже тёмная тема: перечислять их поимённо значит забыть
    // про следующую. Признак ставит applyAdminTheme по реестру.
    expect(layoutCss).toContain("[data-theme-kind='dark']");
  });

  it('на телефоне панель выбора не уезжает за край экрана', () => {
    // Замер на стенде до правки: при ширине окна 390px левый край панели
    // стоял на −104,9px — из трёх колонок образцов было видно две.
    const menu = file('src/app/ThemeMenu.module.css');
    const narrow = menu.slice(menu.indexOf('@media (max-width: 560px)'));
    expect(narrow, 'нет правила для узкого экрана').toContain('.panel');
    expect(narrow).toContain('position: fixed');
    expect(narrow).toMatch(/width:\s*min\(/u);
  });

  it('разметка покрашена той же темой, что стоит по умолчанию', () => {
    // Панель не должна мигать белым перед тем, как стать графитовой:
    // пока грузится модуль, красит именно эта строка разметки. Скриптом
    // в разметке не обойтись — инлайновые скрипты запрещены политикой
    // безопасности (script-src 'self').
    const html = file('index.html');
    expect(html).toContain(`data-theme="${DEFAULT_ADMIN_THEME}"`);
    expect(html).toContain(`data-theme-kind="${adminThemeMeta('graphite').kind}"`);
  });

  it('фон страницы берётся из темы, а не из нейтрального токена палитры', () => {
    // Иначе цветная тема меняла бы только акцент: --mt-color-background-secondary
    // у цветных тем остаётся серым #F0F1F3
    const body = adminCss.slice(adminCss.indexOf('body {'));
    expect(body.slice(0, body.indexOf('}'))).toContain('var(--mt-app-bg');
  });
});

describe('реестр тем', () => {
  it('первой идёт фирменная тема панели', () => {
    expect(ADMIN_THEME_IDS[0]).toBe('graphite');
  });

  it('у панели есть и своя тёмная, и тёмная почты — это разные темы', () => {
    const graphite = adminThemeMeta('graphite');
    const dark = adminThemeMeta('dark');
    expect(graphite.kind).toBe('dark');
    expect(dark.kind).toBe('dark');
    expect(graphite.accent).not.toBe(dark.accent);
    expect(graphite.surface).not.toBe(dark.surface);
  });

  it('акценты светлых тем взяты у почты слово в слово, второго набора нет', () => {
    // Значения обязаны совпадать с apps/web/src/appearance/themes.ts:
    // дизайн-система одна, а не «похожая».
    const web = readFileSync(
      fileURLToPath(new URL('../../web/src/appearance/themes.ts', import.meta.url)),
      'utf8',
    );
    for (const theme of ADMIN_THEMES) {
      if (theme.id === 'graphite') continue;
      expect(web, `акцента ${theme.accent} нет в реестре почты`).toContain(theme.accent);
      expect(web).toContain(theme.accentPress);
    }
  });

  it('чужая тема не притворяется своей', () => {
    expect(isAdminThemeName('graphite')).toBe(true);
    // Обойная тема почты в панель не переносится: фоновых картинок здесь нет
    expect(isAdminThemeName('wallpaper')).toBe(false);
    expect(isAdminThemeName(undefined)).toBe(false);
    expect(() => adminThemeMeta('wallpaper' as never)).toThrow();
  });

  it('у каждой темы есть название по-русски', () => {
    for (const theme of ADMIN_THEMES) expect(theme.title.trim().length).toBeGreaterThan(0);
  });
});
