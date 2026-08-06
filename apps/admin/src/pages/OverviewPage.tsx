/**
 * Дашборд: один экран, по которому видно и то, всё ли работает, и то,
 * куда всё движется.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЗДЕСЬ ГРАФИКИ, А НЕ ПЛИТКИ С ЧИСЛАМИ
 * ------------------------------------------------------------------
 * «Занято 80 %» не отвечает на вопрос, ради которого сюда заходят:
 * РАСТЁТ ЛИ. Восемьдесят процентов, которые держатся месяц, и восемьдесят,
 * которые вчера были сорока, — это «всё в порядке» и «через двое суток
 * встанет почта». Отличить их можно только по истории, поэтому у каждого
 * ресурса есть линия за выбранное окно, а не одно число.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ РАЗДЕЛЫ ГРУЗЯТСЯ ПОРОЗНЬ
 * ------------------------------------------------------------------
 * Запросов шесть, и каждый рисует свою карточку, как только пришёл.
 * Сертификаты читаются из живых соединений и на недоступном порту молчат
 * до таймаута; занятость ящиков считается обходом хранилища. Слепив всё
 * в один ответ, мы заставили бы ждать эти четыре секунды даже загрузку
 * процессора, которая готова мгновенно.
 *
 * ------------------------------------------------------------------
 * ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ
 * ------------------------------------------------------------------
 * Выдуманных чисел. Сервер приложения живёт в контейнере и часть
 * показателей увидеть не может: загрузку чужих служб, объём очереди на
 * диске. Всё это перечислено словами в карточке «Чего не видно отсюда»
 * с объяснением причины, а не подставлено нулями. Ноль занятой памяти
 * выглядит как исправный сервер, хотя означает «мы ничего не мерили».
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type {
  DiskSlice,
  Measured,
  OverviewMail,
  OverviewResources,
  UserTrafficSort,
} from '../api/types';
import { PageTitle, CenteredSpinner } from '../app/AdminLayout';
import { BarChart, DonutChart, LineChart, Meter } from '../components/Charts';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { Badge, DnsBadge, ErrorNotice, Notice, Panel, Tile, Tiles } from '../components/ui';
import { loadAutoRefresh, saveAutoRefresh, shouldPoll } from '../lib/autoRefresh';
import { timeLabel } from '../lib/chart';
import {
  DISK_SERIES,
  FLOW_SERIES,
  HOURLY_SERIES,
  hueVar,
  QUEUE_SERIES,
  RESOURCE_SERIES,
  seriesOf,
} from '../lib/chartSeries';
import { formatBytes, formatDateTime, formatRelative, plural } from '../lib/format';
import styles from './OverviewPage.module.css';

/** Как часто опрашивать при включённом автообновлении. */
const POLL_MS = 15_000;

/**
 * Окна времени.
 *
 * Дольше тридцати суток нет смысла: столько история и не живёт
 * (MAIL_FLOW_RETENTION_DAYS — 14 суток, MAIL_METRICS_RETENTION_DAYS — 7).
 * Обещать «за год» значит рисовать пустой график.
 */
const WINDOWS: ReadonlyArray<{ hours: number; title: string }> = [
  { hours: 1, title: 'час' },
  { hours: 6, title: '6 часов' },
  { hours: 24, title: 'сутки' },
  { hours: 24 * 7, title: 'неделя' },
  { hours: 24 * 30, title: 'месяц' },
];

const WINDOW_KEY = 'mt-admin-dashboard-window';

/** Видима ли вкладка: невидимую не опрашиваем вовсе. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/** Проценты одной строкой; null — не измеряли. */
function percentText(value: number | null): string {
  return value === null ? 'не измеряли' : `${value.toFixed(value < 10 ? 1 : 0)} %`;
}

