/**
 * Почтовый поток: очередь писем и история обработанных.
 *
 * Два списка и два разных источника — об этом сказано прямо на экране,
 * потому что разница существенная:
 *
 *   «В очереди» — то, что лежит в Postfix ПРЯМО СЕЙЧАС (postqueue -j
 *     через посредника в его контейнере). Всегда свежее, истории нет:
 *     доставленное письмо исчезает из очереди вместе со своим файлом.
 *
 *   «Обработанные» — разобранный журнал Postfix. Другого источника не
 *     существует, и глубина у него ограничена сроком и числом строк.
 *     Сколько именно — написано под таблицей, а не оставлено на догадку.
 *
 * Обработанные листаются по мере прокрутки: на боевом сервере записей
 * сотни тысяч, и «показать всё» означало бы повесить браузер.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import { api } from '../api/client';
import type {
  FlowDirection,
  FlowEvent,
  FlowHistoryStats,
  FlowStatus,
  QueueMessage,
} from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { Badge, ErrorNotice, Modal, Notice, Pager, Toolbar, ToolbarSpacer } from '../components/ui';
import { can } from '../lib/access';
import {
  isPinnedToTop,
  loadAutoRefresh,
  saveAutoRefresh,
  scrollToTopNear,
  scrollTopNear,
  shouldPoll,
  unreadLabel,
} from '../lib/autoRefresh';
import { formatBytes, formatDateTime } from '../lib/format';
import styles from './FlowPage.module.css';

const QUEUE_LIMIT = 50;
const HISTORY_LIMIT = 50;
/** Как часто опрашивать сервер при включённом автообновлении. */
const POLL_MS = 10_000;

/**
 * Видна ли сейчас вкладка браузера.
 *
 * Забытая на сутки панель иначе молотила бы запросами тот же сервер, что
 * возит почту. Нужно обеим вкладкам раздела, поэтому вынесено сюда.
 */
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

/** Состояния обработанного письма — словами, а не кодами. */
const STATUS_LABEL: Readonly<Record<FlowStatus, string>> = {
  sent: 'доставлено',
  deferred: 'отложено',
  bounced: 'отбито',
  expired: 'срок истёк',
  rejected: 'не принято',
  held: 'придержано',
};

const STATUS_TONE: Readonly<Record<FlowStatus, 'ok' | 'warn' | 'fail' | 'muted'>> = {
  sent: 'ok',
  deferred: 'warn',
  bounced: 'fail',
  expired: 'fail',
  rejected: 'warn',
  held: 'muted',
};

const DIRECTION_LABEL: Readonly<Record<FlowDirection, string>> = {
  in: 'входящее',
  out: 'исходящее',
  unknown: 'неизвестно',
};

/** Где именно письмо лежит в очереди Postfix. */
const QUEUE_NAME_LABEL: Readonly<Record<string, string>> = {
  incoming: 'принимается',
  active: 'доставляется',
  deferred: 'отложено',
  hold: 'придержано',
  corrupt: 'испорчено',
};

const HOURS_OPTIONS = [
  { value: 1, label: 'за последний час' },
  { value: 6, label: 'за 6 часов' },
  { value: 24, label: 'за сутки' },
  { value: 72, label: 'за 3 суток' },
  { value: 24 * 7, label: 'за неделю' },
  { value: 24 * 30, label: 'за месяц' },
];

function queueNameLabel(name: string): string {
  return QUEUE_NAME_LABEL[name] ?? name;
}

/** Сколько письмо уже ждёт. Человеку важнее «два часа», чем точная дата. */
function waitingFor(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  return `${Math.round(hours / 24)} сут`;
}

