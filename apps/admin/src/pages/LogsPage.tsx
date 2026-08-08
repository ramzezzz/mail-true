/**
 * Журналы работы почты — по службам, по уровням, с живым обновлением.
 *
 * ОТКУДА ДАННЫЕ. Файлы общего тома, куда пишут Postfix, Dovecot и сам
 * сервер приложения. `docker compose logs` отсюда недоступен: он требует
 * сокета Docker, а тот даёт права root на всей машине — за показ журналов
 * такую дверь не открывают. Службы поэтому пишут и в файл, и в stdout.
 *
 * УРОВНИ. Четыре ступени: ошибки, предупреждения, события, подробности.
 * Выбранная ступень показывает себя и всё, что важнее.
 *
 * ЦВЕТ. Строка красится по уровню (см. lib/logLevels.ts и
 * styles/logLevels.css). Цвет не единственный признак: рядом стоит слово
 * и полоса слева — журнал читается и без различения цветов.
 *
 * ------------------------------------------------------------------
 * ПОРЯДОК И ЖИВОЕ ОБНОВЛЕНИЕ
 * ------------------------------------------------------------------
 * Свежее — ВНИЗУ, как в `tail -f`: новое приписывается к концу, старое
 * подгружается прокруткой вверх. Так живой журнал и читают.
 *
 * Прилипание к концу считается по ПОЛОЖЕНИЮ ПРОКРУТКИ, а не по флагу
 * «пользователь трогал»: отмотал вверх — перестали дёргать, вернулся вниз
 * сам — снова следим. Человек, разбирающийся в старой записи, не должен
 * выдёргиваться вниз каждым новым событием.
 *
 * Когда прилипание выключено, а новое пришло, показывается кнопка со
 * счётчиком непрочитанного — иначе о новом можно вовсе не узнать.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import { api, ApiError } from '../api/client';
import type { LogLine } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { ErrorNotice, Notice, Toolbar, ToolbarSpacer } from '../components/ui';
import {
  isPinnedToBottom,
  keepWindow,
  loadAutoRefresh,
  saveAutoRefresh,
  shouldPoll,
  unreadLabel,
} from '../lib/autoRefresh';
import { formatBytes, formatDateTime } from '../lib/format';
import { LOG_LEVELS, LOG_SOURCES, levelShort, type LogLevel } from '../lib/logLevels';
import '../styles/logLevels.css';
import styles from './LogsPage.module.css';

/** Сколько строк берём за раз — и при первом показе, и при подгрузке. */
const PAGE_SIZE = 200;

/**
 * Сколько строк держим в памяти.
 *
 * Копить без предела нельзя: сутки на открытой вкладке — это сотни тысяч
 * узлов разметки. Лишнее срезается сверху; более старое всегда можно
 * подгрузить прокруткой вверх, о чём под лентой и написано.
 */
const WINDOW_LINES = 4000;

/** Как часто спрашиваем новое при включённом автообновлении. */
const POLL_MS = 3000;

/** Время строки — только часы:минуты:секунды: дата одна на весь экран. */
function timeOf(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ru-RU', { hour12: false });
}

interface Loaded {
  /** Строки от старых к новым — в том же порядке, что на экране. */
  lines: LogLine[];
  /** Курсор старого: null — старее в этом файле ничего нет. */
  olderBefore: number | null;
  /** Место, с которого дочитывается новое. */
  after: number;
  fileId: string;
  sizeBytes: number;
  /** Просмотр упёрся в потолок, подходящих строк не нашлось. */
  budgetExhausted: boolean;
}

const EMPTY: Loaded = {
  lines: [],
  olderBefore: null,
  after: 0,
  fileId: '',
  sizeBytes: 0,
  budgetExhausted: false,
};

