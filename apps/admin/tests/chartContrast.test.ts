/**
 * Читаемость графиков во всех темах панели.
 *
 * Контраст здесь СЧИТАЕТСЯ по формуле WCAG 2.1, а различимость рядов —
 * по расстоянию ΔE76 в Lab. Ни то, ни другое не сверяется со списком
 * «правильных» строк: цвет, подкрученный однажды на глаз, проверка
 * заметит — и в светлой теме, и в тёмной, и в фирменном графите.
 *
 * ------------------------------------------------------------------
 * КАКИЕ ИМЕННО НОРМЫ И ПОЧЕМУ
 * ------------------------------------------------------------------
 * Линия графика и столбец — это НЕ текст, и норма для них своя: WCAG 2.1,
 * критерий 1.4.11 «Контраст нетекстового содержимого», порог 3:1. Здесь
 * взят порог выше — 4,5:1, как для текста: теми же цветами набраны числа
 * в легенде и в подсказке, а строка «Доставлено: 1 248» — это уже текст.
 * Держать два набора цветов ради одной ступени контраста бессмысленно.
 *
 * Различимость рядов контрастом НЕ проверяется, и это важно понимать:
 * синий и фиолетовый одинаковой светлоты дают отношение 1,0:1, будучи
 * при этом прекрасно различимыми. Контраст отвечает на вопрос «видно ли
 * линию на фоне», а не «отличается ли она от соседней». На второй вопрос
 * отвечает расстояние в перцептивном пространстве; порог 20 — общепринятая
 * граница «явно разные цвета» (ΔE около 2,3 — едва заметная разница).
 *
 * ------------------------------------------------------------------
 * ЦВЕТ НЕ ДОЛЖЕН БЫТЬ ЕДИНСТВЕННЫМ ОТЛИЧИЕМ
 * ------------------------------------------------------------------
 * Примерно каждый двенадцатый мужчина не различает красный и зелёный.
 * На графике «доставлено/отбито» он увидел бы две одинаковые линии.
 * Поэтому проверяется и второй признак: своя штриховка у линии, свой
 * узор у заливки, своё слово в легенде.
 *
 * На старом коде падают все проверки этого файла: ни графиков, ни реестра
 * рядов, ни файла styles/charts.css не существовало.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_THEMES } from '../src/appearance/adminThemes';
import {
  ALL_SERIES,
  CHART_HUES,
  CHART_PALETTE,
  CHART_SURFACES,
  DISK_SERIES,
  FLOW_SERIES,
  QUEUE_SERIES,
  RESOURCE_SERIES,
  chartColor,
  seriesOf,
  type ChartHue,
  type ChartSurface,
} from '../src/lib/chartSeries';

const css = readFileSync(
  fileURLToPath(new URL('../src/styles/charts.css', import.meta.url)),
  'utf8',
);

/* ------------------------------------------------------------------ */
/* Расчёты                                                             */
/* ------------------------------------------------------------------ */

function channels(hex: string): number[] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
}

/** Относительная яркость по WCAG 2.1. */
function luminance(hex: string): number {
  const linear = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Координаты Lab (D65) — для расстояния между цветами. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** ΔE76: прямое расстояние в Lab. Проще CIEDE2000 и для порога 20 хватает. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Значение переменной из блока темы в charts.css. */
function cssVar(block: ChartSurface, name: string): string {
  const marker =
    block === 'light' ? ':root {' : `:root[data-theme='${block}']`;
  const start = css.indexOf(marker);
  expect(start, `в charts.css нет блока ${block}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const match = body.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(match?.[1], `в блоке ${block} нет переменной ${name}`).toBeDefined();
  return match![1]!.toLowerCase();
}

/** Норма для текста; линиям хватило бы 3:1 (WCAG 1.4.11). */
const TEXT_MIN = 4.5;
/** Граница «явно разные цвета» в ΔE76. */
const DISTINCT_MIN = 20;

/**
 * Какое семейство цветов достаётся теме.
 *
 * Цветные светлые темы не красят карточку — график лежит у них на той же
 * белой поверхности, что в светлой теме. Свой набор нужен только там, где
 * поверхность другая: у тёмной темы почты и у графита.
 */
function familyOf(themeId: string, kind: 'light' | 'dark'): ChartSurface {
  if (themeId === 'graphite') return 'graphite';
  return kind === 'dark' ? 'dark' : 'light';
}

/* ------------------------------------------------------------------ */
/* Проверки                                                            */
/* ------------------------------------------------------------------ */

describe('ряд виден на поверхности своей темы', () => {
  // Перебираются ВСЕ темы реестра, а не три семейства: так новая тема,
  // добавленная кем-то другим, сразу попадёт под проверку.
  for (const theme of ADMIN_THEMES) {
    const family = familyOf(theme.id, theme.kind);
    describe(`тема «${theme.title}»`, () => {
      it('поверхность темы совпадает с той, под которую считаны цвета', () => {
        // Если тема покрасит карточку в свой цвет, семейство перестанет
        // соответствовать, и все замеры ниже станут проверкой не того.
        expect(
          theme.surface.toLowerCase(),
          `карточка темы «${theme.title}» — ${theme.surface}, а цвета рядов считаны для ${CHART_SURFACES[family]}`,
        ).toBe(CHART_SURFACES[family]);
      });

      for (const hue of CHART_HUES) {
        it(`${hue}: контраст к карточке ≥ 4,5:1`, () => {
          const color = chartColor(family, hue);
          const value = ratio(color, theme.surface);
          expect(
            value,
            `${color} на ${theme.surface} = ${value.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(TEXT_MIN);
        });
      }
    });
  }
});

