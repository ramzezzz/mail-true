/**
 * Геометрия графиков: шкалы, засечки, пути SVG.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СВОЙ КОД, А НЕ БИБЛИОТЕКА
 * ------------------------------------------------------------------
 * Панель собирается в ОДИН файл и отдаётся администратору по сети, которая
 * в аварии бывает узкой. Любая из ходовых библиотек рисования — это от 90
 * до 400 КБ после сжатия ради трёх графиков, причём тянет она за собой
 * собственную систему цветов, которую всё равно пришлось бы перекрывать
 * под девять тем. Здесь же нужны линия, столбец и доля — это полсотни строк
 * арифметики, которые к тому же проверяются юнит-тестами целиком.
 *
 * Второе соображение — строгая политика содержимого. Библиотеки любят
 * встраивать стили и вычислять размеры через созданные на лету элементы;
 * с нашей CSP это отлаживается дольше, чем пишется своя арифметика.
 *
 * ------------------------------------------------------------------
 * ВСЁ ЗДЕСЬ — ЧИСТЫЕ ФУНКЦИИ
 * ------------------------------------------------------------------
 * Ни одна не трогает DOM. Это сделано ради проверок: раскладку графика на
 * узком экране можно посчитать и сравнить с шириной, не поднимая браузер
 * (см. tests/chart.test.ts, где считается ровно 390 точек).
 */

/** Отступы внутри области рисования: место под подписи осей. */
export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartGeometry {
  width: number;
  height: number;
  padding: ChartPadding;
  /** Область самих данных. */
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
}

/**
 * Отступы под ширину.
 *
 * На узком экране левое поле под подписи оси урезается: на 390 точках
 * привычные 48 точек слева — это 12 % ширины графика, отданные под три
 * цифры. Подписи там короче (тысячи вместо байтов), и 34 точек хватает.
 */
export function paddingFor(width: number): ChartPadding {
  const narrow = width < 480;
  return {
    top: 10,
    // Правое поле не ноль: последняя точка линии рисуется КРУЖКОМ радиусом
    // в три точки, и без поля половина кружка ушла бы за край.
    right: narrow ? 10 : 14,
    bottom: narrow ? 20 : 22,
    left: narrow ? 34 : 46,
  };
}

export function geometry(width: number, height: number, padding = paddingFor(width)): ChartGeometry {
  return {
    width,
    height,
    padding,
    plotLeft: padding.left,
    plotTop: padding.top,
    // Ширина области данных не может стать отрицательной: при совсем узком
    // родителе (панель ещё не разложилась, ширина 0) отрицательные размеры
    // дают невалидный SVG, и браузер перестаёт рисовать график вовсе.
    plotWidth: Math.max(0, width - padding.left - padding.right),
    plotHeight: Math.max(0, height - padding.top - padding.bottom),
  };
}

/**
 * Верх шкалы — «круглое» число не меньше данных.
 *
 * Без округления верхняя засечка получалась бы вида «37 428», и глаз
 * тратил бы время на чтение случайной цифры вместо оценки величины.
 * Ноль превращается в единицу: шкала от нуля до нуля не рисуется вовсе,
 * а пустой график должен выглядеть пустым, а не сломанным.
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Значения засечек снизу вверх, включая ноль и верх шкалы. */
export function axisTicks(max: number, count = 4): number[] {
  const top = niceCeil(max);
  const steps = Math.max(1, count);
  return Array.from({ length: steps + 1 }, (_, i) => (top / steps) * i);
}

/**
 * Сколько засечек по вертикали помещается по высоте.
 *
 * Подпись засечки — это строка высотой около 14 точек. Ставить их чаще
 * значит наложить одну на другую: получится серая полоса вместо цифр.
 */
export function tickCount(plotHeight: number): number {
  if (plotHeight < 70) return 2;
  if (plotHeight < 140) return 3;
  return 4;
}

/** Точка X для индекса в ряду. */
export function xAt(index: number, count: number, geo: ChartGeometry): number {
  if (count <= 1) return geo.plotLeft + geo.plotWidth / 2;
  return geo.plotLeft + (geo.plotWidth * index) / (count - 1);
}

