/**
 * Виртуализированный список писем (@tanstack/react-virtual).
 * Повторяет строку .llc mail.ru (метрики — research/mailru/row-anatomy.json):
 * высота 48px (компактный режим — 40px/13px), колонка точки непрочитанного
 * 28px, аватар 32×32 с чекбоксом при наведении, отправитель 22%, флажок 24px,
 * тема+сниппет (со счётчиком цепочки перед темой), значки, дата 44px.
 * Группировка по периодам: «Сегодня», «Вчера», «Неделя», «Июль 2026».
 *
 * На телефоне строка другая — в три строки, как в мобильном mail.ru:
 * отправитель и время, тема, начало письма. Раскладку делает CSS
 * (сетка в `@media (max-width: 600px)`), а высоту обязан знать и JavaScript:
 * её берёт `estimateSize` виртуализации, и без переключения все три строки
 * налезали бы друг на друга в отведённых 48 пикселях.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MessageSummary } from '@mail-true/shared';
import { useUiStore } from '../app/store';
import { Checkbox, Spinner } from '../components';
import { isReliable, messageCategory } from '../lib/categories';
import { cx } from '../lib/cx';
import { setDragMessages } from '../lib/dragMessages';
import {
  SWIPE_START,
  isHorizontalSwipe,
  pullArmed,
  pullDistance,
  swipeAction,
  swipeOffset,
  type SwipeAction,
} from '../lib/gestures';
import { HOTKEY_SCOPE_ATTR, HOTKEY_SCOPE_LIST } from '../lib/hotkeys';
import { formatListDate, groupMessagesByPeriod } from '../lib/listDates';
import { rowSelectionStates, type RowSelectionState } from '../lib/selection';
import { usePhone } from '../lib/useMediaQuery';
import { IconArchive, IconAttach, IconFlagFilled, IconShield, IconTrash } from './icons';
import styles from './MessageList.module.css';

export type ListRow =
  | { type: 'header'; label: string }
  | { type: 'message'; message: MessageSummary };

/** Плоский список строк: заголовки периодов + письма. */
export function flattenRows(messages: readonly MessageSummary[], now?: Date): ListRow[] {
  const rows: ListRow[] = [];
  for (const group of groupMessagesByPeriod(messages, now)) {
    rows.push({ type: 'header', label: group.label });
    for (const message of group.items) rows.push({ type: 'message', message });
  }
  return rows;
}

const HEADER_HEIGHT = 40;

/**
 * Высота строки списка. Не украшение и не догадка: ровно это число
 * виртуализация кладёт в `transform: translateY` каждой строке, поэтому оно
 * обязано совпадать с тем, что насчитает CSS.
 *
 *   рабочий стол — 48px: 20 (одна строка текста) + поля;
 *   телефон      — 84px: 20 (отправитель) + 20 (тема) + 18 (превью)
 *                  + 20 полей и зазоров.
 * Компактный режим («pony mode») ужимает и то и другое.
 */
export const ROW_HEIGHT = {
  desktop: { normal: 48, compact: 40 },
  phone: { normal: 84, compact: 68 },
} as const;

export function rowHeightFor(compact: boolean, phone: boolean): number {
  const set = phone ? ROW_HEIGHT.phone : ROW_HEIGHT.desktop;
  return compact ? set.compact : set.normal;
}

export interface MessageListProps {
  messages: readonly MessageSummary[];
  /** id письма, на котором стоит клавиатурный курсор. */
  focusedId?: string | null;
  /**
   * Письма, которые уже уезжают из папки: перенос или удаление отправлены,
   * ответа сервера ещё нет. Строки гаснут сразу, не дожидаясь его.
   */
  leavingIds?: readonly string[];
  onContextMenu?(message: MessageSummary, x: number, y: number): void;
  /**
   * Долистали до конца — пора просить следующую страницу.
   * Без этого всё, что дальше первой сотни писем, было недостижимо.
   */
  onEndReached?(): void;
  /**
   * Строку смахнули до конца: вправо — в архив, влево — удалить.
   * Ровно те же два действия есть кнопками в панели над списком, жест их
   * не заменяет, а сокращает: на телефоне до кнопки надо сперва выделить
   * письмо, а смахнуть можно сразу.
   */
  onSwipe?(message: MessageSummary, action: SwipeAction): void;
  /**
   * Список потянули вниз — обновить. Возвращённое обещание держит крутилку
   * до конца запроса: без него «обновление» мигало бы и исчезало, ничего
   * не сообщая. Кнопка «Обновить» в панели делает то же самое.
   */
  onRefresh?(): void | Promise<unknown>;
}

