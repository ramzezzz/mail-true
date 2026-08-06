/**
 * Цвета, которые ТОЛЬКО КАЖУТСЯ тематическими.
 *
 * Панель умеет восемь расцветок, и правило «цвет берётся из переменной,
 * а не прибивается гвоздями» соблюдается почти везде. Почти — потому что
 * есть два способа обойти его незаметно, и оба уже сработали:
 *
 *  1. `var(--нет-такого-токена, #c02a2a)`. Выглядит как «переменная с
 *     запасным вариантом», работает как прибитый гвоздями цвет: если
 *     переменной нет НИ ОДНОГО определения, запасной применяется всегда.
 *     Так опасное действие в строке таблицы красилось тёмно-красным на
 *     тёмно-сером — 2,37:1 при норме 4,5:1, ровно в теме по умолчанию.
 *
 *  2. Подпись НА цветной заливке, посчитанная для одной темы. Белым на
 *     красном #c42500 выходит 5,81:1, и это верно — для светлых тем. В
 *     тёмных заливка отказа светло-лососевая, и та же белая подпись даёт
 *     2,01:1: слово «Удалить» на кнопке необратимого действия пропадает.
 *
 * Оба случая проходят мимо проверок «реестр тем сходится с CSS»: там
 * сверяются токены с токенами, а здесь беда в МЕСТЕ ПРИМЕНЕНИЯ.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const WEB_STYLES = fileURLToPath(new URL('../../web/src/styles', import.meta.url));

function cssFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFilesIn(full));
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Всё, что попадает в страницу: токены почты, темы почты и стили панели. */
const ADMIN_CSS = cssFilesIn(SRC);
const ALL_CSS = [
  ...ADMIN_CSS,
  path.join(WEB_STYLES, 'tokens.css'),
  path.join(WEB_STYLES, 'themes.css'),
];

const SOURCES = new Map(ALL_CSS.map((file) => [file, readFileSync(file, 'utf8')]));

/**
 * Токен может задаваться и из кода — страница входа собирает свою гамму в
 * appearance/loginPalette и вешает её стилем на корень. Такое определение
 * настоящее, поэтому исходники тоже читаем.
 */
function tsFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesIn(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const EVERYTHING = [
  ...SOURCES.values(),
  ...tsFilesIn(SRC).map((file) => readFileSync(file, 'utf8')),
].join('\n');

/** Определён ли токен хоть где-нибудь: в CSS как `--имя:`, в коде как ключ. */
function isDefined(token: string): boolean {
  return new RegExp(`${token}(\\s*:|['"\`]\\s*:)`, 'u').test(EVERYTHING);
}

// ------------------------------------------------------------------
// Расчёт контраста по WCAG 2.1 — тот же, что в contrast.test.ts
// ------------------------------------------------------------------
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  const channels = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

/**
 * Значение токена в конкретной теме: последнее объявление, видимое этой
 * теме. Светлые расцветки служебных цветов не переопределяют, поэтому
 * достаточно различать «тёмное семейство» и всё остальное.
 */
function tokenIn(theme: 'light' | 'dark' | 'graphite', name: string): string {
  const themed = SOURCES.get(path.join(SRC, 'styles', 'adminThemes.css')) ?? '';
  if (theme !== 'light') {
    // Блоки тёмных тем: собственный блок темы и общий блок dark+graphite.
    const blocks = [...themed.matchAll(/:root\[data-theme='([a-z]+)'\][^{]*\{([^}]*)\}/gu)];
    let found: string | null = null;
    for (const block of blocks) {
      const selector = themed.slice(block.index ?? 0, (block.index ?? 0) + block[0].indexOf('{'));
      if (!selector.includes(`'${theme}'`)) continue;
      const hit = block[2]?.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})`, 'u'));
      if (hit?.[1]) found = hit[1];
    }
    if (found) return found;
  }
  const base = SOURCES.get(path.join(SRC, 'styles', 'admin.css')) ?? '';
  const hit = base.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})`, 'u'));
  if (!hit?.[1]) throw new Error(`нет значения ${name} для темы ${theme}`);
  return hit[1];
}

describe('запасной цвет в var() не должен быть настоящим цветом', () => {
  it('у каждого var(--токен, запасной) есть определение токена', () => {
    const offenders: string[] = [];
    for (const file of ADMIN_CSS) {
      const text = SOURCES.get(file) ?? '';
      // Интересуют только запасные значения-ЦВЕТА: var(--x, 0) и подобные
      // подстановки чисел безобидны.
      for (const hit of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,\s*(#[0-9a-fA-F]{3,8})/gu)) {
        const token = hit[1]!;
        if (isDefined(token)) continue;
        offenders.push(`${path.relative(SRC, file)}: ${token} нигде не определён, ` +
          `значит цвет ${hit[2]} применяется во всех темах`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('подпись на заливке цвета отказа читается в каждой теме', () => {
  // Кнопка необратимого действия и любой другой текст поверх --mt-admin-fail.
  for (const theme of ['light', 'dark', 'graphite'] as const) {
    it(`тема «${theme}»`, () => {
      const fill = tokenIn(theme, '--mt-admin-fail');
      const ink = tokenIn(theme, '--mt-admin-fail-ink');
      const value = ratio(ink, fill);
      expect(value, `${ink} на ${fill} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('белый цвет подписи не прибит гвоздями в стилях страниц', () => {
    const offenders: string[] = [];
    for (const file of ADMIN_CSS) {
      const text = SOURCES.get(file) ?? '';
      // Ищем правила, где заливка — цвет отказа, а подпись задана литералом.
      for (const rule of text.matchAll(/\{[^}]*--mt-admin-fail[^}]*\}/gu)) {
        const body = rule[0];
        if (!/background:\s*var\(--mt-admin-fail\)/u.test(body)) continue;
        const literal = body.match(/color:\s*(#[0-9a-fA-F]{3,8})/u);
        if (literal) {
          offenders.push(`${path.relative(SRC, file)}: подпись ${literal[1]} посчитана
            только для светлой темы`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