/** Точка Y для значения при заданном верхе шкалы. */
export function yAt(value: number, max: number, geo: ChartGeometry): number {
  const top = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(value, 0), top);
  return geo.plotTop + geo.plotHeight - (clamped / top) * geo.plotHeight;
}

/**
 * Сплошные куски ряда: индексы, между которыми нет пропусков.
 *
 * Пропуск (null) означает «в этот момент мы НЕ ИЗМЕРЯЛИ», а не «было
 * ноль». Разница видна на экране: недоступная очередь и пустая очередь
 * должны выглядеть по-разному. Соединив их одной линией, мы нарисовали бы
 * падение до нуля там, где на самом деле дыра в наблюдении, — и человек
 * искал бы причину «провала», которого не было.
 *
 * Одиночная точка между двумя пропусками возвращается куском длиной один:
 * линию по ней не построить, но кружок поставить можно и нужно — иначе
 * единственное измерение за час просто исчезло бы с графика.
 */
export function segments<T>(values: readonly (T | null)[]): Array<Array<{ index: number; value: T }>> {
  const result: Array<Array<{ index: number; value: T }>> = [];
  let current: Array<{ index: number; value: T }> = [];
  values.forEach((value, index) => {
    if (value === null || value === undefined) {
      if (current.length > 0) result.push(current);
      current = [];
      return;
    }
    current.push({ index, value });
  });
  if (current.length > 0) result.push(current);
  return result;
}