describe('ряды одного графика различимы между собой', () => {
  const charts = [
    ['почтовый поток', FLOW_SERIES],
    ['ресурсы', RESOURCE_SERIES],
    ['очередь', QUEUE_SERIES],
    ['место на диске', DISK_SERIES],
  ] as const;

  for (const family of ['light', 'dark', 'graphite'] as const) {
    for (const [name, list] of charts) {
      it(`${family}: «${name}» — все пары расходятся не меньше чем на ΔE ${DISTINCT_MIN}`, () => {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const a = chartColor(family, list[i]!.hue);
            const b = chartColor(family, list[j]!.hue);
            const distance = deltaE(a, b);
            expect(
              distance,
              `«${list[i]!.title}» ${a} и «${list[j]!.title}» ${b} = ΔE ${distance.toFixed(1)}`,
            ).toBeGreaterThanOrEqual(DISTINCT_MIN);
          }
        }
      });
    }
  }

  it('одному графику не достаётся один тон дважды', () => {
    for (const [name, list] of charts) {
      const hues = list.map((s) => s.hue);
      expect(new Set(hues).size, `в графике «${name}» тон повторяется`).toBe(hues.length);
    }
  });
});

describe('цвет — не единственное отличие ряда', () => {
  const charts = [FLOW_SERIES, RESOURCE_SERIES, QUEUE_SERIES, DISK_SERIES];

  it('у каждого ряда есть слово, а не только цвет', () => {
    for (const series of ALL_SERIES) {
      expect(series.title.trim().length, `у ряда ${series.id} нет названия`).toBeGreaterThan(0);
    }
  });

  it('штриховка линий в пределах графика не повторяется', () => {
    // Не различающий цвета человек отличает ряды именно по штриху.
    // Две сплошные линии для него — одна и та же линия.
    for (const list of charts) {
      const dashes = list.map((s) => s.dash);
      expect(new Set(dashes).size, `повтор штриховки: ${dashes.join(' | ')}`).toBe(dashes.length);
    }
  });

  it('узор заливки в пределах графика не повторяется', () => {
    // Столбец и сектор кольца — это площадь, штрихом линии их не отличить.
    for (const list of charts) {
      const patterns = list.map((s) => s.pattern);
      expect(new Set(patterns).size, `повтор узора: ${patterns.join(' | ')}`).toBe(patterns.length);
    }
  });
});

describe('стили и реестр не разъезжаются', () => {
  for (const family of ['light', 'dark', 'graphite'] as const) {
    it(`${family}: цвета в charts.css те же, что в реестре`, () => {
      for (const hue of CHART_HUES) {
        expect(cssVar(family, `--mt-chart-${hue}`), `${family}/${hue}`).toBe(
          CHART_PALETTE[family][hue].toLowerCase(),
        );
      }
    });
  }

  it('тёмные наборы заданы явно, а не унаследованы от светлого', () => {
    // Без своего блока графит и тёмная тема получили бы светлые цвета
    // рядов: тёмно-синяя линия на графитовой карточке — 1,4:1, то есть
    // невидимая.
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toContain(":root[data-theme='graphite']");
    for (const hue of CHART_HUES) {
      expect(cssVar('dark', `--mt-chart-${hue}`), hue).not.toBe(
        cssVar('light', `--mt-chart-${hue}`),
      );
      expect(cssVar('graphite', `--mt-chart-${hue}`), hue).not.toBe(
        cssVar('light', `--mt-chart-${hue}`),
      );
    }
  });
});

describe('подписи осей читаются в каждой теме', () => {
  for (const theme of ADMIN_THEMES) {
    it(`«${theme.title}»: вторичный текст на карточке ≥ 4,5:1`, () => {
      // Подписи засечек и легенда набраны --mt-color-text-secondary.
      // Мелкий шрифт (10–11px) прощает ещё меньше, чем обычный.
      const value = ratio(theme.textSecondary, theme.surface);
      expect(
        value,
        `${theme.textSecondary} на ${theme.surface} = ${value.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(TEXT_MIN);
    });
  }
});

describe('реестр рядов', () => {
  it('неизвестный ряд не роняет график, а становится серым сплошным', () => {
    const unknown = seriesOf(FLOW_SERIES, 'какого-то-нового-состояния-нет');
    expect(unknown.hue).toBe('gray');
    expect(unknown.dash).toBe('');
  });

  it('известный ряд находится по идентификатору', () => {
    expect(seriesOf(FLOW_SERIES, 'sent').title).toBe('Доставлено');
  });

  it('состояния письма перечислены все: неучтённое пропало бы с графика', () => {
    // Значения те же, что в FlowStatus на сервере (admin/mail-log.ts).
    expect(FLOW_SERIES.map((s) => s.id).sort()).toEqual(
      ['bounced', 'deferred', 'expired', 'held', 'rejected', 'sent'].sort(),
    );
  });
});
