/**
 * Графики на SVG: линия, столбцы, кольцо, полоса.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ГРАФИК МЕРЯЕТ СЕБЯ САМ, А НЕ РАСТЯГИВАЕТСЯ ЧЕРЕЗ viewBox
 * ------------------------------------------------------------------
 * Растянуть SVG по ширине родителя можно одной строкой — viewBox плюс
 * width: 100%. Но тогда вместе с картинкой масштабируется и ТЕКСТ: на
 * узком экране подписи осей уезжают до шести-семи точек и перестают
 * читаться, а на широком раздуваются до двадцати и спорят с остальным
 * интерфейсом. Дашборд смотрят и с телефона, и с большого экрана, поэтому
 * график узнаёт свою настоящую ширину (ResizeObserver) и рисуется прямо
 * в ней: подписи всегда одного размера, а частота засечек подбирается под
 * ширину (см. labelIndexes в lib/chart.ts).
 *
 * ------------------------------------------------------------------
 * ПРОПУСК В ДАННЫХ — ЭТО РАЗРЫВ ЛИНИИ
 * ------------------------------------------------------------------
 * null означает «не измеряли», а не «было ноль». Линия в этом месте
 * рвётся. Соединив края, мы нарисовали бы плавный переход через дыру в
 * наблюдении, то есть придумали бы данные; проведя через ноль — показали
 * бы провал, которого не было. Разрыв — единственный честный вариант,
 * и он же сразу виден: «здесь наблюдения не было».
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  arcPath,
  areaPath,
  axisTicks,
  barLayout,
  donutSlices,
  geometry,
  labelIndexes,
  linePath,
  maxOf,
  niceCeil,
  round,
  segments,
  tickCount,
  xAt,
  yAt,
} from '../lib/chart';
import { hueVar, type ChartPattern, type ChartSeries } from '../lib/chartSeries';
import styles from './Charts.module.css';
import '../styles/charts.css';

/* ------------------------------------------------------------------ */
/* Ширина                                                              */
/* ------------------------------------------------------------------ */

/**
 * Настоящая ширина элемента.
 *
 * Запасное значение (640) нужно для первого кадра и для среды без
 * ResizeObserver: без него первый кадр рисовался бы шириной ноль, а SVG
 * с нулевой шириной браузер не показывает вовсе — на медленной машине это
 * выглядело бы как мигание пустого места на месте графиков.
 */
export function useElementWidth(fallback = 640): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const apply = (value: number): void => {
      // Округляем до целой точки: дробные ширины от масштабирования
      // страницы иначе перерисовывали бы график на каждый пиксель прокрутки.
      const next = Math.max(0, Math.round(value));
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    };
    apply(node.getBoundingClientRect().width || fallback);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

/* ------------------------------------------------------------------ */
/* Узоры заливки                                                       */
/* ------------------------------------------------------------------ */

/**
 * Узоры для заливок — второй, нецветовой признак ряда.
 *
 * Столбец и сектор кольца — это площадь, и штриховкой линии их не
 * различить. Узор решает ту же задачу: понять, какой ряд перед тобой,
 * не различая цветов. Узоры сделаны разреженными (штрих на четыре точки),
 * чтобы не превращать заливку в шум.
 *
 * ЦВЕТ ШТРИХА — из темы, а не белый. Раньше здесь стояло прибитое
 * `rgb(255 255 255 / 55%)`, и в тёмной теме с графитом штриховка ложилась
 * белым по светлому: контраст 1,31–1,76:1 при пороге 3:1. То есть второй
 * признак ряда, ради которого узоры и заведены, был не виден ровно тем,
 * кому он предназначен. Теперь берётся --mt-chart-pattern — цвет карточки,
 * см. lib/chartSeries.ts (chartPatternInk) и styles/charts.css.
 */
function PatternDefs({ prefix }: { prefix: string }) {
  const stroke = { stroke: 'var(--mt-chart-pattern)', strokeWidth: 1.2 };
  return (
    <defs>
      <pattern id={`${prefix}-diagonal`} width="6" height="6" patternUnits="userSpaceOnUse">
        <path d="M0 6 L6 0" {...stroke} />
      </pattern>
      <pattern id={`${prefix}-reverse`} width="6" height="6" patternUnits="userSpaceOnUse">
        <path d="M0 0 L6 6" {...stroke} />
      </pattern>
      <pattern id={`${prefix}-grid`} width="6" height="6" patternUnits="userSpaceOnUse">
        <path d="M0 0 L6 6 M0 6 L6 0" {...stroke} />
      </pattern>
      <pattern id={`${prefix}-dots`} width="6" height="6" patternUnits="userSpaceOnUse">
        <circle cx="3" cy="3" r="1.3" fill="var(--mt-chart-pattern)" />
      </pattern>
      <pattern id={`${prefix}-dense`} width="4" height="4" patternUnits="userSpaceOnUse">
        <path d="M0 4 L4 0" {...stroke} />
      </pattern>
    </defs>
  );
}

