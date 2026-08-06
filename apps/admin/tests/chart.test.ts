/**
 * Геометрия графиков: шкалы, разрывы, раскладка на узком экране.
 *
 * Проверяется не «рисуется ли что-нибудь», а четыре правила, без которых
 * график врёт или разваливается:
 *
 *   1. ПРОПУСК В ДАННЫХ — ЭТО РАЗРЫВ ЛИНИИ. null означает «не измеряли»,
 *      а не «было ноль». Соединив края, график придумал бы плавный переход
 *      через дыру в наблюдении; проведя через ноль — нарисовал бы провал,
 *      которого не было.
 *   2. НИЧЕГО НЕ ВЫХОДИТ ЗА КРАЙ. Считается ровно на 390 точках — ширине
 *      типичного телефона за вычетом полей.
 *   3. ПОДПИСИ НЕ НАЕЗЖАЮТ ДРУГ НА ДРУГА. Сто двадцать точек и шесть
 *      подписей — это разные числа, и второе зависит от ширины.
 *   4. ШКАЛА ОКРУГЛЯЕТСЯ. Верхняя засечка «37 428» заставляет читать
 *      случайную цифру вместо оценки величины.
 *
 * На старом коде падают все проверки этого файла: графиков в панели не
 * было вовсе, как и модуля lib/chart.
 */
import { describe, expect, it } from 'vitest';
import {
  arcPath,
  areaPath,
  axisTicks,
  barLayout,
  donutSlices,
  geometry,
  labelIndexes,
  labelStride,
  linePath,
  maxOf,
  niceCeil,
  paddingFor,
  segments,
  tickCount,
  timeLabel,
  xAt,
  yAt,
} from '../src/lib/chart';

/** Ширина типичного телефона за вычетом полей панели. */
const NARROW = 390;

