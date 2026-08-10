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
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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

/** Время строки — только часы:минуты:секунды: дату несёт разделитель. */
function timeOf(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ru-RU', { hour12: false });
}

/** Ключ дня строки: «2026-08-09». Пусто — у строки нет разбираемого времени. */
export function dayKeyOf(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** «9 августа 2026, суббота» — подпись разделителя дней. */
export function dayTitleOf(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    weekday: 'long',
  });
}

/**
 * Куда вставить разделители дней.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ
 * ------------------------------------------------------------------
 * У строки показывалось только время. Пока лента — это последние
 * несколько минут, разницы нет; но она прокручивается вверх на весь файл
 * журнала, а файл живёт неделю. Строка «03:14:02 postfix connection
 * timed out» без даты не отвечает на главный вопрос: это сегодня ночью
 * или в прошлый вторник. Разбираясь, почему письма не доходили в среду,
 * администратор искал глазами границу суток, которой на экране не было.
 *
 * Дублировать дату в каждой строке нельзя: она одинакова у сотен подряд
 * и съедает ширину, которая нужна тексту. Поэтому дата показывается там,
 * где меняется, — как в переписке.
 *
 * Возвращается набор смещений: строка с таким смещением открывает новый
 * день. Первая строка ленты — тоже (дата видна сразу, а не после
 * прокрутки до ближайшей границы).
 */