export function FlowPage() {
  const [tab, setTab] = useState<'queue' | 'history'>('queue');

  return (
    <>
      <PageTitle
        title="Почтовый поток"
        subtitle="Что сейчас в очереди и что уже обработано — по журналу Postfix"
      />

      <div className={styles.tabs} role="tablist" aria-label="Разделы почтового потока">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'queue'}
          className={cx(styles.tab, tab === 'queue' && styles.tabActive)}
          onClick={() => setTab('queue')}
        >
          В очереди
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={cx(styles.tab, tab === 'history' && styles.tabActive)}
          onClick={() => setTab('history')}
        >
          Обработанные
        </button>
      </div>

      {tab === 'queue' ? <QueueTab /> : <HistoryTab />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Очередь                                                              */
/* ------------------------------------------------------------------ */

function QueueTab() {
  const { session } = useSession();
  // Автообновление — по флажку, а не всегда: список, который шевелится сам,
  // решает человек. Память своя у этого раздела (см. lib/autoRefresh.ts).
  const [auto, setAuto] = useState(() => loadAutoRefresh('queue'));
  const visible = usePageVisible();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [queueName, setQueueName] = useState('');
  const [offset, setOffset] = useState(0);
  const [viewing, setViewing] = useState<QueueMessage | null>(null);
  const [confirming, setConfirming] = useState<{
    message: QueueMessage;
    action: 'flush' | 'delete';
  } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /**
   * Последнее действие над очередью НЕ удалось.
   *
   * Зелёная плашка на неудаче — это та же ложь, что и текст «удалено»:
   * человек читает цвет раньше слов.
   */
  const [doneFailed, setDoneFailed] = useState(false);

  // Чтение письма из очереди приравнено к чтению журналов почты: и там и
  // здесь видна чужая переписка. Сервер требует того же права.
  /*
   * Показать письмо целиком — это чужая переписка, а не сводка о ней.
   * Право то же, что у входа в чужой ящик: audit.read есть у роли
   * «Только чтение», которой положено видеть состояние сервера, но не
   * содержание писем сотрудников.
   */
  const mayReadMessage = can(session?.permissions, 'mailbox.impersonate');
  const mayFlush = can(session?.permissions, 'users.write');
  const mayDelete = can(session?.permissions, 'users.delete');

  const queue = useQuery({
    queryKey: ['queue', search, queueName, offset],
    queryFn: () =>
      api.queue({
        search: search.trim() || undefined,
        queueName: queueName || undefined,
        limit: QUEUE_LIMIT,
        offset,
      }),
    // Очередь живёт своей жизнью: письмо уходит из неё само, без нашего
    // участия. Но дёргать список без спросу нельзя — только по флажку и
    // только на видимой вкладке.
    refetchInterval: shouldPoll(auto, visible ? 'visible' : 'hidden') ? POLL_MS : false,
    placeholderData: keepPreviousData,
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'flush' | 'delete' }) =>
      action === 'flush' ? api.queueFlush(id) : api.queueDelete(id),
    onSuccess: (data, variables) => {
      /*
       * УДАЛЕНИЕ БЫВАЕТ И НЕУДАЧНЫМ — С КОДОМ 200.
       *
       * Сервер отвечает `ok: false`, когда удалять было нечего: письмо
       * ушло само, пока страница была открыта. Записи в журнал он в этом
       * случае намеренно не делает. А экран печатал «Письмо ABC удалено
       * из очереди» безусловно — то есть после всей починки на сервере
       * человек по-прежнему видел ложь, и теперь даже без строки в
       * журнале, по которой раньше можно было разобраться.
       */
      const failed = data.ok === false;
      setDone(
        failed
          ? (data.message ?? `Письма ${variables.id} в очереди уже нет — обновите список`)
          : variables.action === 'flush'
            ? `Письмо ${variables.id} поставлено на немедленную доставку`
            : `Письмо ${variables.id} удалено из очереди`,
      );
      setDoneFailed(failed);
      setConfirming(null);
      void client.invalidateQueries({ queryKey: ['queue'] });
    },
  });

  const message = useQuery({
    queryKey: ['queue-message', viewing?.queueId],
    queryFn: () => api.queueMessage(viewing!.queueId),
    enabled: viewing !== null,
  });

  const now = Date.now();
  const byQueue = queue.data?.byQueue ?? {};

  return (
    <>
      <Toolbar>
        <input
          className={`mt-input ${styles.control}`}
          placeholder="Адресат, отправитель, причина"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <select
          className={`mt-select ${styles.control}`}
          value={queueName}
          onChange={(e) => {
            setQueueName(e.target.value);
            setOffset(0);
          }}
          aria-label="Где лежит письмо"
        >
          <option value="">Вся очередь</option>
          {Object.keys(byQueue)
            .sort()
            .map((name) => (
              <option key={name} value={name}>
                {queueNameLabel(name)} ({byQueue[name]})
              </option>
            ))}
        </select>
        <label className={styles.auto}>
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              saveAutoRefresh('queue', e.target.checked);
            }}
          />
          <span>Автообновление</span>
        </label>
        <ToolbarSpacer />
        <Button mode="secondary" size="s" onClick={() => void queue.refetch()}>
          Обновить
        </Button>
      </Toolbar>

      <ErrorNotice error={queue.error} />
      <ErrorNotice error={act.error} />
      {done && <Notice tone={doneFailed ? 'error' : 'success'}>{done}</Notice>}
      {queue.data?.truncated && (
        <Notice tone="info">
          Очередь длиннее предела разбора — показана её часть. Разберитесь с причиной затора:
          столько писем в очереди сами не расходятся.
        </Notice>
      )}

      <p className={styles.source}>
        Данные из очереди Postfix на {queue.data ? formatDateTime(queue.data.takenAt) : '—'}.
        {queue.data ? ` Всего в очереди: ${queue.data.queueTotal}.` : ''} Очередь — это письма, ещё
        не доставленные; доставленные в ней не остаются, их видно в «Обработанных».
      </p>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th className={tableStyles.nowrap}>Ждёт</th>
              <th className={`${tableStyles.nowrap} ${tableStyles.optional}`}>Где</th>
              <th className={tableStyles.optionalNarrow}>Отправитель</th>
              <th>Адресаты</th>
              <th className={`${tableStyles.nowrap} ${tableStyles.optional}`}>Размер</th>
              <th>Последняя причина отсрочки</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(queue.data?.items ?? []).map((item) => (
              <tr key={item.queueId}>
                <td className={tableStyles.nowrap} title={formatDateTime(item.arrivalTime)}>
                  {waitingFor(item.arrivalTime, now)}
                </td>
                <td className={`${tableStyles.nowrap} ${tableStyles.optional}`}>
                  <Badge tone={item.queueName === 'deferred' ? 'warn' : 'muted'}>
                    {queueNameLabel(item.queueName)}
                  </Badge>
                </td>
                <td className={`${styles.mono} ${tableStyles.optionalNarrow}`}>{item.sender}</td>
                <td>
                  <div className={styles.recipients}>
                    {item.recipients.map((r) => (
                      <span key={r.address} className={styles.mono}>
                        {r.address}
                      </span>
                    ))}
                  </div>
                </td>
                <td className={`${tableStyles.nowrap} ${tableStyles.optional}`}>
                  {formatBytes(item.sizeBytes)}
                </td>
                <td className={styles.reason}>{item.reason ?? '—'}</td>
                <td>
                  <div className={styles.rowActions}>
                    {/*
                      Право то же, что требует сервер: в письме очереди
                      лежит чужая переписка целиком. Без проверки кнопка
                      осталась бы у роли, которой сервер ответит отказом, —
                      человек нажимал бы её и получал ошибку вместо письма.
                    */}
                    {mayReadMessage && (
                      <Button mode="secondary" size="s" onClick={() => setViewing(item)}>
                        Письмо
                      </Button>
                    )}
                    {mayFlush && (
                      <Button
                        mode="secondary"
                        size="s"
                        onClick={() => setConfirming({ message: item, action: 'flush' })}
                      >
                        Доставить
                      </Button>
                    )}
                    {mayDelete && (
                      <Button
                        mode="secondary"
                        size="s"
                        onClick={() => setConfirming({ message: item, action: 'delete' })}
                      >
                        Удалить
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {queue.data && queue.data.items.length === 0 && (
              <EmptyRow colSpan={7}>
                {queue.data.queueTotal === 0
                  ? 'Очередь пуста: все принятые письма доставлены.'
                  : 'Под отбор ничего не подошло.'}
              </EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>

      <Pager
        total={queue.data?.total ?? 0}
        limit={QUEUE_LIMIT}
        offset={offset}
        onChange={setOffset}
      />

      {viewing && (
        <Modal
          wide
          title={`Письмо ${viewing.queueId}`}
          onClose={() => setViewing(null)}
          footer={
            <Button mode="secondary" onClick={() => setViewing(null)}>
              Закрыть
            </Button>
          }
        >
          {message.isPending && <p>Читаем письмо…</p>}
          <ErrorNotice error={message.error} />
          {message.data && (
            <>
              {message.data.truncated && (
                <Notice tone="info">
                  Показано начало письма: целиком оно может весить десятки мегабайт.
                </Notice>
              )}
              <pre className={styles.messageText}>{message.data.text}</pre>
            </>
          )}
        </Modal>
      )}

      {confirming && (
        <Modal
          title={confirming.action === 'flush' ? 'Доставить сейчас?' : 'Удалить из очереди?'}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button mode="secondary" onClick={() => setConfirming(null)}>
                Отмена
              </Button>
              <Button
                mode="primary"
                className={confirming.action === 'delete' ? styles.danger : undefined}
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ id: confirming.message.queueId, action: confirming.action })
                }
              >
                {confirming.action === 'flush' ? 'Доставить' : 'Удалить'}
              </Button>
            </>
          }
        >
          <p>
            Письмо <span className={styles.mono}>{confirming.message.queueId}</span> от{' '}
            <span className={styles.mono}>{confirming.message.sender}</span> для{' '}
            <span className={styles.mono}>
              {confirming.message.recipients.map((r) => r.address).join(', ')}
            </span>
            .
          </p>
          {confirming.action === 'flush' ? (
            <p>
              Postfix попробует доставить его прямо сейчас, не дожидаясь своего расписания. Если
              причина отказа не устранена, письмо снова отложится.
            </p>
          ) : (
            <p>
              Письмо исчезнет насовсем: отправитель не получит ни доставки, ни отбойника — для него
              письмо просто пропадёт. Отменить это нельзя. Действие попадёт в журнал аудита вместе с
              адресами.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* История обработанных                                                 */
/* ------------------------------------------------------------------ */

function HistoryTab() {
  const [hours, setHours] = useState(24);
  const [status, setStatus] = useState('');
  const [direction, setDirection] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [auto, setAuto] = useState(() => loadAutoRefresh('flow-history'));
  const visible = usePageVisible();
  const client = useQueryClient();

  // Поиск применяем с задержкой: иначе каждый набранный символ — это
  // запрос к базе на сотнях тысяч строк.
  useEffect(() => {
    const timer = setTimeout(() => setApplied(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const stats = useQuery({
    queryKey: ['flow-stats', hours],
    queryFn: () => api.flowStats(hours),
  });

  const history = useInfiniteQuery({
    queryKey: ['flow-history', hours, status, direction, applied],
    initialPageParam: null as { time: string; id: string } | null,
    queryFn: ({ pageParam }) =>
      api.flowHistory({
        hours,
        status: status || undefined,
        direction: direction || undefined,
        search: applied || undefined,
        limit: HISTORY_LIMIT,
        beforeTime: pageParam?.time,
        beforeId: pageParam?.id,
      }),
    getNextPageParam: (last) => last.nextBefore,
  });

  const items: FlowEvent[] = useMemo(
    () => history.data?.pages.flatMap((page) => page.items) ?? [],
    [history.data],
  );

  // Подгрузка по мере прокрутки. Маячок в конце списка: как только он
  // показался на экране, просим следующую страницу. Кнопка «ещё» тоже
  // остаётся — на случай, если наблюдатель недоступен.
  const sentinel = useRef<HTMLDivElement | null>(null);
  const fetchNext = history.fetchNextPage;
  const hasNext = history.hasNextPage;
  const fetching = history.isFetchingNextPage;

  const onIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries.some((e) => e.isIntersecting) && hasNext && !fetching) void fetchNext();
    },
    [fetchNext, hasNext, fetching],
  );

  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(onIntersect, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onIntersect]);

  /* --- Автообновление ------------------------------------------------ */
  //
  // История растёт СВЕРХУ: свежие письма новее верхней строки. Поэтому
  // перезапрашивать весь список нельзя — человек мог подгрузить прокруткой
  // тысячу записей, и обновление схлопнуло бы их обратно в пятьдесят,
  // выдернув из-под глаз то, что он читает. Вместо этого дочитываем ТОЛЬКО
  // появившееся после верхней строки (обратный курсор afterTime/afterId).
  //
  // Прилипание — как в журналах, по положению прокрутки: стоит человек в
  // начале списка — новое вливается само; отмотал вниз, разбирается в
  // старом — копим и показываем счётчик, а ленту не трогаем.
  const historyKey = useMemo(
    () => ['flow-history', hours, status, direction, applied] as const,
    [hours, status, direction, applied],
  );
  const top = items[0];
  const [pendingItems, setPendingItems] = useState<FlowEvent[]>([]);

  const fresh = useQuery({
    queryKey: ['flow-history-new', hours, status, direction, applied, top?.id],
    queryFn: () =>
      api.flowHistory({
        hours,
        status: status || undefined,
        direction: direction || undefined,
        search: applied || undefined,
        limit: HISTORY_LIMIT,
        afterTime: top?.occurredAt,
        afterId: top?.id,
      }),
    enabled: auto && visible && top !== undefined,
    refetchInterval: shouldPoll(auto, visible ? 'visible' : 'hidden') ? POLL_MS : false,
  });

  // Вливание новых записей в начало ленты. Отдельная функция, потому что
  // вызывается из двух мест: сама (когда список стоит в начале) и по кнопке.
  const merge = useCallback(
    (fresh: FlowEvent[], gapped: boolean) => {
      setPendingItems([]);
      // Записей набежало больше страницы — значит между ними и показанными
      // есть пропуск, и склейка дала бы дыру в ленте. Честнее перечитать.
      if (gapped) {
        void client.invalidateQueries({ queryKey: historyKey });
        return;
      }
      client.setQueryData(historyKey, (old: { pages: { items: FlowEvent[] }[] } | undefined) => {
        if (!old || old.pages.length === 0) return old;
        const [first, ...rest] = old.pages;
        const seen = new Set(first!.items.map((item) => item.id));
        const added = fresh.filter((item) => !seen.has(item.id));
        if (added.length === 0) return old;
        return { ...old, pages: [{ ...first!, items: [...added, ...first!.items] }, ...rest] };
      });
      void stats.refetch();
    },
    [client, historyKey, stats],
  );

  const freshItems = fresh.data?.items;
  const freshGapped = fresh.data?.hasMore ?? false;
  useEffect(() => {
    if (!freshItems || freshItems.length === 0) return;
    // Прокручивается не окно, а колонка содержимого панели — считаем по ней.
    if (isPinnedToTop({ scrollTop: scrollTopNear(sentinel.current) }))
      merge(freshItems, freshGapped);
    else setPendingItems(freshItems);
  }, [freshItems, freshGapped, merge]);

  // Смена фильтра начинает историю заново — накопленное к ней не относится.
  useEffect(() => setPendingItems([]), [hours, status, direction, applied]);

  const counts = stats.data?.counts ?? {};

  return (
    <>
      <Toolbar>
        <select
          className={`mt-select ${styles.control}`}
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          aria-label="За какое время"
        >
          {HOURS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className={`mt-select ${styles.control}`}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Чем закончилось"
        >
          <option value="">Любой исход</option>
          {(Object.keys(STATUS_LABEL) as FlowStatus[]).map((key) => (
            <option key={key} value={key}>
              {STATUS_LABEL[key]}
              {counts[key] !== undefined ? ` (${counts[key]})` : ''}
            </option>
          ))}
        </select>
        <select
          className={`mt-select ${styles.control}`}
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          aria-label="Направление"
        >
          <option value="">Все направления</option>
          <option value="in">Только входящие</option>
          <option value="out">Только исходящие</option>
        </select>
        <input
          className={`mt-input ${styles.control}`}
          placeholder="Адрес отправителя или адресата"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className={styles.auto}>
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              saveAutoRefresh('flow-history', e.target.checked);
              if (!e.target.checked) setPendingItems([]);
            }}
          />
          <span>Автообновление</span>
        </label>
        <ToolbarSpacer />
        <Button
          mode="secondary"
          size="s"
          onClick={() => {
            setPendingItems([]);
            void client.invalidateQueries({ queryKey: historyKey });
            void stats.refetch();
          }}
        >
          Обновить
        </Button>
      </Toolbar>

      {pendingItems.length > 0 && (
        <div className={styles.unread}>
          <Button
            mode="secondary"
            size="s"
            onClick={() => {
              merge(pendingItems, freshGapped);
              scrollToTopNear(sentinel.current);
            }}
          >
            ↑ {unreadLabel(pendingItems.length)}
          </Button>
        </div>
      )}

      <ErrorNotice error={history.error ?? stats.error} />

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th className={tableStyles.nowrap}>Когда</th>
              <th className={tableStyles.nowrap}>Исход</th>
              <th className={`${tableStyles.nowrap} ${tableStyles.optional}`}>Куда</th>
              <th className={tableStyles.optionalNarrow}>Отправитель</th>
              <th>Адресат</th>
              <th className={`${tableStyles.nowrap} ${tableStyles.optional}`}>Задержка</th>
              <th>Ответ принимающей стороны</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className={tableStyles.nowrap}>{formatDateTime(item.occurredAt)}</td>
                <td className={tableStyles.nowrap}>
                  <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                </td>
                <td className={`${tableStyles.nowrap} ${tableStyles.optional}`}>
                  {DIRECTION_LABEL[item.direction]}
                </td>
                <td className={`${styles.mono} ${tableStyles.optionalNarrow}`}>
                  {item.sender ?? '—'}
                </td>
                <td className={styles.mono}>{item.recipient ?? '—'}</td>
                <td className={`${tableStyles.nowrap} ${tableStyles.optional}`}>
                  {item.delaySeconds === null ? '—' : `${Math.round(item.delaySeconds)} с`}
                </td>
                <td className={styles.reason}>
                  {item.dsn ? <span className={styles.mono}>{item.dsn} </span> : null}
                  {item.reason ?? '—'}
                </td>
              </tr>
            ))}
            {!history.isPending && items.length === 0 && (
              <EmptyRow colSpan={7}>
                За выбранное время подходящих писем нет.
                {stats.data?.collectingSince
                  ? ` Разбор журнала ведётся с ${formatDateTime(stats.data.collectingSince)} — раньше этого момента истории нет вовсе.`
                  : ''}
              </EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>

      <div className={styles.loaded}>
        Загружено записей: {items.length}
        {stats.data ? ` из ${stats.data.total} за выбранное время` : ''}
      </div>

      <div ref={sentinel} className={styles.sentinel}>
        {history.isFetchingNextPage ? (
          'Подгружаем…'
        ) : history.hasNextPage ? (
          <Button mode="secondary" size="s" onClick={() => void history.fetchNextPage()}>
            Показать ещё
          </Button>
        ) : items.length > 0 ? (
          'Это все записи за выбранное время.'
        ) : null}
      </div>

      {stats.data && <HistoryDepth stats={stats.data} />}
    </>
  );
}

/**
 * Честная подпись о глубине истории.
 *
 * Раздел показывает разобранный журнал Postfix — единственный источник
 * сведений об уже обработанных письмах. У этого источника есть начало
 * (момент установки) и конец (срок хранения). Не сказать об этом — значит
 * позволить принять пустую таблицу за «писем не было».
 */
function HistoryDepth({ stats }: { stats: FlowHistoryStats }) {
  return (
    <p className={styles.source}>
      Источник — журнал Postfix: сам почтовый сервер историю обработанных писем не хранит, письмо
      исчезает из очереди вместе со своим файлом.{' '}
      {stats.collectingSince
        ? `Разбор ведётся с ${formatDateTime(stats.collectingSince)}; раньше этого момента данных нет.`
        : 'Разбор журнала ещё не начинался.'}{' '}
      Храним {stats.retentionDays} сут. и не больше {stats.maxRows.toLocaleString('ru-RU')} записей
      — что вытеснено, того больше нет.
      {stats.oldest ? ` Самая старая запись: ${formatDateTime(stats.oldest)}.` : ''}
    </p>
  );
}
