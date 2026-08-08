/**
 * Цветные строки журнала: контраст и связь стилей с реестром.
 *
 * Контраст здесь СЧИТАЕТСЯ по формуле WCAG 2.1, а не сверяется со списком
 * «правильных» строк. Цвет, подкрученный однажды «на глаз», проверка
 * заметит — и в светлой теме, и в тёмной.
 *
 * На старом коде падают все проверки этого файла: ни цветных строк, ни
 * реестра уровней, ни файла styles/logLevels.css не существовало.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEVEL_IDS, LOG_LEVELS, isLogLevel, levelMeta, levelShort } from '../src/lib/logLevels';

const css = readFileSync(
  fileURLToPath(new URL('../src/styles/logLevels.css', import.meta.url)),
  'utf8',
);

/** Относительная яркость по WCAG 2.1. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4]
    .map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

/**
 * Значение переменной из блока темы в logLevels.css.
 *
 * У тёмного семейства блок один на все темы: карточка у них общая
 * (#232324), значит и полосы журнала одни. Отсюда селектор по суффиксу
 * имени темы, а не по имени «dark».
 */
function cssVar(theme: 'light' | 'dark', name: string): string {
  const start =
    theme === 'dark' ? css.indexOf(":root[data-theme$='dark']") : css.indexOf(':root {');
  expect(start, `в logLevels.css нет блока темы ${theme}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(match?.[1], `в теме ${theme} нет переменной ${name}`).toBeDefined();
  return match![1]!.toLowerCase();
}

/** Норма для основного текста. Строка журнала — это именно текст. */
const TEXT_MIN = 4.5;

describe('контраст цветных строк журнала', () => {
  for (const level of LOG_LEVELS) {
    describe(`«${level.title}»`, () => {
      it('в светлой теме текст на своей подложке ≥ 4,5:1', () => {
        const value = ratio(level.light.text, level.light.background);
        expect(
          value,
          `${level.light.text} на ${level.light.background} = ${value.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(TEXT_MIN);
      });

      it('в тёмной теме текст на своей подложке ≥ 4,5:1', () => {
        const value = ratio(level.dark.text, level.dark.background);
        expect(
          value,
          `${level.dark.text} на ${level.dark.background} = ${value.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(TEXT_MIN);
      });
    });
  }
});

describe('строка остаётся читаемой и на чужой подложке', () => {
  /*
   * Полосы соседних уровней стоят вплотную. Подложка одной строки — это фон
   * для глаза, разбирающего соседнюю, и при прокрутке взгляд то и дело
   * попадает на границу. Поэтому текст каждого уровня обязан читаться на
   * подложке ЛЮБОГО другого уровня той же темы, а не только на своей.
   */
  for (const theme of ['light', 'dark'] as const) {
    for (const level of LOG_LEVELS) {
      for (const other of LOG_LEVELS) {
        it(`${theme}: «${level.title}» на подложке «${other.title}»`, () => {
          const value = ratio(level[theme].text, other[theme].background);
          expect(
            value,
            `${level[theme].text} на ${other[theme].background} = ${value.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(TEXT_MIN);
        });
      }
    }
  }
});

describe('подложки различимы между собой', () => {
  /*
   * Если две полосы почти одного тона, цвет перестаёт что-либо сообщать.
   * Требование мягче текстового: это не текст, а различение поверхностей,
   * и порог здесь свой — заметная на глаз разница яркости.
   */
  it('ошибка и предупреждение не сливаются ни в одной теме', () => {
    for (const theme of ['light', 'dark'] as const) {
      const error = levelMeta('error')[theme].background;
      const warn = levelMeta('warn')[theme].background;
      expect(error, `в теме ${theme} подложки совпадают`).not.toEqual(warn);
      const value = ratio(error, warn);
      expect(value, `${theme}: ${error} и ${warn} = ${value.toFixed(2)}:1`).toBeGreaterThan(1.06);
    }
  });
});

describe('стили и реестр не разъезжаются', () => {
  for (const level of LOG_LEVELS) {
    it(`«${level.title}»: цвета в logLevels.css те же, что в реестре`, () => {
      expect(cssVar('light', `--mt-log-${level.id}-text`)).toBe(level.light.text.toLowerCase());
      expect(cssVar('light', `--mt-log-${level.id}-bg`)).toBe(level.light.background.toLowerCase());
      expect(cssVar('dark', `--mt-log-${level.id}-text`)).toBe(level.dark.text.toLowerCase());
      expect(cssVar('dark', `--mt-log-${level.id}-bg`)).toBe(level.dark.background.toLowerCase());
    });
  }

  it('тёмное семейство задано явно, а не унаследовано от светлой темы', () => {
    // Светлых подложек negative-tint/warning-tint в тёмной теме нет вовсе:
    // без своего блока строка «ошибка» стала бы почти белой полосой
    // посреди тёмного экрана.
    expect(css).toContain(":root[data-theme$='dark']");
    for (const level of LOG_LEVELS) {
      expect(cssVar('dark', `--mt-log-${level.id}-bg`)).not.toBe(
        cssVar('light', `--mt-log-${level.id}-bg`),
      );
    }
  });
});

describe('реестр уровней', () => {
  it('уровни идут от важного к подробному', () => {
    expect(LEVEL_IDS).toEqual(['error', 'warn', 'info', 'debug']);
  });

  it('у каждого уровня есть слово, а не только цвет', () => {
    // Цвет не должен быть единственным способом отличить ошибку от события:
    // иначе журнал нечитаем для не различающих цвета.
    for (const level of LOG_LEVELS) {
      expect(levelShort(level.id).trim().length).toBeGreaterThan(0);
      expect(level.title.trim().length).toBeGreaterThan(0);
      expect(level.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('чужой уровень не притворяется своим', () => {
    expect(isLogLevel('error')).toBe(true);
    expect(isLogLevel('trace')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(() => levelMeta('trace' as never)).toThrow();
  });
});