/** Путь SVG по точкам ряда (без пропусков внутри). */
export function linePath(
  points: ReadonlyArray<{ index: number; value: number }>,
  count: number,
  max: number,
  geo: ChartGeometry,
): string {
  if (points.length === 0) return '';
  return points
    .map((point, i) => {
      const x = round(xAt(point.index, count, geo));
      const y = round(yAt(point.value, max, geo));
      return `${i === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
}

/** Замкнутый путь под линией — для мягкой заливки площади. */
export function areaPath(
  points: ReadonlyArray<{ index: number; value: number }>,
  count: number,
  max: number,
  geo: ChartGeometry,
): string {
  if (points.length < 2) return '';
  const base = round(geo.plotTop + geo.plotHeight);
  const first = round(xAt(points[0]!.index, count, geo));
  const last = round(xAt(points[points.length - 1]!.index, count, geo));
  return `${linePath(points, count, max, geo)} L${last} ${base} L${first} ${base} Z`;
}

/**
 * Через сколько подписей по горизонтали ставить одну.
 *
 * Подпись времени — это «14:20», примерно 34 точки шириной. Если ставить
 * их чаще, соседние наезжают друг на друга и не читается ни одна. На 390
 * точках ширины это особенно заметно: подписей помещается пять-шесть,
 * а точек на графике сто двадцать.
 */
export function labelStride(count: number, plotWidth: number, labelPx = 46): number {
  if (count <= 1) return 1;
  const fits = Math.max(2, Math.floor(plotWidth / labelPx));
  return Math.max(1, Math.ceil(count / fits));
}

/** Индексы, у которых рисуется подпись: всегда включают первый и последний. */
export function labelIndexes(count: number, plotWidth: number, labelPx = 46): number[] {
  if (count === 0) return [];
  const stride = labelStride(count, plotWidth, labelPx);
  const result: number[] = [];
  for (let i = 0; i < count; i += stride) result.push(i);
  const last = count - 1;
  /*
   * Последняя подпись обязана быть: по ней читают «до какого момента
   * данные». Но она встаёт не по шагу, а на самом краю, и до предыдущей
   * от неё может остаться меньше расчётного промежутка — тогда предыдущую
   * убираем.
   *
   * Порог — ПОЛНЫЙ шаг, а не половина. С половиной проверка на 390 точках
   * поймала наложение: при 120 точках и шаге 12 последними оказывались
   * 108 и 119, между ними 11 шагов, то есть 32 точки на подпись шириной
   * в 34 — «14:20» и «14:31» налезали друг на друга.
   *
   * Первую подпись не выбрасываем никогда: при шаге больше числа точек
   * в списке остаётся только она, и без неё график остался бы вовсе
   * без подписей слева.
   */
  if (result[result.length - 1] !== last) {
    if (result.length > 1 && last - (result[result.length - 1] ?? 0) < stride) result.pop();
    result.push(last);
  }
  return result;
}

/** Доля круговой диаграммы. */
export interface DonutSlice {
  id: string;
  value: number;
  /** Доля от целого, 0..1. */
  share: number;
  startAngle: number;
  endAngle: number;
}

/**
 * Разбиение круга по долям.
 *
 * Углы отсчитываются от «двенадцати часов» по часовой стрелке — так
 * привычнее читать. Нулевые доли пропускаются: сектор нулевой ширины
 * рисуется как невидимая чёрточка, но продолжает занимать место в легенде
 * и мешать наведению мыши.
 */
export function donutSlices(
  items: ReadonlyArray<{ id: string; value: number }>,
): { slices: DonutSlice[]; total: number } {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total <= 0) return { slices: [], total: 0 };
  let angle = -Math.PI / 2;
  const slices: DonutSlice[] = [];
  for (const item of items) {
    const value = Math.max(0, item.value);
    if (value === 0) continue;
    const share = value / total;
    const next = angle + share * Math.PI * 2;
    slices.push({ id: item.id, value, share, startAngle: angle, endAngle: next });
    angle = next;
  }
  return { slices, total };
}

/**
 * Путь сектора кольца.
 *
 * Отдельный случай для доли, занимающей ВЕСЬ круг: дуга из точки в саму
 * себя в SVG не рисуется вовсе (начало совпадает с концом — путь пустой),
 * и единственная статья расхода давала бы пустое место вместо кольца.
 * Поэтому целое кольцо собирается из двух полудуг.
 */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startAngle: number,
  endAngle: number,
): string {
  const span = endAngle - startAngle;
  if (span <= 0) return '';
  if (span >= Math.PI * 2 - 1e-6) {
    const half = startAngle + Math.PI;
    return [
      arcPath(cx, cy, outer, inner, startAngle, half),
      arcPath(cx, cy, outer, inner, half, startAngle + Math.PI * 2 - 1e-7),
    ].join(' ');
  }
  const large = span > Math.PI ? 1 : 0;
  const p = (radius: number, angle: number): [number, number] => [
    round(cx + radius * Math.cos(angle)),
    round(cy + radius * Math.sin(angle)),
  ];
  const [x1, y1] = p(outer, startAngle);
  const [x2, y2] = p(outer, endAngle);
  const [x3, y3] = p(inner, endAngle);
  const [x4, y4] = p(inner, startAngle);
  return (
    `M${x1} ${y1} A${round(outer)} ${round(outer)} 0 ${large} 1 ${x2} ${y2} ` +
    `L${x3} ${y3} A${round(inner)} ${round(inner)} 0 ${large} 0 ${x4} ${y4} Z`
  );
}

/** Раскладка группы столбцов: где стоит каждый и какой ширины. */
export interface BarLayout {
  x: number;
  width: number;
}

/**
 * Ширина и положение столбцов.
 *
 * Промежуток задан ДОЛЕЙ шага, а не числом точек: на узком экране
 * фиксированный промежуток в четыре точки съедал бы половину столбца, и
 * при двух десятках столбцов от них оставались бы волоски. Минимальная
 * ширина в одну точку — чтобы столбец не исчез совсем.
 */
export function barLayout(index: number, count: number, geo: ChartGeometry, gapShare = 0.25): BarLayout {
  const step = count > 0 ? geo.plotWidth / count : geo.plotWidth;
  const width = Math.max(1, step * (1 - gapShare));
  return { x: geo.plotLeft + step * index + (step - width) / 2, width };
}

/** Округление до сотых: длинные дроби раздувают разметку без всякой пользы. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Подпись времени под шириной окна.
 *
 * У окна в сутки нужен час, у окна в неделю — день: «14:20» семь дней
 * подряд не отвечает на вопрос «когда именно». Порог в 48 часов, а не
 * в 24: ровно суточное окно ещё читается по часам.
 */
export function timeLabel(iso: string, windowHours: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (windowHours > 48) {
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Максимум ряда с пропусками; 0, если измерений нет вовсе. */
export function maxOf(values: readonly (number | null)[]): number {
  let max = 0;
  for (const value of values) {
    if (value !== null && value !== undefined && Number.isFinite(value) && value > max) max = value;
  }
  return max;
}