export function LogsPage() {
  const [source, setSource] = useState<string>('postfix');
  const [level, setLevel] = useState<LogLevel>('debug');
  const [search, setSearch] = useState('');
  /*
   * Служебные строки скрыты по умолчанию. Их пишет система про саму себя:
   * проверки живости стучатся в порты Dovecot и Postfix, те записывают
   * каждый стук. На одно настоящее письмо приходятся десятки таких строк,
   * и живая доставка в них тонет. Скрыты, а не выброшены: иногда нужно
   * убедиться, что служба вообще отвечала.
   */
  const [serviceNoise, setServiceNoise] = useState(false);
  const [applied, setApplied] = useState('');

  // Поиск с задержкой: каждый набранный символ иначе означал бы новый
  // проход по мегабайтам файла.
  useEffect(() => {
    const timer = setTimeout(() => setApplied(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* --- Автообновление: флажок свой у каждого журнала ------------------ */
  const [auto, setAuto] = useState(() => loadAutoRefresh(`logs:${source}`));
  useEffect(() => {
    // Смена журнала — смена и его памяти: за очередью следят постоянно,
    // а в журнал сервера приложения заходят разбираться.
    setAuto(loadAutoRefresh(`logs:${source}`));
  }, [source]);
  const toggleAuto = useCallback(
    (enabled: boolean) => {
      setAuto(enabled);
      saveAutoRefresh(`logs:${source}`, enabled);
    },
    [source],
  );

  /* --- Состояние ленты ---------------------------------------------- */
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [pending, setPending] = useState(true);
  const [olderPending, setOlderPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rotated, setRotated] = useState(false);
  const [unread, setUnread] = useState(0);
  const [pinned, setPinned] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);
  /** Прилипание читается из ссылки: обработчик опроса не пересоздаётся. */
  const pinnedRef = useRef(true);
  /** Что нужно сделать с прокруткой после отрисовки. */
  const scrollPlan = useRef<{ kind: 'bottom' } | { kind: 'keep'; height: number } | null>(null);

  const sources = useQuery({ queryKey: ['log-sources'], queryFn: () => api.logSources() });

  /* --- Первый показ и смена отбора ----------------------------------- */
  const reload = useCallback(async () => {
    setPending(true);
    setError(null);
    setRotated(false);
    setUnread(0);
    try {
      const page = await api.logs({
        source,
        level,
        search: applied || undefined,
        serviceNoise,
        limit: PAGE_SIZE,
      });
      scrollPlan.current = { kind: 'bottom' };
      pinnedRef.current = true;
      setPinned(true);
      setLoaded({
        // Сервер отдаёт свежие сверху, на экране они снизу.
        lines: [...page.items].reverse(),
        olderBefore: page.nextBefore,
        after: page.tailOffset,
        fileId: page.fileId,
        sizeBytes: page.sizeBytes,
        budgetExhausted: page.budgetExhausted,
      });
    } catch (err) {
      setLoaded(EMPTY);
      setError(err);
    } finally {
      setPending(false);
    }
  }, [source, level, applied, serviceNoise]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* --- Подгрузка старого (прокрутка вверх) --------------------------- */
  const loadOlder = useCallback(async () => {
    const list = listRef.current;
    if (!list || olderPending) return;
    const before = loaded.olderBefore;
    if (before === null) return;
    setOlderPending(true);
    try {
      const page = await api.logs({
        source,
        level,
        search: applied || undefined,
        serviceNoise,
        limit: PAGE_SIZE,
        before,
        fileId: loaded.fileId,
      });
      if (page.rotated) setRotated(true);
      // Положение видимых строк обязано остаться прежним: иначе текст
      // уезжает из-под глаз ровно в тот момент, когда его читают.
      scrollPlan.current = { kind: 'keep', height: list.scrollHeight };
      setLoaded((prev) => ({
        ...prev,
        lines: [...[...page.items].reverse(), ...prev.lines],
        olderBefore: page.nextBefore,
        budgetExhausted: page.budgetExhausted,
      }));
    } catch (err) {
      setError(err);
    } finally {
      setOlderPending(false);
    }
  }, [applied, level, loaded.fileId, loaded.olderBefore, olderPending, source, serviceNoise]);

  /* --- Дочитывание нового -------------------------------------------- */
  const pollOnce = useCallback(async () => {
    if (loaded.fileId === '') return;
    try {
      const tail = await api.logsNew({
        source,
        level,
        search: applied || undefined,
        serviceNoise,
        after: loaded.after,
        limit: PAGE_SIZE,
        fileId: loaded.fileId,
      });
      if (tail.rotated) {
        setRotated(true);
        setLoaded((prev) => ({ ...prev, after: tail.nextAfter, fileId: tail.fileId }));
        return;
      }
      if (tail.items.length === 0) {
        if (tail.nextAfter !== loaded.after) {
          setLoaded((prev) => ({ ...prev, after: tail.nextAfter }));
        }
        return;
      }
      const stick = pinnedRef.current;
      if (stick) scrollPlan.current = { kind: 'bottom' };
      // Новое приписывается СНИЗУ, поэтому всё, что выше кромки окна, не
      // сдвигается само по себе: прокрутку трогать не надо вовсе.
      //
      // Поправка на прирост высоты (как при подгрузке старого) здесь была
      // бы вредной — проверено на стенде: строка под верхней кромкой
      // уезжала из-под глаз на каждой порции новых записей, ровно в тот
      // момент, когда её читают.
      const list = listRef.current;
      setLoaded((prev) => {
        const grown = [...prev.lines, ...tail.items];
        const kept = keepWindow(grown, WINDOW_LINES) as LogLine[];
        // Единственный случай, когда прокрутку всё же надо поправить:
        // окно переполнилось и лишнее срезано СВЕРХУ. Тогда содержимое
        // над кромкой действительно уменьшилось.
        if (!stick) {
          scrollPlan.current =
            kept.length === grown.length ? null : { kind: 'keep', height: list?.scrollHeight ?? 0 };
        }
        return { ...prev, lines: kept, after: tail.nextAfter, sizeBytes: tail.sizeBytes };
      });
      if (!stick) setUnread((prev) => prev + tail.items.length);
    } catch (err) {
      // Разовый сбой опроса не должен гасить уже показанное: покажем его
      // и продолжим — журнал мог просто провернуться под нами.
      if (err instanceof ApiError && err.status >= 500) setError(err);
    }
  }, [applied, level, loaded.after, loaded.fileId, source, serviceNoise]);

  useEffect(() => {
    if (!auto) return;
    let stopped = false;
    const tick = (): void => {
      // Невидимая вкладка не опрашивается вовсе: забытая на сутки панель
      // иначе молотила бы запросами тот же сервер, что возит почту.
      if (!stopped && shouldPoll(true, document.visibilityState)) void pollOnce();
    };
    const timer = setInterval(tick, POLL_MS);
    // Вернулись на вкладку — догоняем сразу, не ожидая следующего оборота.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [auto, pollOnce]);

  /* --- Прокрутка ------------------------------------------------------ */
  useLayoutEffect(() => {
    const list = listRef.current;
    const plan = scrollPlan.current;
    if (!list || !plan) return;
    scrollPlan.current = null;
    if (plan.kind === 'bottom') {
      list.scrollTop = list.scrollHeight;
    } else {
      list.scrollTop += list.scrollHeight - plan.height;
    }
  }, [loaded.lines]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const stick = isPinnedToBottom(list);
    pinnedRef.current = stick;
    setPinned(stick);
    if (stick) setUnread(0);
    // Дошли до верха — подгружаем старое.
    if (list.scrollTop < 200 && loaded.olderBefore !== null && !olderPending) void loadOlder();
  }, [loadOlder, loaded.olderBefore, olderPending]);

  const jumpToEnd = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
    setUnread(0);
  }, []);

  const sourceInfo = sources.data?.items.find((item) => item.source === source);
  const sourceMeta = LOG_SOURCES.find((item) => item.id === source);
  const windowFull = loaded.lines.length >= WINDOW_LINES;

  return (
    <>
      <PageTitle
        title="Журналы почты"
        subtitle="Приём, доставка и отправка — по службам и по уровню важности"
      />

      <Toolbar>
        <select
          className={`mt-select ${styles.control}`}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          aria-label="Журнал какой службы"
        >
          {LOG_SOURCES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        <select
          className={`mt-select ${styles.control}`}
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel)}
          aria-label="Уровень важности"
        >
          {LOG_LEVELS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        <input
          className={`mt-input ${styles.control}`}
          placeholder="Искать в строках"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className={styles.auto}>
          <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />
          <span>Автообновление</span>
        </label>
        {/*
          Служебные строки — то, что система пишет про саму себя: проверка
          живости стучится в порты Dovecot и Postfix, те записывают каждый
          стук. На одно настоящее письмо их приходятся десятки. Скрыты по
          умолчанию, но не выброшены: иногда нужно убедиться, что служба
          вообще отвечала.
        */}
        <label className={styles.auto} title="Отчёты проверок живости и внутренние соединения служб">
          <input
            type="checkbox"
            checked={serviceNoise}
            onChange={(e) => setServiceNoise(e.target.checked)}
          />
          <span>Служебные</span>
        </label>
        <ToolbarSpacer />
        <Button mode="secondary" size="s" onClick={() => void reload()}>
          Обновить
        </Button>
      </Toolbar>

      <p className={styles.hint}>
        {sourceMeta?.hint}
        {'. '}
        {LOG_LEVELS.find((item) => item.id === level)?.hint}.
        {auto ? ' Новые записи появляются сами; пока лента отмотана вверх, она не дёргается.' : ''}
      </p>

      <ErrorNotice error={error} />
      {rotated && (
        <Notice tone="info">
          Журнал провернулся, пока вы его читали: прежнее место в файле больше ничего не значит.
          Нажмите «Обновить», чтобы перейти к новому файлу. Что было раньше — в разделе «Почтовый
          поток»: обработанные письма туда попадают и проворот переживают.
        </Notice>
      )}
      {loaded.budgetExhausted && (
        <Notice tone="info">
          Просмотрен кусок журнала, подходящих строк в нём нет. Прокрутите ленту вверх — поиск
          продолжится дальше по файлу.
        </Notice>
      )}

      <div className={styles.listBox}>
        <div
          ref={listRef}
          className={styles.lines}
          role="log"
          aria-label="Строки журнала"
          aria-live={auto && pinned ? 'polite' : 'off'}
          onScroll={onScroll}
        >
          <div className={styles.older}>
            {olderPending
              ? 'Подгружаем старое…'
              : loaded.olderBefore !== null
                ? 'Прокрутите вверх, чтобы дочитать старое'
                : loaded.lines.length > 0
                  ? 'Это начало текущего файла журнала'
                  : ''}
          </div>

          {loaded.lines.map((item) => (
            <div
              key={`${item.offset}-${item.text.slice(0, 24)}`}
              className={cx(styles.line, styles[`level_${item.level}`])}
            >
              <span className={styles.time}>{timeOf(item.at)}</span>
              {/* Уровень словом: цвет — не единственный признак */}
              <span className={styles.level}>{levelShort(item.level)}</span>
              <span className={styles.component}>{item.component || '—'}</span>
              <span className={styles.text}>{item.text}</span>
            </div>
          ))}

          {pending && <div className={styles.empty}>Читаем журнал…</div>}
          {!pending && loaded.lines.length === 0 && !error && (
            <div className={styles.empty}>
              Подходящих строк нет. Попробуйте другой уровень или другую службу.
            </div>
          )}
        </div>

        {unread > 0 && !pinned && (
          <button type="button" className={styles.unread} onClick={jumpToEnd}>
            {unreadLabel(unread)} ↓
          </button>
        )}
      </div>

      <div className={styles.footer}>
        <span>Показано строк: {loaded.lines.length}</span>
        {windowFull && <span>Держим последние {WINDOW_LINES}; старее — прокруткой вверх</span>}
        {sourceInfo && (
          <span>
            Файл: {sourceInfo.fileName}, {formatBytes(sourceInfo.sizeBytes)}
          </span>
        )}
        {sourceInfo?.modifiedAt && (
          <span>Последняя запись: {formatDateTime(sourceInfo.modifiedAt)}</span>
        )}
        {sourceInfo && sourceInfo.rotatedFiles > 0 && (
          <span>
            Рядом лежит провёрнутых кусков: {sourceInfo.rotatedFiles} — раздел показывает только
            текущий файл
          </span>
        )}
      </div>

      {sources.data && sourceInfo && !sourceInfo.present && (
        <Notice tone="error">
          Файла {sourceInfo.fileName} нет в {sources.data.dir}. Служба либо не запущена, либо не
          настроена писать журнал в общий том (см. том maillogs в infra/docker-compose.yml).
        </Notice>
      )}
    </>
  );
}