describe('верх шкалы округляется до читаемого', () => {
  it('37 428 превращается в 50 000, а не остаётся как есть', () => {
    expect(niceCeil(37_428)).toBe(50_000);
  });

  it('точное круглое число не раздувается', () => {
    expect(niceCeil(100)).toBe(100);
    expect(niceCeil(2)).toBe(2);
  });

  it('верх всегда не меньше данных: линия не может уйти за край', () => {
    for (const value of [1, 7, 13, 99, 101, 999, 1001, 123_456]) {
      expect(niceCeil(value), `для ${value}`).toBeGreaterThanOrEqual(value);
    }
  });

  it('пустой ряд даёт единицу, а не ноль', () => {
    // Шкала от нуля до нуля не рисуется вовсе: деление на ноль превращает
    // все координаты в NaN, и SVG перестаёт показываться целиком.
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-5)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
  });

  it('засечки идут от нуля до верха включительно', () => {
    expect(axisTicks(80, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it('на низком графике засечек меньше: подписи иначе наложатся', () => {
    expect(tickCount(60)).toBeLessThan(tickCount(200));
  });
});

describe('пропуск в данных рвёт линию, а не сглаживает дыру', () => {
  it('null разделяет ряд на куски', () => {
    const runs = segments([1, 2, null, 4, 5]);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.map((p) => p.value)).toEqual([1, 2]);
    expect(runs[1]!.map((p) => p.value)).toEqual([4, 5]);
  });

  it('индексы сохраняются: точка после пропуска не съезжает влево', () => {
    const runs = segments([1, null, null, 4]);
    expect(runs[1]![0]!.index).toBe(3);
  });

  it('одиночное измерение между пропусками не теряется', () => {
    // Куском длиной один линию не построить, но кружок поставить можно —
    // иначе единственный замер за час просто исчез бы с графика.
    const runs = segments([null, 7, null]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(1);
  });

  it('ряд без единого измерения не даёт ни одного куска', () => {
    expect(segments([null, null])).toEqual([]);
  });

  it('в пути линии нет команды перехода через дыру', () => {
    const geo = geometry(400, 160);
    const runs = segments([10, 20, null, 40]);
    const paths = runs.map((run) => linePath(run, 4, 100, geo));
    // Два отдельных пути, и каждый начинается своим M: одним путём с
    // общим M дыра оказалась бы соединена прямой.
    expect(paths).toHaveLength(2);
    for (const path of paths) expect(path.startsWith('M')).toBe(true);
    expect(paths[1]!.split('M')).toHaveLength(2);
  });
});

describe('на 390 точках ничего не выходит за правый край', () => {
  const geo = geometry(NARROW, 160);

  it('область данных умещается в ширину вместе с полями', () => {
    expect(geo.plotLeft + geo.plotWidth + geo.padding.right).toBeLessThanOrEqual(NARROW);
  });

  it('последняя точка линии не задевает край даже кружком радиусом 3', () => {
    const last = xAt(119, 120, geo);
    expect(last + 3).toBeLessThanOrEqual(NARROW);
  });

  it('первая точка не залезает под подписи оси', () => {
    expect(xAt(0, 120, geo)).toBeGreaterThanOrEqual(geo.plotLeft);
  });

  it('поле слева на узком экране уже, чем на широком', () => {
    // 48 точек слева — это 12 % ширины телефона, отданные под три цифры.
    expect(paddingFor(NARROW).left).toBeLessThan(paddingFor(1200).left);
  });

  it('столбцы всех корзин лежат внутри области данных', () => {
    const count = 24;
    for (let i = 0; i < count; i += 1) {
      const bar = barLayout(i, count, geo);
      expect(bar.x, `столбец ${i} слева`).toBeGreaterThanOrEqual(geo.plotLeft - 0.01);
      expect(bar.x + bar.width, `столбец ${i} справа`).toBeLessThanOrEqual(
        geo.plotLeft + geo.plotWidth + 0.01,
      );
      // Столбец шириной в доли точки браузер не покажет вовсе.
      expect(bar.width, `столбец ${i} шириной`).toBeGreaterThanOrEqual(1);
    }
  });

  it('нулевая ширина родителя не даёт отрицательных размеров', () => {
    // Первый кадр до раскладки приходит шириной ноль. Отрицательная
    // ширина области — это невалидный SVG, который браузер не рисует.
    const zero = geometry(0, 160);
    expect(zero.plotWidth).toBeGreaterThanOrEqual(0);
    expect(zero.plotHeight).toBeGreaterThanOrEqual(0);
  });

  it('значение выше верха шкалы прижимается к верху, а не улетает вверх', () => {
    expect(yAt(150, 100, geo)).toBeGreaterThanOrEqual(geo.plotTop);
  });

  it('ноль лежит ровно на оси', () => {
    expect(yAt(0, 100, geo)).toBeCloseTo(geo.plotTop + geo.plotHeight, 5);
  });
});

describe('подписи времени не наезжают друг на друга', () => {
  const narrow = geometry(NARROW, 160);
  const wide = geometry(1200, 160);

  it('на телефоне подписей заметно меньше, чем на широком экране', () => {
    const onPhone = labelIndexes(120, narrow.plotWidth).length;
    const onDesktop = labelIndexes(120, wide.plotWidth).length;
    expect(onPhone).toBeLessThan(onDesktop);
  });

  it('подписи расставлены не ближе ширины самой подписи', () => {
    const marked = labelIndexes(120, narrow.plotWidth);
    for (let i = 1; i < marked.length; i += 1) {
      const gap = xAt(marked[i]!, 120, narrow) - xAt(marked[i - 1]!, 120, narrow);
      expect(gap, `между подписями ${marked[i - 1]} и ${marked[i]}`).toBeGreaterThanOrEqual(40);
    }
  });

  it('последний момент подписан всегда: по нему читают «докуда данные»', () => {
    for (const count of [7, 24, 97, 120]) {
      expect(labelIndexes(count, narrow.plotWidth).at(-1), `при ${count} точках`).toBe(count - 1);
    }
  });

  it('шаг не бывает нулевым: иначе список подписей строился бы вечно', () => {
    expect(labelStride(0, 100)).toBeGreaterThan(0);
    expect(labelStride(1, 0)).toBeGreaterThan(0);
    expect(labelStride(500, 10)).toBeGreaterThan(0);
  });

  it('одна точка подписана ровно один раз', () => {
    expect(labelIndexes(1, narrow.plotWidth)).toEqual([0]);
  });
});

describe('подпись времени зависит от окна', () => {
  const iso = '2026-08-05T14:20:00.000Z';

  it('сутки читаются по часам', () => {
    expect(timeLabel(iso, 24)).toMatch(/^\d{2}:\d{2}$/u);
  });

  it('неделя читается по датам: семь одинаковых «14:20» ничего не говорят', () => {
    expect(timeLabel(iso, 24 * 7)).toMatch(/^\d{2}\.\d{2}$/u);
  });

  it('битая дата не роняет график', () => {
    expect(timeLabel('не дата', 24)).toBe('');
  });
});

describe('круговая диаграмма', () => {
  it('доли складываются в полный круг', () => {
    const { slices } = donutSlices([
      { id: 'a', value: 1 },
      { id: 'b', value: 3 },
    ]);
    const span = slices.reduce((sum, s) => sum + (s.endAngle - s.startAngle), 0);
    expect(span).toBeCloseTo(Math.PI * 2, 6);
  });

  it('нулевые доли пропускаются, а не рисуются чёрточкой', () => {
    const { slices } = donutSlices([
      { id: 'a', value: 5 },
      { id: 'b', value: 0 },
    ]);
    expect(slices.map((s) => s.id)).toEqual(['a']);
  });

  it('пустой набор не даёт ни секторов, ни деления на ноль', () => {
    expect(donutSlices([]).total).toBe(0);
    expect(donutSlices([{ id: 'a', value: 0 }]).slices).toEqual([]);
  });

  it('единственная статья расхода рисует ЦЕЛОЕ кольцо, а не пустое место', () => {
    // Дуга из точки в саму себя в SVG не рисуется: путь оказывается пуст.
    // Поэтому полный круг обязан собираться из двух полудуг.
    const { slices } = donutSlices([{ id: 'a', value: 42 }]);
    const path = arcPath(75, 75, 70, 40, slices[0]!.startAngle, slices[0]!.endAngle);
    expect(path).not.toBe('');
    expect(path.match(/A/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('сектор нулевой ширины даёт пустой путь, а не «M NaN»', () => {
    expect(arcPath(75, 75, 70, 40, 1, 1)).toBe('');
  });
});

describe('заливка площади', () => {
  it('замыкается по нижней оси, а не улетает в ноль координат', () => {
    const geo = geometry(400, 160);
    const path = areaPath(
      [
        { index: 0, value: 10 },
        { index: 1, value: 20 },
      ],
      2,
      100,
      geo,
    );
    expect(path.endsWith('Z')).toBe(true);
    expect(path).toContain(String(geo.plotTop + geo.plotHeight));
  });

  it('по одной точке площадь не строится: это была бы линия нулевой ширины', () => {
    expect(areaPath([{ index: 0, value: 10 }], 1, 100, geometry(400, 160))).toBe('');
  });
});

describe('максимум ряда', () => {
  it('пропуски не считаются нулями и не занижают шкалу', () => {
    expect(maxOf([null, 5, null, 12])).toBe(12);
  });

  it('ряд из одних пропусков даёт ноль, а не NaN', () => {
    expect(maxOf([null, null])).toBe(0);
  });
});