function patternFill(prefix: string, pattern: ChartPattern): string | null {
  return pattern === 'solid' ? null : `url(#${prefix}-${pattern})`;
}

/* ------------------------------------------------------------------ */
/* Легенда                                                             */
/* ------------------------------------------------------------------ */

export interface LegendEntry {
  series: ChartSeries;
  /** Число рядом с названием: итог ряда за окно. */
  value?: ReactNode;
}

export function Legend({ entries }: { entries: readonly LegendEntry[] }) {
  return (
    <div className={styles.legend}>
      {entries.map(({ series, value }) => (
        <span key={series.id} className={styles.legendItem}>
          {/*
            В метке — тот же штрих, что у линии. Квадратик одного цвета
            обманывал бы: в легенде ряды выглядели бы разными, а на графике
            сливались бы для не различающего цвета.
          */}
          <svg className={styles.legendMark} viewBox="0 0 22 10" aria-hidden="true">
            <line
              x1="0"
              y1="5"
              x2="22"
              y2="5"
              stroke={hueVar(series.hue)}
              strokeWidth="2.5"
              strokeDasharray={series.dash || undefined}
              strokeLinecap="round"
            />
          </svg>
          <span>{series.title}</span>
          {value !== undefined && <span className={styles.legendValue}>{value}</span>}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Линейный график                                                     */
/* ------------------------------------------------------------------ */

export interface LineSeriesData {
  series: ChartSeries;
  /** По точке на каждый момент; null — не измеряли. */
  values: readonly (number | null)[];
}

export interface LineChartProps {
  /** Подписи моментов времени — по одной на точку. */
  labels: readonly string[];
  series: readonly LineSeriesData[];
  height?: number;
  /** Верх шкалы, если он известен заранее (например, 100 для процентов). */
  fixedMax?: number;
  /** Как показать значение в подсказке и на оси. */
  format?: (value: number) => string;
  /** Что написать, когда данных нет вовсе. */
  emptyText?: string;
  /** Заливать площадь под первой линией — для одиночных рядов. */
  area?: boolean;
  ariaLabel: string;
}

export function LineChart({
  labels,
  series,
  height = 160,
  fixedMax,
  format = (v) => String(Math.round(v)),
  emptyText = 'Данных за выбранный период нет',
  area = false,
  ariaLabel,
}: LineChartProps) {
  const [ref, width] = useElementWidth();
  const prefix = useId().replace(/[^a-zA-Z0-9-]/gu, '');
  const [hover, setHover] = useState<number | null>(null);

  const count = labels.length;
  const geo = useMemo(() => geometry(width, height), [width, height]);
  const max = useMemo(() => {
    if (fixedMax !== undefined) return fixedMax;
    return niceCeil(Math.max(...series.map((s) => maxOf(s.values)), 0));
  }, [fixedMax, series]);

  const hasData = series.some((s) => s.values.some((v) => v !== null && v !== undefined));

  const onMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (count === 0 || geo.plotWidth <= 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const relative = (event.clientX - rect.left - geo.plotLeft) / geo.plotWidth;
      const index = Math.round(relative * Math.max(1, count - 1));
      setHover(Math.min(count - 1, Math.max(0, index)));
    },
    [count, geo],
  );

  if (!hasData) {
    return (
      <div ref={ref} className={styles.box}>
        <div className={styles.empty}>{emptyText}</div>
      </div>
    );
  }

  const ticks = axisTicks(max, tickCount(geo.plotHeight));
  const marked = labelIndexes(count, geo.plotWidth);
  const shown = hover ?? count - 1;

  return (
    <div ref={ref} className={styles.box}>
      <div className={styles.tip}>
        {labels[shown] ?? ''}
        {series.map((s) => {
          const value = s.values[shown];
          return (
            <span key={s.series.id}>
              {' · '}
              {s.series.title}:{' '}
              <span className={styles.tipValue}>
                {value === null || value === undefined ? 'не измеряли' : format(value)}
              </span>
            </span>
          );
        })}
      </div>
      <svg
        className={styles.svg}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* Сетка: горизонтали по засечкам, подписи слева */}
        {ticks.map((tick) => {
          const y = round(yAt(tick, max, geo));
          return (
            <g key={tick}>
              <line
                className={styles.gridLine}
                x1={geo.plotLeft}
                y1={y}
                x2={geo.plotLeft + geo.plotWidth}
                y2={y}
              />
              <text
                className={`${styles.axisText} ${styles.axisTextRight}`}
                x={geo.plotLeft - 5}
                y={y + 3}
              >
                {format(tick)}
              </text>
            </g>
          );
        })}

        {/* Подписи времени: не все, а сколько влезает без наложения */}
        {marked.map((index) => (
          <text
            key={index}
            className={`${styles.axisText} ${styles.axisTextMiddle}`}
            x={round(clampLabelX(xAt(index, count, geo), geo.width))}
            y={height - 6}
          >
            {labels[index]}
          </text>
        ))}

        {area &&
          series
            .slice(0, 1)
            .map((s) =>
              segments(s.values).map((run, i) => (
                <path
                  key={`${s.series.id}-area-${i}`}
                  d={areaPath(run, count, max, geo)}
                  fill={hueVar(s.series.hue)}
                  fillOpacity="var(--mt-chart-area-alpha)"
                />
              )),
            )}

        {/* Сами линии; каждый сплошной кусок — свой путь (разрывы честные) */}
        {series.map((s) =>
          segments(s.values).map((run, i) =>
            run.length === 1 ? (
              <circle
                key={`${s.series.id}-dot-${i}`}
                className={styles.dot}
                cx={round(xAt(run[0]!.index, count, geo))}
                cy={round(yAt(run[0]!.value, max, geo))}
                r="2.5"
                fill={hueVar(s.series.hue)}
              />
            ) : (
              <path
                key={`${s.series.id}-line-${i}`}
                className={styles.line}
                d={linePath(run, count, max, geo)}
                stroke={hueVar(s.series.hue)}
                strokeDasharray={s.series.dash || undefined}
              />
            ),
          ),
        )}

        {/* Нить под курсором и точки на ней */}
        {hover !== null && (
          <>
            <line
              className={styles.cursorLine}
              x1={round(xAt(hover, count, geo))}
              y1={geo.plotTop}
              x2={round(xAt(hover, count, geo))}
              y2={geo.plotTop + geo.plotHeight}
            />
            {series.map((s) => {
              const value = s.values[hover];
              if (value === null || value === undefined) return null;
              return (
                <circle
                  key={`${s.series.id}-hover`}
                  className={styles.dot}
                  cx={round(xAt(hover, count, geo))}
                  cy={round(yAt(value, max, geo))}
                  r="3"
                  fill={hueVar(s.series.hue)}
                />
              );
            })}
          </>
        )}

        <line
          className={styles.axisLine}
          x1={geo.plotLeft}
          y1={geo.plotTop + geo.plotHeight}
          x2={geo.plotLeft + geo.plotWidth}
          y2={geo.plotTop + geo.plotHeight}
        />
        <PatternDefs prefix={prefix} />
      </svg>
      <Legend entries={series.map((s) => ({ series: s.series }))} />
    </div>
  );
}

/**
 * Подпись у самого края уезжает внутрь.
 *
 * Текст выравнивается по середине, поэтому первая подпись наполовину
 * вылезала бы за левый край, а последняя — за правый. На широком экране
 * это мелочь, на 390 точках — обрезанное время.
 */
function clampLabelX(x: number, width: number): number {
  const half = 18;
  return Math.min(Math.max(x, half), width - half);
}

/* ------------------------------------------------------------------ */
/* Столбчатая диаграмма (с накоплением)                                */
/* ------------------------------------------------------------------ */

export interface BarChartProps {
  labels: readonly string[];
  series: readonly LineSeriesData[];
  height?: number;
  /** Складывать ряды друг на друга (поток писем) или ставить рядом. */
  stacked?: boolean;
  format?: (value: number) => string;
  emptyText?: string;
  ariaLabel: string;
}

export function BarChart({
  labels,
  series,
  height = 150,
  stacked = true,
  format = (v) => String(Math.round(v)),
  emptyText = 'Данных за выбранный период нет',
  ariaLabel,
}: BarChartProps) {
  const [ref, width] = useElementWidth();
  const prefix = useId().replace(/[^a-zA-Z0-9-]/gu, '');
  const [hover, setHover] = useState<number | null>(null);
  const count = labels.length;
  const geo = useMemo(() => geometry(width, height), [width, height]);

  const columnTotals = useMemo(
    () =>
      Array.from({ length: count }, (_, i) =>
        series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
      ),
    [count, series],
  );
  const max = useMemo(
    () =>
      niceCeil(
        stacked ? Math.max(...columnTotals, 0) : Math.max(...series.map((s) => maxOf(s.values)), 0),
      ),
    [columnTotals, series, stacked],
  );
  const hasData = columnTotals.some((v) => v > 0);

  if (!hasData) {
    return (
      <div ref={ref} className={styles.box}>
        <div className={styles.empty}>{emptyText}</div>
      </div>
    );
  }

  const ticks = axisTicks(max, tickCount(geo.plotHeight));
  const marked = labelIndexes(count, geo.plotWidth);
  const shown = hover ?? null;
  const base = geo.plotTop + geo.plotHeight;

  return (
    <div ref={ref} className={styles.box}>
      <div className={styles.tip}>
        {shown === null
          ? 'Наведите на столбец, чтобы увидеть числа'
          : `${labels[shown] ?? ''}${series
              .map((s) => ` · ${s.series.title}: ${format(s.values[shown] ?? 0)}`)
              .join('')}`}
      </div>
      <svg
        className={styles.svg}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onPointerLeave={() => setHover(null)}
      >
        <PatternDefs prefix={prefix} />
        {ticks.map((tick) => {
          const y = round(yAt(tick, max, geo));
          return (
            <g key={tick}>
              <line
                className={styles.gridLine}
                x1={geo.plotLeft}
                y1={y}
                x2={geo.plotLeft + geo.plotWidth}
                y2={y}
              />
              <text
                className={`${styles.axisText} ${styles.axisTextRight}`}
                x={geo.plotLeft - 5}
                y={y + 3}
              >
                {format(tick)}
              </text>
            </g>
          );
        })}

        {Array.from({ length: count }, (_, i) => {
          const layout = barLayout(i, count, geo);
          let bottom = base;
          const groupWidth = stacked ? layout.width : layout.width / Math.max(1, series.length);
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              {/* Прозрачная накладка на всю высоту: попасть мышью в
                  столбец высотой в две точки иначе невозможно. */}
              <rect
                x={round(layout.x)}
                y={geo.plotTop}
                width={round(layout.width)}
                height={round(geo.plotHeight)}
                fill="transparent"
              />
              {series.map((s, si) => {
                const value = s.values[i] ?? 0;
                if (value <= 0) return null;
                const barHeight = (value / (max || 1)) * geo.plotHeight;
                const x = stacked ? layout.x : layout.x + groupWidth * si;
                const y = stacked ? bottom - barHeight : base - barHeight;
                if (stacked) bottom -= barHeight;
                const fill = patternFill(prefix, s.series.pattern);
                return (
                  <g key={s.series.id}>
                    <rect
                      x={round(x)}
                      y={round(y)}
                      width={round(groupWidth)}
                      height={round(Math.max(1, barHeight))}
                      fill={hueVar(s.series.hue)}
                    />
                    {/* Узор поверх цвета: различать ряды можно и не
                        различая цветов. */}
                    {fill && (
                      <rect
                        x={round(x)}
                        y={round(y)}
                        width={round(groupWidth)}
                        height={round(Math.max(1, barHeight))}
                        fill={fill}
                      />
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {marked.map((index) => (
          <text
            key={index}
            className={`${styles.axisText} ${styles.axisTextMiddle}`}
            x={round(
              clampLabelX(
                barLayout(index, count, geo).x + barLayout(index, count, geo).width / 2,
                geo.width,
              ),
            )}
            y={height - 6}
          >
            {labels[index]}
          </text>
        ))}

        <line
          className={styles.axisLine}
          x1={geo.plotLeft}
          y1={base}
          x2={geo.plotLeft + geo.plotWidth}
          y2={base}
        />
      </svg>
      <Legend entries={series.map((s) => ({ series: s.series }))} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Кольцевая диаграмма                                                 */
/* ------------------------------------------------------------------ */

export interface DonutItem {
  series: ChartSeries;
  value: number;
  /** Что показать вместо числа (уже отформатированный размер). */
  label?: string;
}

export interface DonutChartProps {
  items: readonly DonutItem[];
  size?: number;
  /** Подпись в середине кольца — итог. */
  centerValue?: string | undefined;
  centerLabel?: string | undefined;
  emptyText?: string;
  ariaLabel: string;
}

export function DonutChart({
  items,
  size = 150,
  centerValue,
  centerLabel,
  emptyText = 'Нечего показать',
  ariaLabel,
}: DonutChartProps) {
  const prefix = useId().replace(/[^a-zA-Z0-9-]/gu, '');
  const { slices, total } = useMemo(
    () => donutSlices(items.map((i) => ({ id: i.series.id, value: i.value }))),
    [items],
  );
  if (total <= 0) return <div className={styles.empty}>{emptyText}</div>;

  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - 2;
  // Толщина кольца в 28 % радиуса: тоньше — и узор внутри сектора уже не
  // читается, толще — и в середине не остаётся места под итог.
  const inner = outer * 0.58;

  return (
    <div className={styles.box}>
      <svg
        className={styles.svg}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel}
        style={{ maxWidth: size }}
      >
        <PatternDefs prefix={prefix} />
        {slices.map((slice) => {
          const item = items.find((i) => i.series.id === slice.id)!;
          const d = arcPath(cx, cy, outer, inner, slice.startAngle, slice.endAngle);
          const fill = patternFill(prefix, item.series.pattern);
          return (
            <g key={slice.id}>
              <path d={d} fill={hueVar(item.series.hue)}>
                <title>{`${item.series.title}: ${item.label ?? slice.value} (${Math.round(slice.share * 100)}%)`}</title>
              </path>
              {fill && <path d={d} fill={fill} pointerEvents="none" />}
            </g>
          );
        })}
        {centerValue && (
          <text
            x={cx}
            y={cy - 1}
            className={`${styles.axisText} ${styles.axisTextMiddle}`}
            style={{ fontSize: 13, fill: 'var(--mt-color-text-primary)' }}
          >
            {centerValue}
          </text>
        )}
        {centerLabel && (
          <text x={cx} y={cy + 13} className={`${styles.axisText} ${styles.axisTextMiddle}`}>
            {centerLabel}
          </text>
        )}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Полоса: доля от целого одной строкой                                */
/* ------------------------------------------------------------------ */

export function Meter({
  percent,
  hue,
  label,
}: {
  percent: number | null;
  hue: ChartSeries['hue'];
  label: ReactNode;
}) {
  const value = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className={styles.meter}>
      <div
        className={styles.meterTrack}
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={styles.meterFill} style={{ width: `${value}%`, background: hueVar(hue) }} />
      </div>
      <span className={styles.meterValue}>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Кольцевой показатель                                                 */
/* ------------------------------------------------------------------ */

/**
 * Одно значение в процентах — кольцом.
 *
 * Отличается от DonutChart тем, что показывает НЕ доли одного целого, а
 * заполненность: сколько занято из ста процентов. Дуга идёт от
 * двенадцати часов по часовой стрелке — так её и читают.
 *
 * Значение внутри кольца, а не сбоку: у показателя есть заголовок и
 * подпись об источнике, и число, стоящее рядом с ними в строку, теряется
 * между ними. В середине кольца оно единственное.
 *
 * `percent === null` — «не измеряли»: кольцо остаётся пустым, и это
 * честнее нуля. Ноль означал бы «измерили и получили ноль».
 */
export function Ring({
  percent,
  hue,
  label,
  title,
}: {
  percent: number | null;
  hue: ChartSeries['hue'];
  label: ReactNode;
  title?: string;
}) {
  const value = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  // Радиус и толщина подобраны так, чтобы кольцо оставалось читаемым в
  // сетке показателей: тонкая дуга на светлом фоне сливается с трактом.
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const filled = (circumference * value) / 100;

  return (
    <svg
      viewBox="0 0 76 76"
      className={styles.ring}
      role="img"
      aria-label={title ?? (percent === null ? 'не измеряли' : `${Math.round(value)}%`)}
    >
      <circle className={styles.ringTrack} cx="38" cy="38" r={radius} />
      {percent !== null && (
        <circle
          className={styles.ringValue}
          cx="38"
          cy="38"
          r={radius}
          stroke={hueVar(hue)}
          strokeDasharray={`${String(filled)} ${String(circumference)}`}
          // Поворот на четверть: дуга начинается сверху, а не справа.
          transform="rotate(-90 38 38)"
        />
      )}
      <text
        className={styles.ringText}
        x="38"
        y="38"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {label}
      </text>
    </svg>
  );
}

export const chartStyles = styles;