function senderName(m: MessageSummary): string {
  // Именно проверка на непустоту, а не `??`: у писем без отображаемого имени
  // в заголовке приходит пустая строка, и оператор `??` её пропускал —
  // в списке колонка отправителя оставалась пустой.
  const name = m.from.name?.trim();
  return name ? name : m.from.address;
}

/** Детерминированный цвет аватара из адреса отправителя. */
function avatarHue(address: string): number {
  let h = 0;
  for (const ch of address) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

interface RowProps {
  message: MessageSummary;
  selection: RowSelectionState;
  focused: boolean;
  /** Письмо уезжает из папки — строка гаснет и сдвигается. */
  leaving: boolean;
  /** Единственная строка списка, попадающая в обход по Tab (roving tabindex). */
  tabbable: boolean;
  threadCount: number;
  onContextMenu?: MessageListProps['onContextMenu'];
  onSwipe?: MessageListProps['onSwipe'];
  /** Ставится только на строку под курсором — по нему и переносится фокус. */
  rowRef?: ((node: HTMLAnchorElement | null) => void) | undefined;
}

/** Ось, по которой пошло касание. `'?'` — ещё не решили. */
type SwipeAxis = '?' | 'x' | 'y';

function Row({
  message,
  selection,
  focused,
  leaving,
  tabbable,
  threadCount,
  onContextMenu,
  onSwipe,
  rowRef,
}: RowProps) {
  const toggleSelected = useUiStore((s) => s.toggleSelected);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const navigate = useNavigate();
  const unread = !message.flags.seen;
  const category = messageCategory(message.labels);
  const reliable = isReliable(message.labels);

  /**
   * Смахивание. Сдвиг держим и в состоянии (его рисуем), и в ссылке
   * (её читает обработчик отпускания): к моменту `touchend` замыкание
   * с прежним состоянием уже устарело бы, и жест срабатывал бы через раз.
   */
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const offsetRef = useRef(0);
  const touch = useRef<{ x: number; y: number; axis: SwipeAxis } | null>(null);
  /** Только что смахивали — следующий клик по строке не наш. */
  const swiped = useRef(false);

  const setSwipe = (value: number) => {
    offsetRef.current = value;
    setOffset(value);
  };

  const cancelSwipe = () => {
    touch.current = null;
    setDragging(false);
    setSwipe(0);
  };

  const onTouchStart = (e: ReactTouchEvent) => {
    if (!onSwipe) return;
    const point = e.touches[0];
    if (!point) return;
    swiped.current = false;
    touch.current = { x: point.clientX, y: point.clientY, axis: '?' };
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    const from = touch.current;
    const point = e.touches[0];
    if (!from || !point) return;
    const dx = point.clientX - from.x;
    const dy = point.clientY - from.y;

    if (from.axis === '?') {
      // Пока ось не выбрана, событие принадлежит прокрутке: перехватывать
      // касание с первого же пикселя нельзя — список перестал бы листаться.
      if (isHorizontalSwipe(dx, dy)) from.axis = 'x';
      else if (Math.abs(dy) >= SWIPE_START) from.axis = 'y';
      else return;
    }
    if (from.axis !== 'x') return;

    swiped.current = true;
    setDragging(true);
    setSwipe(swipeOffset(dx));
  };

  const onTouchEnd = () => {
    const from = touch.current;
    touch.current = null;
    setDragging(false);
    const action = from?.axis === 'x' ? swipeAction(offsetRef.current) : null;
    // Строка возвращается на место в любом случае: при недоведённом жесте
    // это и есть отмена, при доведённом — её всё равно уберёт сам перенос.
    setSwipe(0);
    if (action) onSwipe?.(message, action);
  };

  /** Что откроется под строкой при таком сдвиге. */
  const pending = offset > 0 ? 'archive' : offset < 0 ? 'delete' : null;
  const armed = swipeAction(offset) !== null;

  const row = (
    <a
      ref={rowRef}
      href={`/${message.folderId}/${encodeURIComponent(message.id)}`}
      style={
        offset === 0
          ? undefined
          : { transform: `translateX(${offset}px)`, transition: dragging ? 'none' : undefined }
      }
      className={cx(
        styles.row,
        unread && styles.unread,
        reliable && styles.reliable,
        selection.selected && styles.selected,
        selection.firstSelected && styles.firstSelected,
        selection.lastSelected && styles.lastSelected,
        focused && styles.focused,
        leaving && styles.leaving,
      )}
      aria-hidden={leaving || undefined}
      /* Roving tabindex: Tab заводит в список один раз, дальше — стрелки.
         Раньше в обход попадали все сто строк подряд. */
      tabIndex={tabbable ? 0 : -1}
      aria-current={focused ? 'true' : undefined}
      draggable
      onDragStart={(e) => {
        // Тащим выделение целиком, если тащат одно из выделенных писем;
        // иначе — только строку под курсором.
        const ids =
          selection.selected && selectedIds.size > 0 ? [...selectedIds] : [message.id];
        setDragMessages(e.dataTransfer, ids);
      }}
      onClick={(e) => {
        // После смахивания браузер всё равно шлёт клик по строке. Без этой
        // проверки любой жест заодно открывал бы письмо.
        if (swiped.current) {
          swiped.current = false;
          e.preventDefault();
          return;
        }
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.button !== 0) return;
        e.preventDefault();
        navigate(`/${message.folderId}/${encodeURIComponent(message.id)}`);
      }}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(message, e.clientX, e.clientY);
      }}
    >
      {/* Колонка точки непрочитанного, 32px */}
      <span className={styles.readStatus}>
        {unread && <span className={styles.unreadDot} aria-label="Непрочитанное" />}
      </span>

      {/* Аватар 32×32; при наведении поверх — чекбокс */}
      <span className={styles.avatarCell}>
        <span
          className={styles.avatar}
          style={{ backgroundColor: `hsl(${avatarHue(message.from.address)} 60% 55%)` }}
          aria-hidden="true"
        >
          {(senderName(message)[0] ?? '?').toUpperCase()}
        </span>
        {reliable && (
          <span className={styles.reliableBadge} title="Надёжный отправитель">
            <IconShield size={12} />
          </span>
        )}
        <span
          className={cx(styles.rowCheckbox, selection.selected && styles.rowCheckboxVisible)}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleSelected(message.id);
          }}
        >
          <Checkbox checked={selection.selected} readOnly aria-label="Выбрать письмо" />
        </span>
      </span>

      {/* Отправитель, 22% */}
      <span className={styles.correspondent}>
        <span className={styles.correspondentName}>{senderName(message)}</span>
      </span>

      {/* Флажок «важное», 24px — красная закладка-лента */}
      <span className={styles.flagCell}>
        {message.flags.flagged && (
          <span className={styles.flagIcon} title="Важное">
            <IconFlagFilled />
          </span>
        )}
      </span>

      {/*
        Тема + сниппет. Счётчик писем в цепочке — пилюля ПЕРЕД темой, в её же
        колонке: ровно так у mail.ru (01-inbox.png, колонка темы x=588, пилюля
        588…616, тема с 627). Раньше он стоял после имени отправителя.
      */}
      <span className={styles.title}>
        {threadCount > 1 && (
          <span className={styles.threadCount} title={`Писем в переписке: ${threadCount}`}>
            {threadCount}
          </span>
        )}
        <span className={styles.subject}>{message.subject || '(без темы)'}</span>
        <span className={styles.snippet}>{message.snippet}</span>
      </span>

      {/* Значки: категория, вложение */}
      <span className={styles.secondaryData}>
        {category && (
          <span
            className={styles.categoryDot}
            style={{ backgroundColor: `var(${category.colorVar})` }}
            title={category.name}
          />
        )}
        {message.hasAttachments && (
          <span className={styles.attachIcon} title="С вложением">
            <IconAttach />
          </span>
        )}
      </span>

      {/* Дата, 44px */}
      <span className={styles.date}>{formatListDate(message.date)}</span>
    </a>
  );

  // Без жеста строка остаётся ровно тем, чем была, — лишней обёртки нет
  if (!onSwipe) return row;

  return (
    <div
      className={styles.swipeShell}
      data-swipe={pending ?? 'none'}
      data-swipe-armed={armed ? 'true' : 'false'}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={cancelSwipe}
    >
      {/*
        Подложка под строкой: она и объясняет, что будет. Пока жест не доведён,
        значок бледный — это и есть видимая разница между «отпущу и удалится»
        и «отпущу и вернётся». Для чтения с экрана подложка не нужна: те же
        действия там доступны кнопками панели.
      */}
      <span className={styles.swipeBack} aria-hidden="true">
        <span className={cx(styles.swipeSide, styles.swipeArchive)}>
          <IconArchive />
          <span>В архив</span>
        </span>
        <span className={cx(styles.swipeSide, styles.swipeDelete)}>
          <span>Удалить</span>
          <IconTrash />
        </span>
      </span>
      {row}
    </div>
  );
}