export function dayBreaks(lines: readonly { offset: number; at: string | null }[]): Set<number> {
  const breaks = new Set<number>();
  let previous = '';
  for (const line of lines) {
    const key = dayKeyOf(line.at);
    if (key === '') continue;
    if (key !== previous) breaks.add(line.offset);
    previous = key;
  }
  return breaks;
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
  /* Границы суток внутри ленты: дату показываем там, где она меняется. */
  const breaks = useMemo(() => dayBreaks(loaded.lines), [loaded.lines]);
  const [pending, setPending] = useState(true);
  const [olderPending, setOlderPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rotated, setRotated] = useState(false);
  /** Короткое пояснение к последнему действию с лентой. */
  const [note, setNote] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [pinned, setPinned] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);
  /** Прилипание читается из ссылки: обработчик опроса не пересоздаётся. */
  const pinnedRef = useRef(true);
  /** Опрос новых записей уже в полёте — второй не запускаем. */
  const pollingRef = useRef(false);
  /** Что нужно сделать с прокруткой после отрисовки. */
  const scrollPlan = useRef<
    | { kind: 'bottom' }
    | { kind: 'keep'; height: number }
    /** Держим взгляд на конкретной строке: её смещение в файле и место в ленте. */
    | { kind: 'anchor'; offset: number; top: number }
    | null
  >(null);

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
    setNote(null);
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
      setLoaded((prev) => {
        /*
         * ПОКА МЫ ХОДИЛИ ЗА СТАРЫМ, КРОМКА МОГЛА ПЕРЕЕХАТЬ.
         *
         * Лента держит последние четыре тысячи строк: пришедшая порция
         * новых записей срезает верх и переставляет курсор старого выше
         * того места, откуда мы читали. Приписать вернувшиеся строки к
         * такой ленте — значит оставить между ними и её началом
         * невидимый кусок, до которого потом не добраться.
         *
         * Проще и честнее ничего не приписывать: курсор уже указывает на
         * новую кромку, и повторное нажатие дочитает ровно оттуда.
         */
        if (prev.olderBefore !== before) {
          /*
           * Молчать здесь нельзя. Кнопка сменилась на «Подгружаем
           * старое…», вернулась обратно — и НИ ОДНОЙ строки не
           * добавилось: со стороны это сломанная кнопка. А случается это
           * ровно при разборе аварии, когда записи идут потоком и лента
           * обрезается на каждом опросе.
           */
          setNote('Пока читали старое, пришли новые записи — нажмите ещё раз.');
          return prev;
        }
        return {
          ...prev,
          lines: [...[...page.items].reverse(), ...prev.lines],
          olderBefore: page.nextBefore,
          budgetExhausted: page.budgetExhausted,
        };
      });
    } catch (err) {
      setError(err);
    } finally {
      setOlderPending(false);
    }
  }, [applied, level, loaded.fileId, loaded.olderBefore, olderPending, source, serviceNoise]);

  /* --- Дочитывание нового -------------------------------------------- */
  const pollOnce = useCallback(async () => {
    if (loaded.fileId === '') return;
    /*
     * ОДИН ОПРОС ЗА РАЗ.
     *
     * Возврат на вкладку зовёт опрос немедленно, а тикающий таймер может
     * выстрелить следом, пока первый запрос ещё в полёте. Оба уходят с
     * одним и тем же смещением и дописывают ОДНИ И ТЕ ЖЕ строки: в ленте
     * появляются дубли, у React дублируются ключи, а якорь прокрутки
     * (он ищет строку по её смещению) может померить не тот узел и
     * сдвинуть ленту куда попало.
     *
     * Ссылка, а не состояние: между проверкой и запросом не должно быть
     * ни одной перерисовки.
     */
    if (pollingRef.current) return;
    pollingRef.current = true;
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
        const trimmed = kept.length !== grown.length;
        // Единственный случай, когда прокрутку всё же надо поправить:
        // окно переполнилось и лишнее срезано СВЕРХУ. Тогда содержимое
        // над кромкой действительно уменьшилось.
        if (!stick) {
          /*
           * ПРИ ОБРЕЗКЕ ПОПРАВКА СЧИТАЕТСЯ ПО ЯКОРЮ, А НЕ ПО ВЫСОТЕ.
           *
           * Формула `scrollTop += scrollHeight - высота_до` верна только
           * для чистого дописывания СВЕРХУ (дочитывание старого): там
           * ниже кромки ничего не появляется. А при обрезке сверху убрано
           * `h_срез`, снизу дописано `h_ново`, и разность высот равна
           * `h_ново − h_срез`: поправка выходила больше нужной ровно на
           * высоту дописанного. Читаемый текст уезжал вверх на десяток
           * строк каждые три секунды — то есть ровно то, чего комментарий
           * выше обещал не делать.
           *
           * Якорь — первая строка, которая ОСТАНЕТСЯ. Её положение в
           * ленте до и после обновления даёт точную поправку, и высоту
           * строк знать не нужно.
           */
          if (trimmed && list) {
            const anchor = kept[0]?.offset;
            const node =
              anchor === undefined
                ? null
                : list.querySelector<HTMLElement>(`[data-log-offset="${String(anchor)}"]`);
            scrollPlan.current =
              node && anchor !== undefined
                ? { kind: 'anchor', offset: anchor, top: node.offsetTop }
                : null;
          } else {
            scrollPlan.current = null;
          }
        }
        /*
         * СРЕЗАННОЕ СВЕРХУ ОБЯЗАНО ОСТАВАТЬСЯ ДОСТИЖИМЫМ.
         *
         * Окно держит последние четыре тысячи строк, лишнее срезается. А
         * курсор «читать старее» при этом не двигался: он показывал на
         * место ПЕРЕД самой первой загруженной строкой — той, которую
         * срезали час назад. Между верхней кромкой ленты и этим курсором
         * образовывалась дыра: нажатие «Показать более старые» уводило
         * человека мимо целого куска журнала, и куска этого он не видел
         * уже никогда, хотя строки в файле есть и лента их только что
         * показывала.
         *
         * Теперь курсор переставляется на смещение новой первой строки —
         * дочитывание продолжается ровно оттуда, где обрывается видимое.
         */
        const olderBefore =
          trimmed && kept.length > 0 ? (kept[0]?.offset ?? prev.olderBefore) : prev.olderBefore;
        return {
          ...prev,
          lines: kept,
          olderBefore,
          after: tail.nextAfter,
          sizeBytes: tail.sizeBytes,
        };
      });
      if (!stick) setUnread((prev) => prev + tail.items.length);
    } catch (err) {
      // Разовый сбой опроса не должен гасить уже показанное: покажем его
      // и продолжим — журнал мог просто провернуться под нами.
      if (err instanceof ApiError && err.status >= 500) setError(err);
    } finally {
      pollingRef.current = false;
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
    } else if (plan.kind === 'anchor') {
      // Строка, на которой держим взгляд, съехала вверх ровно на высоту
      // срезанного — на столько же двигаем и прокрутку.
      const node = list.querySelector<HTMLElement>(`[data-log-offset="${String(plan.offset)}"]`);
      if (node) list.scrollTop += node.offsetTop - plan.top;
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
        <label
          className={styles.auto}
          title="Отчёты проверок живости и внутренние соединения служб"
        >
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
      {note !== null && <Notice tone="info">{note}</Notice>}
      {rotated && (
        <Notice tone="info">
          Журнал провернулся, пока вы его читали: прежнее место в файле больше ничего не значит.
          Нажмите «Обновить», чтобы перейти к новому файлу. Что было раньше — в разделе «Почтовый
          поток»: обработанные письма туда попадают и проворот переживают.
        </Notice>
      )}
      {loaded.budgetExhausted && (
        <Notice tone="info">
          Просмотрен кусок журнала, подходящих строк в нём нет. Нажмите «Показать более старые
          записи» — поиск продолжится дальше по файлу.
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
          {/*
            КНОПКА, А НЕ ТОЛЬКО ПРОКРУТКА.

            Дочитывание старого висело исключительно на событии прокрутки.
            А прокрутки не возникает, когда показанное помещается на
            экран целиком, — то есть ровно в самом частом случае: отбор по
            уровню «ошибки» даёт три строки, дальше по файлу их сотни, и
            подпись предлагает «прокрутите ленту вверх» там, где крутить
            нечего. Человек делает вывод, что ошибок больше нет.

            То же и с сообщением «просмотрен кусок журнала, подходящих
            строк в нём нет»: оно советует прокрутку, которой не бывает.
          */}
          <div className={styles.older}>
            {/*
              Кнопка не исчезает на время загрузки.

              Прежде она подменялась текстом «Подгружаем старое…» — то есть
              узел с фокусом удалялся, и фокус падал на body. Лента не
              фокусируема, так что прокрутить её с клавиатуры было уже
              нечем: чтобы дочитать следующую порцию, приходилось заново
              протабиться через всю панель инструментов. С клавиатуры
              кнопка работала ровно один раз подряд.
            */}
            {loaded.olderBefore !== null ? (
              /*
               * `aria-disabled`, а НЕ `disabled`.
               *
               * Выключенный элемент во всех основных браузерах теряет
               * фокус — он уходит на body. То есть прошлая правка задачу
               * не решила: нажав Enter на кнопке, клавиатурный человек
               * снова оставался без фокуса, а лента не фокусируема, и
               * добраться до кнопки можно было только протабившись через
               * всю панель инструментов. Здесь узел остаётся доступным,
               * а повторное нажатие гасится в самом обработчике.
               */
              <button
                type="button"
                className={styles.olderButton}
                aria-disabled={olderPending}
                onClick={() => {
                  if (olderPending) return;
                  void loadOlder();
                }}
              >
                {olderPending ? 'Подгружаем старое…' : 'Показать более старые записи'}
              </button>
            ) : olderPending ? (
              'Подгружаем старое…'
            ) : loaded.lines.length > 0 ? (
              'Это начало текущего файла журнала'
            ) : (
              ''
            )}
          </div>

          {loaded.lines.map((item) => (
            <Fragment key={`${item.offset}-${item.text.slice(0, 24)}`}>
              {breaks.has(item.offset) && item.at !== null && (
                <div className={styles.dayBreak}>{dayTitleOf(item.at)}</div>
              )}
              <div
                className={cx(styles.line, styles[`level_${item.level}`])}
                data-log-offset={item.offset}
              >
                <span className={styles.time}>{timeOf(item.at)}</span>
                {/* Уровень словом: цвет — не единственный признак */}
                <span className={styles.level}>{levelShort(item.level)}</span>
                <span className={styles.component}>{item.component || '—'}</span>
                <span className={styles.text}>{item.text}</span>
              </div>
            </Fragment>
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
        {windowFull && <span>Держим последние {WINDOW_LINES}; старее — кнопкой над лентой</span>}
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