/** Возраст в секундах словами: «2 ч 14 мин». */
export function durationText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'сутки', 'суток', 'суток')} ${hours % 24} ч`;
}

/* ------------------------------------------------------------------ */
/* Страница                                                            */
/* ------------------------------------------------------------------ */

export function OverviewPage() {
  // Автообновление — по флажку и с памятью, как в «Почтовом потоке»
  // и «Журналах почты» (см. lib/autoRefresh.ts). Список, который
  // шевелится сам, — решение человека, а не наше за него.
  const [auto, setAuto] = useState(() => loadAutoRefresh('dashboard'));
  const visible = usePageVisible();
  const poll = shouldPoll(auto, visible ? 'visible' : 'hidden') ? POLL_MS : false;

  // Окно тоже запоминается: администратор, следящий за неделей, не должен
  // каждый раз возвращать его из суток.
  const [hours, setHours] = useState(() => {
    try {
      const saved = Number(globalThis.localStorage?.getItem(WINDOW_KEY));
      return WINDOWS.some((w) => w.hours === saved) ? saved : 24;
    } catch {
      return 24;
    }
  });
  const changeWindow = useCallback((value: number) => {
    setHours(value);
    try {
      globalThis.localStorage?.setItem(WINDOW_KEY, String(value));
    } catch {
      /* хранилище недоступно — выбор просто не переживёт перезагрузку */
    }
  }, []);

  const summary = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.overview(),
    refetchInterval: poll,
  });

  return (
    <>
      <PageTitle
        title="Дашборд"
        subtitle="Загрузка сервера, место на диске, почтовый поток, очередь и статистика по ящикам"
      />

      <div className={styles.head}>
        {WINDOWS.map((w) => (
          <Button
            key={w.hours}
            size="s"
            mode={w.hours === hours ? 'primary' : 'secondary'}
            onClick={() => changeWindow(w.hours)}
          >
            {w.title}
          </Button>
        ))}
        <label className={styles.auto}>
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              saveAutoRefresh('dashboard', e.target.checked);
            }}
          />
          <span>Автообновление</span>
        </label>
      </div>

      {summary.isLoading && <CenteredSpinner />}
      {summary.error && <ErrorNotice error={summary.error} />}
      {summary.data &&
        (summary.data.healthy ? (
          <Notice tone="success">Всё в порядке: сервисы отвечают, замечаний нет.</Notice>
        ) : (
          <Notice tone="error">
            <strong>Требует внимания:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {summary.data.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        ))}

      <ResourcesSection hours={hours} poll={poll} />
      <MailSection hours={hours} poll={poll} />
      <UsersSection hours={hours} poll={poll} />
      <SecuritySection poll={poll} />
      <ServicesSection summary={summary.data ?? null} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Ресурсы                                                             */
/* ------------------------------------------------------------------ */

function ResourcesSection({ hours, poll }: { hours: number; poll: number | false }) {
  const resources = useQuery({
    queryKey: ['overview', 'resources'],
    queryFn: () => api.overviewResources(),
    refetchInterval: poll,
  });
  const history = useQuery({
    queryKey: ['overview', 'history', hours],
    queryFn: () => api.overviewHistory(hours),
    refetchInterval: poll,
  });

  const data = resources.data;
  const points = history.data?.points ?? [];
  const labels = useMemo(() => points.map((p) => timeLabel(p.at, hours)), [points, hours]);

  const disk = data?.volumes[0] ?? null;
  const diskPercent =
    disk && disk.totalBytes > 0 ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100 : null;
  const memPercent = memoryPercent(data);

  return (
    <>
      <h2 className={styles.section}>Ресурсы сервера</h2>
      <p className={styles.sectionHint}>
        Числа сняты{' '}
        {data?.takenAt ? formatRelative(data.takenAt) : 'ещё не снимались'}
        {data ? `, съёмка раз в ${data.intervalSeconds} с` : ''}. Под каждым показателем
        написано, из какого файла он прочитан.
      </p>

      {resources.error && <ErrorNotice error={resources.error} />}

      <div className={styles.grid}>
        <Panel title="Прямо сейчас">
          {!data ? (
            <CenteredSpinner />
          ) : (
            <div className={styles.gauges}>
              <Gauge
                title="Процессор узла"
                measured={data.cpu?.nodePercent ?? null}
                percent={data.cpu?.nodePercent.value ?? null}
                hue="blue"
                text={percentText(data.cpu?.nodePercent.value ?? null)}
              />
              <Gauge
                title="Процессор: сервер приложения"
                measured={data.cpu?.apiPercent ?? null}
                percent={data.cpu?.apiPercent.value ?? null}
                hue="violet"
                text={
                  data.cpu?.apiPercent.value === null || data.cpu === null
                    ? 'не измеряли'
                    : `${data.cpu.apiPercent.value.toFixed(1)} % ядра`
                }
              />
              <Gauge
                title="Память узла"
                measured={data.memory?.used ?? null}
                percent={memPercent}
                hue="magenta"
                text={
                  data.memory?.used.value === null || !data.memory
                    ? 'не измеряли'
                    : `${formatBytes(data.memory.used.value)} из ${formatBytes(
                        data.memory.total.value ?? 0,
                      )} · ${percentText(memPercent)}`
                }
              />
              <Gauge
                title="Память: сервер приложения"
                measured={data.memory?.api ?? null}
                percent={null}
                hue="violet"
                text={
                  data.memory?.api.value === null || !data.memory
                    ? 'не измеряли'
                    : formatBytes(data.memory.api.value)
                }
              />
              <Gauge
                title={disk ? `Диск (${disk.path})` : 'Диск'}
                measured={
                  disk
                    ? { value: disk.usedBytes, source: 'statfs по смонтированному пути' }
                    : { value: null, source: 'Тома не смонтированы в контейнер api' }
                }
                percent={diskPercent}
                hue="teal"
                text={
                  disk
                    ? `свободно ${formatBytes(disk.freeBytes)} из ${formatBytes(disk.totalBytes)} · ${percentText(diskPercent)}`
                    : 'не измеряли'
                }
              />
              <Gauge
                title="Средняя нагрузка за минуту"
                measured={data.cpu?.load1 ?? null}
                percent={
                  data.cpu?.load1.value !== null && data.cpu?.cores.value
                    ? Math.min(100, (data.cpu.load1.value! / data.cpu.cores.value) * 100)
                    : null
                }
                hue="gray"
                text={
                  data.cpu?.load1.value === null || !data.cpu
                    ? 'не измеряли'
                    : `${data.cpu.load1.value.toFixed(2)} при ${data.cpu.cores.value ?? '?'} ${plural(
                        data.cpu.cores.value ?? 0,
                        'ядре',
                        'ядрах',
                        'ядрах',
                      )}`
                }
              />
            </div>
          )}
        </Panel>

        <Panel title="Загрузка за период">
          {history.isLoading ? (
            <CenteredSpinner />
          ) : history.data?.available === false ? (
            <Notice tone="error">{history.data.note}</Notice>
          ) : (
            <>
              <LineChart
                ariaLabel="Загрузка процессора, памяти и диска за выбранный период, проценты"
                labels={labels}
                fixedMax={100}
                format={(v) => `${Math.round(v)}%`}
                series={[
                  {
                    series: seriesOf(RESOURCE_SERIES, 'cpuNode'),
                    values: points.map((p) => p.cpuNodePercent),
                  },
                  {
                    series: seriesOf(RESOURCE_SERIES, 'mem'),
                    values: points.map((p) => p.memUsedPercent),
                  },
                  {
                    series: seriesOf(RESOURCE_SERIES, 'disk'),
                    values: points.map((p) => p.diskUsedPercent),
                  },
                ]}
                /*
                  Имя миграции — ровно то, что лежит на диске. Раньше здесь
                  стояло «0010», а файл называется 0011_metrics.sql: человек
                  шёл искать в install/ файл, которого нет.
                */
                emptyText="Снимков за этот период ещё нет. История начинается с момента запуска сервера приложения с применённой миграцией 0011_metrics.sql."
              />
              <p className={styles.source}>{history.data?.note}</p>
            </>
          )}
        </Panel>
      </div>

      <div className={styles.grid}>
        <Panel title="Что занимает место">
          <DiskBreakdown slices={data?.slices ?? []} volume={disk} />
          {/*
            Общий том — это не мелочь оформления, а причина будущей аварии:
            разросшиеся журналы займут место, нужное письмам, и приём почты
            остановится. Поэтому сказано отдельной строкой, а не спрятано
            в списке источников.
          */}
          {data?.singleDevice && (
            <p className={styles.source}>
              Письма, индексы и журналы лежат на ОДНОМ устройстве: свободное место у них
              общее, и переполнение журналами остановит приём почты.
            </p>
          )}
        </Panel>

        <Panel title="Очередь писем">
          <QueueCard data={data} labels={labels} points={points} />
        </Panel>
      </div>

      {data && data.unavailable.length > 0 && (
        <div className={styles.grid}>
          <Panel title="Чего не видно отсюда">
            <ul className={styles.notes}>
              {data.unavailable.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Panel>
        </div>
      )}
    </>
  );
}

function memoryPercent(data: OverviewResources | undefined): number | null {
  const total = data?.memory?.total.value ?? null;
  const used = data?.memory?.used.value ?? null;
  if (total === null || used === null || total <= 0) return null;
  return (used / total) * 100;
}

function Gauge({
  title,
  measured,
  percent,
  hue,
  text,
}: {
  title: string;
  measured: Measured | null;
  percent: number | null;
  hue: 'blue' | 'violet' | 'magenta' | 'teal' | 'gray';
  text: string;
}) {
  return (
    <div className={styles.gauge}>
      <div className={styles.gaugeHead}>
        <span className={styles.gaugeTitle}>{title}</span>
        <span className={styles.gaugeNumber}>{text}</span>
      </div>
      <Meter percent={percent} hue={hue} label={percent === null ? '—' : `${Math.round(percent)}%`} />
      {/* Источник числа стоит рядом с числом. Иначе «занято 42 %» не
          отвечает на вопрос «чего именно и по чьим данным» — а на
          дашборде это первый же вопрос. */}
      <div className={styles.source}>{measured?.source ?? 'источник не указан'}</div>
    </div>
  );
}

function DiskBreakdown({
  slices,
  volume,
}: {
  slices: readonly DiskSlice[];
  volume: { totalBytes: number; freeBytes: number } | null;
}) {
  /*
   * В кольце — только ЗАНЯТОЕ, без свободного места.
   *
   * Первый вариант рисовал свободное такой же долей, и на диске в терабайт
   * с гигабайтом писем кольцо выглядело так: «Свободно 100 %», а все
   * остальные статьи — по нулю. Формально верно, а ответа на вопрос «что
   * съело диск» не даёт вовсе: именно тогда, когда места ещё много,
   * разрез и нужен, чтобы заметить, ЧТО растёт.
   *
   * Заполнение тома при этом никуда не делось — оно показано полосой над
   * кольцом и подписью «свободно X из Y».
   */
  const items = slices
    .filter((s) => s.bytes !== null && s.bytes > 0)
    .map((s) => ({ series: seriesOf(DISK_SERIES, s.id), value: s.bytes!, label: formatBytes(s.bytes!) }));
  const measured = items.reduce((sum, i) => sum + i.value, 0);
  /*
   * Занятое, которое мы не разложили по статьям: чужие файлы на том же
   * томе, каталоги, до которых сборщик не дошёл, потери на блоках.
   * Показывать его обязательно — иначе сумма долей не сойдётся с тем,
   * что человек видит в df, и он решит, что панель врёт.
   */
  const usedTotal = volume ? volume.totalBytes - volume.freeBytes : 0;
  const rest = volume ? usedTotal - measured : 0;
  if (rest > usedTotal * 0.01) {
    items.push({
      series: { ...seriesOf(DISK_SERIES, 'free'), id: 'rest', title: 'Прочее на этом томе' },
      value: rest,
      label: formatBytes(rest),
    });
  }
  const total = items.reduce((sum, i) => sum + i.value, 0);
  const unknown = slices.filter((s) => s.bytes === null);
  const fillPercent =
    volume && volume.totalBytes > 0 ? (usedTotal / volume.totalBytes) * 100 : null;

  return (
    <>
      {volume && (
        <div className={styles.gauge}>
          <div className={styles.gaugeHead}>
            <span className={styles.gaugeTitle}>Заполнение тома</span>
            <span className={styles.gaugeNumber}>
              свободно {formatBytes(volume.freeBytes)} из {formatBytes(volume.totalBytes)}
            </span>
          </div>
          <Meter
            percent={fillPercent}
            hue={fillPercent !== null && fillPercent >= 85 ? 'red' : 'teal'}
            label={fillPercent === null ? '—' : `${fillPercent.toFixed(1)} %`}
          />
        </div>
      )}
      <div className={styles.donutRow}>
        <DonutChart
          ariaLabel="Разрез занятого места по статьям расхода"
          items={items}
          size={140}
          centerValue={total > 0 ? formatBytes(total) : undefined}
          centerLabel={total > 0 ? 'занято' : undefined}
          emptyText="Размеры ещё не сняты"
        />
        <div className={styles.donutLegend}>
          {items.map((item) => (
            <div key={item.series.id} className={styles.donutLegendRow}>
              <span className={styles.swatch} style={{ background: hueVar(item.series.hue) }} />
              <span className={styles.donutLegendName}>{item.series.title}</span>
              <span className={styles.donutLegendValue}>
                {item.label} · {total > 0 ? Math.round((item.value / total) * 100) : 0} %
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* Статьи, которых мы не видим, перечислены ЗДЕСЬ ЖЕ, а не спрятаны:
          иначе круговая диаграмма читалась бы как «вот весь диск». */}
      {unknown.length > 0 && (
        <ul className={styles.notes}>
          {unknown.map((slice) => (
            <li key={slice.id}>
              <strong>{slice.title}:</strong> {slice.source}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function QueueCard({
  data,
  labels,
  points,
}: {
  data: OverviewResources | undefined;
  labels: readonly string[];
  points: ReadonlyArray<{ queueTotal: number | null; queueDeferred: number | null }>;
}) {
  const queue = data?.queue ?? null;
  if (!queue) return <CenteredSpinner />;
  if (!queue.available) return <Notice tone="error">{queue.note}</Notice>;
  return (
    <>
      {/*
        Про неполноту говорим ЗДЕСЬ, а не только в «Почтовом потоке».
        Раньше при заторе дашборд показывал предел разбора (20 000) как
        точное число писем в очереди, а поток на том же стенде честно
        предупреждал, что показана часть, — два раздела панели расходились
        в показаниях ровно в тот момент, когда очередь и надо разбирать.
      */}
      {queue.truncated && (
        <Notice tone="info">
          Очередь длиннее предела разбора: числа ниже — по разобранной части, писем в
          действительности больше.
        </Notice>
      )}
      <Tiles>
        <Tile value={queue.total ?? '—'} label="писем в очереди" />
        <Tile value={queue.deferred ?? '—'} label="отложено" />
        <Tile value={durationText(queue.oldestSeconds)} label="возраст самого старого" />
      </Tiles>
      <LineChart
        ariaLabel="Длина очереди писем за выбранный период"
        labels={labels}
        area
        series={[
          {
            series: seriesOf(QUEUE_SERIES, 'queueTotal'),
            values: points.map((p) => p.queueTotal),
          },
          {
            series: seriesOf(QUEUE_SERIES, 'queueDeferred'),
            values: points.map((p) => p.queueDeferred),
          },
        ]}
        height={120}
        emptyText="Снимков очереди за этот период ещё нет"
      />
      {queue.topDeferredDomains.length > 0 && (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>Куда не уходит</th>
                <th className={tableStyles.numeric}>Писем</th>
              </tr>
            </thead>
            <tbody>
              {queue.topDeferredDomains.map((row) => (
                <tr key={row.domain}>
                  <td className="mt-mono">{row.domain}</td>
                  <td className={tableStyles.numeric}>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      <p className={styles.source}>{queue.note}</p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Почта                                                               */
/* ------------------------------------------------------------------ */

function MailSection({ hours, poll }: { hours: number; poll: number | false }) {
  const mail = useQuery({
    queryKey: ['overview', 'mail', hours],
    queryFn: () => api.overviewMail(hours),
    refetchInterval: poll,
  });

  const data = mail.data;
  const labels = useMemo(
    () => (data?.buckets ?? []).map((b) => timeLabel(b.at, hours)),
    [data, hours],
  );

  return (
    <>
      <h2 className={styles.section}>Почтовый поток</h2>
      <p className={styles.sectionHint}>
        Разобранный журнал Postfix: одна запись — одна попытка доставки одному адресату.
        {data?.historyStartsAt
          ? ` История ведётся с ${formatDateTime(data.historyStartsAt)}.`
          : ''}
      </p>
      {mail.error && <ErrorNotice error={mail.error} />}
      {/*
        Раздел без своей миграции больше не падает «внутренней ошибкой» —
        сервер объясняет, чего не хватает, и это надо показать. Пустые
        графики ниже при этом честны: данных действительно нет.
      */}
      {data && !data.available && <Notice tone="info">{data.note}</Notice>}

      <div className={styles.gridWide}>
        <Panel title="Что происходило с письмами">
          {mail.isLoading ? (
            <CenteredSpinner />
          ) : (
            <BarChart
              ariaLabel="Число писем по состояниям за выбранный период"
              labels={labels}
              series={FLOW_SERIES.map((series) => ({
                series,
                values: (data?.buckets ?? []).map((b) => b.counts[series.id] ?? 0),
              }))}
              emptyText="За этот период в журнале не было ни одного письма"
            />
          )}
        </Panel>

        <Panel title="Доли состояний">
          <FlowShares data={data} />
        </Panel>
      </div>

      <div className={styles.grid}>
        <Panel title="Размер письма">
          {data ? (
            <>
              <Tiles>
                <Tile value={formatBytes(data.sizes.avgBytes ?? 0, '—')} label="средний" />
                <Tile value={formatBytes(data.sizes.medianBytes ?? 0, '—')} label="медианный" />
                <Tile value={formatBytes(data.sizes.totalBytes, '—')} label="всего за период" />
                <Tile value={formatBytes(data.sizes.maxBytes ?? 0, '—')} label="самое крупное" />
              </Tiles>
              {/* Расхождение среднего и медианы само по себе полезно:
                  оно говорит, что объём делают редкие тяжёлые письма. */}
              <p className={styles.source}>
                Считается по различным письмам ({data.sizes.messages}), а не по попыткам
                доставки: письмо на трёх адресатов — одно письмо. Среднее выше медианы
                означает, что объём делают редкие тяжёлые вложения.
              </p>
            </>
          ) : (
            <CenteredSpinner />
          )}
        </Panel>

        <Panel title="Пиковые часы">
          {data ? (
            <BarChart
              ariaLabel="Распределение писем по часам суток"
              labels={data.hourly.map((h) => String(h.hour).padStart(2, '0'))}
              series={[
                {
                  // Ряд СВОЙ, а не 'sent' из потока: здесь считаются письма
                  // всех состояний, и подпись «Доставлено» в подсказке
                  // называла бы это число чужим именем.
                  series: seriesOf(HOURLY_SERIES, 'hourlyTotal'),
                  values: data.hourly.map((h) => h.count),
                },
              ]}
              height={130}
              emptyText="За этот период писем не было"
            />
          ) : (
            <CenteredSpinner />
          )}
        </Panel>
      </div>

      <div className={styles.grid}>
        <Panel title="Почему письма не доходят">
          <ReasonTable rows={data?.rejectReasons ?? []} loading={mail.isLoading} />
        </Panel>
        <Panel title="Почему письма откладываются">
          <ReasonTable rows={data?.deferReasons ?? []} loading={mail.isLoading} />
        </Panel>
      </div>
    </>
  );
}

function FlowShares({ data }: { data: OverviewMail | undefined }) {
  if (!data) return <CenteredSpinner />;
  const items = FLOW_SERIES.map((series) => ({
    series,
    value: data.totals[series.id] ?? 0,
    label: String(data.totals[series.id] ?? 0),
  })).filter((i) => i.value > 0);
  const total = items.reduce((sum, i) => sum + i.value, 0);
  const spamShare = total > 0 ? Math.round((data.spamRejected / total) * 1000) / 10 : 0;

  return (
    <>
      <div className={styles.donutRow}>
        <DonutChart
          ariaLabel="Доли состояний писем за выбранный период"
          items={items}
          size={140}
          centerValue={String(total)}
          centerLabel="записей"
          emptyText="За этот период писем не было"
        />
        <div className={styles.donutLegend}>
          {items.map((item) => (
            <div key={item.series.id} className={styles.donutLegendRow}>
              <span className={styles.swatch} style={{ background: hueVar(item.series.hue) }} />
              <span className={styles.donutLegendName}>{item.series.title}</span>
              <span className={styles.donutLegendValue}>
                {item.value} · {total > 0 ? Math.round((item.value / total) * 100) : 0} %
              </span>
            </div>
          ))}
        </div>
      </div>
      <Tiles>
        <Tile value={data.spamRejected} label="отбито как спам" />
        <Tile value={`${spamShare} %`} label="доля от всех записей" />
        <Tile
          value={`${data.mailboxesActive} из ${data.mailboxesTotal}`}
          label="ящиков подавали признаки жизни"
        />
      </Tiles>
      <p className={styles.source}>{data.spamNote}.</p>
      <p className={styles.source}>{data.activityNote}.</p>
    </>
  );
}

function ReasonTable({
  rows,
  loading,
}: {
  rows: ReadonlyArray<{ reason: string; count: number }>;
  loading: boolean;
}) {
  if (loading) return <CenteredSpinner />;
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <th>Причина (переменные части заменены)</th>
            <th className={tableStyles.numeric}>Писем</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.reason}>
              <td className={styles.reasonText}>{row.reason}</td>
              <td className={tableStyles.numeric}>{row.count}</td>
            </tr>
          ))}
          {rows.length === 0 && <EmptyRow colSpan={2}>За этот период таких писем не было</EmptyRow>}
        </tbody>
      </Table>
    </TableWrap>
  );
}

/* ------------------------------------------------------------------ */
/* Пользователи                                                        */
/* ------------------------------------------------------------------ */

const USER_COLUMNS: ReadonlyArray<{ sort: UserTrafficSort; title: string; bytes: boolean }> = [
  { sort: 'sentMessages', title: 'Отправил', bytes: false },
  { sort: 'sentBytes', title: 'Объём отправленного', bytes: true },
  { sort: 'receivedMessages', title: 'Получил', bytes: false },
  { sort: 'receivedBytes', title: 'Объём полученного', bytes: true },
];

function UsersSection({ hours, poll }: { hours: number; poll: number | false }) {
  const [sort, setSort] = useState<UserTrafficSort>('totalMessages');
  const users = useQuery({
    queryKey: ['overview', 'users', hours, sort],
    queryFn: () => api.overviewUsers({ hours, sort, limit: 25 }),
    refetchInterval: poll,
  });
  const mailboxes = useQuery({
    queryKey: ['overview', 'mailboxes'],
    queryFn: () => api.overviewMailboxes(20),
    refetchInterval: poll,
  });

  const silent = (users.data?.items ?? []).filter(
    (u) => u.sentMessages === 0 && u.receivedMessages === 0,
  ).length;

  return (
    <>
      <h2 className={styles.section}>Ящики</h2>
      <p className={styles.sectionHint}>
        Слева — кто сколько отправил и получил за выбранный период. Справа — сколько места
        занято и насколько близко до квоты; ради этого списка дашборд и открывают.
      </p>

      <div className={styles.gridWide}>
        <Panel title="Кто сколько отправил и получил">
          {users.error && <ErrorNotice error={users.error} />}
          {users.isLoading ? (
            <CenteredSpinner />
          ) : (
            <>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <th>Ящик</th>
                      {USER_COLUMNS.map((column) => (
                        <th key={column.sort} className={tableStyles.numeric}>
                          {/* Сортировка кнопкой, а не текстом с обработчиком:
                              на кнопку можно встать с клавиатуры. */}
                          <button
                            type="button"
                            className={`${styles.sortButton} ${sort === column.sort ? styles.sortActive : ''}`}
                            onClick={() => setSort(column.sort)}
                            aria-pressed={sort === column.sort}
                          >
                            {column.title}
                            {sort === column.sort ? ' ↓' : ''}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(users.data?.items ?? []).map((row) => (
                      <tr key={row.id}>
                        <td className="mt-mono">
                          {row.email}
                          {!row.active && (
                            <>
                              {' '}
                              <Badge tone="fail">заблокирован</Badge>
                            </>
                          )}
                        </td>
                        <td className={tableStyles.numeric}>{row.sentMessages}</td>
                        <td className={tableStyles.numeric}>{formatBytes(row.sentBytes, '—')}</td>
                        <td className={tableStyles.numeric}>{row.receivedMessages}</td>
                        <td className={tableStyles.numeric}>
                          {formatBytes(row.receivedBytes, '—')}
                        </td>
                      </tr>
                    ))}
                    {(users.data?.items ?? []).length === 0 && (
                      <EmptyRow colSpan={5}>Ящиков нет</EmptyRow>
                    )}
                  </tbody>
                </Table>
              </TableWrap>
              <p className={styles.source}>
                Показано {users.data?.items.length ?? 0} из {users.data?.total ?? 0}{' '}
                {plural(users.data?.total ?? 0, 'ящика', 'ящиков', 'ящиков')}. Молчали за
                период: {silent}. «Отправил» считается по различным письмам, «получил» — по
                доставленным конвертам.
              </p>
            </>
          )}
        </Panel>

        <Panel title="Место в ящиках и близость к квоте">
          {mailboxes.error && <ErrorNotice error={mailboxes.error} />}
          {mailboxes.isLoading ? (
            <CenteredSpinner />
          ) : mailboxes.data?.available === false ? (
            <Notice tone="error">{mailboxes.data.note}</Notice>
          ) : (
            <>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <th>Ящик</th>
                      <th className={tableStyles.numeric}>Занято</th>
                      <th className={tableStyles.numeric}>Квота</th>
                      <th>Заполнение</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(mailboxes.data?.items ?? []).map((row) => (
                      <tr key={row.email}>
                        <td className="mt-mono">{row.email}</td>
                        <td className={tableStyles.numeric}>{formatBytes(row.bytes, '0')}</td>
                        <td className={tableStyles.numeric}>{formatBytes(row.quotaBytes)}</td>
                        <td className={styles.quotaCell}>
                          <Meter
                            percent={row.usedPercent}
                            /* Цвет по близости к пределу, но рядом всегда
                               стоит число: цвет — не единственный сигнал. */
                            hue={
                              row.usedPercent === null
                                ? 'gray'
                                : row.usedPercent >= 90
                                  ? 'red'
                                  : row.usedPercent >= 75
                                    ? 'amber'
                                    : 'green'
                            }
                            label={
                              row.usedPercent === null
                                ? 'без квоты'
                                : `${row.usedPercent.toFixed(1)} %`
                            }
                          />
                        </td>
                      </tr>
                    ))}
                    {(mailboxes.data?.items ?? []).length === 0 && (
                      <EmptyRow colSpan={4}>Учёт занятости ещё не заведён ни у одного ящика</EmptyRow>
                    )}
                  </tbody>
                </Table>
              </TableWrap>
              <p className={styles.source}>
                {mailboxes.data?.note}. Всего занято {formatBytes(mailboxes.data?.totalBytes ?? 0, '0')}
                {mailboxes.data?.withoutAccounting
                  ? `; без учёта — ${mailboxes.data.withoutAccounting} ${plural(
                      mailboxes.data.withoutAccounting,
                      'ящик',
                      'ящика',
                      'ящиков',
                    )}`
                  : ''}
                . Список отсортирован по близости к квоте: ящик на 900 МБ из гигабайта
                важнее пустого ящика на пять.
              </p>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Сертификаты и DNS                                                   */
/* ------------------------------------------------------------------ */

function SecuritySection({ poll }: { poll: number | false }) {
  const security = useQuery({
    queryKey: ['overview', 'security'],
    queryFn: () => api.overviewSecurity(),
    // Сертификаты меняются раз в месяцы, а чтение каждого — сетевое
    // соединение с таймаутом. Опрашиваем ВЧЕТВЕРО реже остальных разделов.
    refetchInterval: poll === false ? false : poll * 4,
  });
  const data = security.data;

  return (
    <>
      <h2 className={styles.section}>Сертификаты и DNS</h2>
      <p className={styles.sectionHint}>
        Истёкший сертификат ломает всё разом: почтовые программы перестают подключаться,
        чужие серверы — принимать почту. Узнают об этом обычно последними, поэтому срок
        стоит здесь.
      </p>
      {security.error && <ErrorNotice error={security.error} />}

      <div className={styles.gridWide}>
        <Panel title="Сроки сертификатов">
          {security.isLoading ? (
            <CenteredSpinner />
          ) : (
            <>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <th>Служба</th>
                      <th>Состояние</th>
                      <th>Действует до</th>
                      <th>Кем выписан</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.certificates ?? []).map((cert) => (
                      <tr key={`${cert.host}:${cert.port}`}>
                        <td>{cert.title}</td>
                        <td className={tableStyles.nowrap}>
                          {!cert.available ? (
                            <Badge tone="muted">не прочитан</Badge>
                          ) : cert.daysLeft === null ? (
                            <Badge tone="muted">без даты</Badge>
                          ) : cert.daysLeft < 0 ? (
                            <Badge tone="fail">истёк</Badge>
                          ) : cert.daysLeft <= (data?.warnDays ?? 21) ? (
                            <Badge tone="warn">осталось {cert.daysLeft} дн</Badge>
                          ) : (
                            <Badge tone="ok">осталось {cert.daysLeft} дн</Badge>
                          )}
                        </td>
                        <td className={tableStyles.nowrap}>
                          {cert.validTo ? formatDateTime(cert.validTo) : (cert.error ?? '—')}
                        </td>
                        <td>
                          {cert.issuer ?? '—'}
                          {cert.selfSigned && (
                            <>
                              {' '}
                              <Badge tone="warn">самоподписанный</Badge>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                    {(data?.certificates ?? []).length === 0 && (
                      <EmptyRow colSpan={4}>Сертификаты не проверялись</EmptyRow>
                    )}
                  </tbody>
                </Table>
              </TableWrap>
              <p className={styles.source}>{data?.certificateNote}</p>
            </>
          )}
        </Panel>

        <Panel title="Записи доменов (SPF, DKIM, DMARC)">
          {security.isLoading ? (
            <CenteredSpinner />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Домен</th>
                    <th>DNS</th>
                    <th>DKIM</th>
                    <th>Проверен</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.domains ?? []).map((domain) => (
                    <tr key={domain.id}>
                      <td className="mt-mono">{domain.name}</td>
                      <td>
                        <DnsBadge status={domain.dnsOverall} />
                      </td>
                      <td className={tableStyles.nowrap}>
                        {domain.dkimConfigured ? (
                          <Badge tone="ok">{domain.dkimSelector ?? 'есть ключ'}</Badge>
                        ) : (
                          <Badge tone="fail">нет ключа</Badge>
                        )}
                      </td>
                      <td className={tableStyles.nowrap}>{formatRelative(domain.dnsCheckedAt)}</td>
                    </tr>
                  ))}
                  {(data?.domains ?? []).length === 0 && <EmptyRow colSpan={4}>Доменов нет</EmptyRow>}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Panel>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Службы, счётчики и последние действия                               */
/* ------------------------------------------------------------------ */

function ServicesSection({
  summary,
}: {
  summary: Awaited<ReturnType<typeof api.overview>> | null;
}) {
  if (!summary) return null;
  return (
    <>
      <h2 className={styles.section}>Службы и учётные записи</h2>

      <Tiles>
        <Tile
          value={summary.counters.users}
          label={plural(summary.counters.users, 'ящик', 'ящика', 'ящиков')}
        />
        <Tile value={summary.counters.usersActive} label="активных" />
        <Tile value={summary.counters.usersBlocked} label="заблокированных" />
        <Tile
          value={summary.counters.domains}
          label={plural(summary.counters.domains, 'домен', 'домена', 'доменов')}
        />
        <Tile value={summary.counters.aliases} label="алиасов" />
        <Tile value={summary.counters.admins} label="администраторов" />
        <Tile value={formatBytes(summary.counters.quotaTotal)} label="выделено квот" />
        <Tile value={summary.counters.auditToday} label="действий за сутки" />
        <Tile value={summary.counters.impersonations7d} label="входов в ящики за неделю" />
      </Tiles>

      <div className={styles.gridWide}>
        <Panel title="Сервисы">
          <TableWrap>
            <Table>
              <tbody>
                {summary.services.map((s) => (
                  <tr key={s.id}>
                    <td className={tableStyles.nowrap}>{s.title}</td>
                    <td className={tableStyles.nowrap}>
                      <Badge tone={s.state === 'ok' ? 'ok' : s.state === 'fail' ? 'fail' : 'muted'}>
                        {s.state === 'ok'
                          ? 'работает'
                          : s.state === 'fail'
                            ? 'не отвечает'
                            : 'не настроено'}
                      </Badge>
                    </td>
                    <td>{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>

        <Panel title="Последние действия">
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Действие</th>
                  <th>Объект</th>
                </tr>
              </thead>
              <tbody>
                {summary.recentAudit.map((entry) => (
                  <tr key={entry.id}>
                    <td className={tableStyles.nowrap}>{formatRelative(entry.createdAt)}</td>
                    <td>{entry.adminLogin}</td>
                    <td>{entry.actionLabel}</td>
                    <td className="mt-mono">{entry.targetLabel ?? '—'}</td>
                  </tr>
                ))}
                {summary.recentAudit.length === 0 && (
                  <EmptyRow colSpan={4}>Действий пока не было</EmptyRow>
                )}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      </div>
    </>
  );
}