export function MessageList({
  messages,
  focusedId,
  leavingIds,
  onContextMenu,
  onEndReached,
  onSwipe,
  onRefresh,
}: MessageListProps) {
  const compact = useUiStore((s) => s.compactList);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const phone = usePhone();
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => flattenRows(messages), [messages]);
  const leavingSet = useMemo(() => new Set(leavingIds ?? []), [leavingIds]);

  /** Счётчик писем в цепочке в пределах загруженного списка. */
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) counts.set(m.threadId, (counts.get(m.threadId) ?? 0) + 1);
    return counts;
  }, [messages]);

  const selectionStates = useMemo(
    () =>
      rowSelectionStates(
        rows.map((r) => (r.type === 'message' ? r.message.id : null)),
        selectedIds,
      ),
    [rows, selectedIds],
  );

  // Высота строки зависит от ширины экрана: на телефоне строка трёхстрочная
  const rowHeight = rowHeightFor(compact, phone);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === 'header' ? HEADER_HEIGHT : rowHeight),
    overscan: 12,
    getItemKey: (i) => {
      const row = rows[i];
      if (!row) return i;
      return row.type === 'header' ? `h:${row.label}` : row.message.id;
    },
  });

  // При смене плотности пересчитываем размеры строк
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  // Долистали до последних строк — подгружаем следующую страницу.
  // Порог в несколько строк, чтобы новые письма успели приехать
  // до того, как пользователь упрётся в конец списка.
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisible = virtualItems[virtualItems.length - 1]?.index ?? -1;
  useEffect(() => {
    if (!onEndReached || rows.length === 0) return;
    if (lastVisible >= rows.length - 5) onEndReached();
  }, [lastVisible, rows.length, onEndReached]);

  // Клавиатурный курсор всегда в зоне видимости
  useEffect(() => {
    if (!focusedId) return;
    const index = rows.findIndex((r) => r.type === 'message' && r.message.id === focusedId);
    if (index >= 0) virtualizer.scrollToIndex(index);
  }, [focusedId, rows, virtualizer]);

  /**
   * Курсор списка ведёт за собой настоящий фокус. Раньше стрелки только
   * перекрашивали строку, а `document.activeElement` оставался на прежнем
   * месте: события фокуса не было, и скринридер молчал — незрячий шёл
   * по списку вслепую.
   *
   * Ссылка ставится только на строку под курсором, поэтому React зовёт её
   * при каждом переезде курсора — в том числе когда обе строки уже на экране.
   */
  const focusedRowRef = useCallback((node: HTMLAnchorElement | null) => {
    if (node) node.focus({ preventScroll: true });
  }, []);

  /** Строка, попадающая в обход по Tab: под курсором, иначе — первая. */
  const firstMessage = rows.find((r): r is Extract<ListRow, { type: 'message' }> =>
    r.type === 'message',
  );
  const tabbableId = focusedId ?? firstMessage?.message.id ?? null;

  const emptySelection: RowSelectionState = {
    selected: false,
    firstSelected: false,
    lastSelected: false,
  };

  /* --- «Потянуть вниз — обновить» ------------------------------------- */

  /** Насколько список оттянут пальцем (px). */
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullFrom = useRef<number | null>(null);
  const pullRef = useRef(0);

  const setPulled = (value: number) => {
    pullRef.current = value;
    setPull(value);
  };

  const onPullStart = (e: ReactTouchEvent) => {
    // Тянуть можно только с самого верха списка: иначе жест отбирал бы
    // обычную прокрутку у всех, кто листает вверх с середины папки.
    if (!onRefresh || refreshing) return;
    if ((scrollRef.current?.scrollTop ?? 0) > 0) return;
    pullFrom.current = e.touches[0]?.clientY ?? null;
  };

  const onPullMove = (e: ReactTouchEvent) => {
    const from = pullFrom.current;
    const y = e.touches[0]?.clientY;
    if (from === null || y === undefined) return;
    if ((scrollRef.current?.scrollTop ?? 0) > 0) {
      setPulled(0);
      return;
    }
    setPulled(pullDistance(y - from));
  };

  const onPullEnd = () => {
    const distance = pullRef.current;
    pullFrom.current = null;
    // Недотянули — список просто встаёт на место. Это тоже отмена жеста.
    if (!onRefresh || !pullArmed(distance)) {
      setPulled(0);
      return;
    }
    setPulled(0);
    setRefreshing(true);
    void Promise.resolve(onRefresh()).finally(() => setRefreshing(false));
  };

  /** Сдвиг всего списка: пока тянут — за пальцем, во время запроса — полоска. */
  const shift = refreshing ? 40 : pull;

  return (
    <div className={cx(styles.listRoot, compact && styles.compact)}>
      {/* Крутилка «обновляем». Живёт над списком, а не внутри прокрутки:
          иначе она уезжала бы вместе с письмами при первом же движении. */}
      {(pull > 0 || refreshing) && (
        <div
          className={styles.pullIndicator}
          style={{ transform: `translateY(${Math.min(shift, 56)}px)` }}
          data-armed={refreshing || pullArmed(pull) ? 'true' : 'false'}
          role="status"
          aria-label={refreshing ? 'Обновляем список писем' : 'Отпустите, чтобы обновить'}
        >
          <Spinner size={20} />
        </div>
      )}

      <div
        ref={scrollRef}
        className={cx(styles.scroll, compact && styles.compact)}
        onTouchStart={onPullStart}
        onTouchMove={onPullMove}
        onTouchEnd={onPullEnd}
        onTouchCancel={onPullEnd}
        // Внутри списка стрелки и Enter — его собственное поведение,
        // поэтому глобальные горячие клавиши здесь не отключаются
        {...{ [HOTKEY_SCOPE_ATTR]: HOTKEY_SCOPE_LIST }}
      >
        <div
          className={styles.inner}
          style={{
            height: virtualizer.getTotalSize(),
            ...(shift > 0 ? { transform: `translateY(${shift}px)` } : {}),
          }}
        >
          {virtualItems.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                className={styles.virtualRow}
                style={{ transform: `translateY(${item.start}px)`, height: item.size }}
              >
                {row.type === 'header' ? (
                  <div className={styles.periodHeader}>{row.label}</div>
                ) : (
                  <Row
                    message={row.message}
                    selection={selectionStates.get(row.message.id) ?? emptySelection}
                    focused={row.message.id === focusedId}
                    leaving={leavingSet.has(row.message.id)}
                    tabbable={row.message.id === tabbableId}
                    rowRef={row.message.id === focusedId ? focusedRowRef : undefined}
                    threadCount={threadCounts.get(row.message.threadId) ?? 1}
                    onContextMenu={onContextMenu}
                    onSwipe={onSwipe}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
