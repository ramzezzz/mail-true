/**
 * Виртуализированный список писем (@tanstack/react-virtual).
 * Повторяет строку .llc привычный почтовый интерфейс (метрики — эталонные снимки интерфейса):
 * высота 48px (компактный режим — 40px/13px), колонка точки непрочитанного
 * 28px, аватар 32×32 с чекбоксом при наведении, отправитель 22%, флажок 24px,
 * тема+сниппет (со счётчиком цепочки перед темой), значки, дата 44px.
 * Группировка по периодам: «Сегодня», «Вчера», «Неделя», «Июль 2026».
 *
 * На телефоне строка другая — в три строки, как в мобильных почтовых интерфейсах:
 * отправитель и время, тема, начало письма. Раскладку делает CSS
 * (сетка в `@media (max-width: 600px)`), а высоту обязан знать и JavaScript:
 * её берёт `estimateSize` виртуализации, и без переключения все три строки
 * налезали бы друг на друга в отведённых 48 пикселях.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
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
import { restoreScrollTop, rowIndexOf } from '../lib/listPosition';
import { rowSelectionStates, type RowSelectionState } from '../lib/selection';
import { usePhone } from '../lib/useMediaQuery';
import {
  IconArchive,
  IconAttach,
  IconAwaitReply,
  IconClock,
  IconFlagFilled,
  IconShield,
  IconTrash,
} from './icons';
import { LabelPills } from './LabelPill';
import type { MailLabel } from './labelsApi';
import styles from './MessageList.module.css';
import { SenderAvatar } from './SenderAvatar';
import {
  correspondentLabel,
  displayName,
  isRowFlagged,
  isRowUnread,
  rowHasAttachments,
  rowLabelKeys,
  rowThreadCount,
} from './threadList';

export type ListRow =
  { type: 'header'; label: string } | { type: 'message'; message: MessageSummary };

/**
 * Пустой справочник меток — постоянная, а не `[]` по месту.
 * Новый массив на каждом рендере менял бы свойство каждой строки и сводил
 * бы на нет всю экономию виртуализации.
 */
const NO_LABELS: readonly MailLabel[] = [];

/** Заголовок группы вернувшихся писем — над всеми периодами. */
export const RETURNED_GROUP_LABEL = 'Вернулись к вам';

/**
 * Заголовок группы писем, на которые не ответили к сроку.
 *
 * Отдельно от «Вернулись к вам», хотя обе группы стоят наверху: вернувшееся
 * из «Отложенных» — это ЧУЖОЕ письмо, которое человек убрал с глаз сам,
 * а здесь — его СОБСТВЕННОЕ письмо, на которое промолчал собеседник.
 * Свалить их в одну группу значило бы объяснить и то, и другое одним
 * словом, которое не подходит ни к одному.
 */
export const NO_REPLY_GROUP_LABEL = 'Ответа не было';

/**
 * Плоский список строк: заголовки периодов + письма.
 *
 * Письма, вернувшиеся из «Отложенных», выносятся ОТДЕЛЬНОЙ группой в самый
 * верх, и это не украшение. Письмо возвращается на своё место по дате —
 * то есть в середину списка, туда, откуда человек его неделю назад и убрал.
 * Без закрепления вверху возможность не работала бы вовсе: письмо честно
 * вернулось, а найти его нельзя. Ровно так же поступает Яндекс.
 *
 * Группа исчезает сама: пометку возврата снимает сервер, как только письмо
 * прочитано (apps/api/src/routes/messages.ts).
 */
/*
 * Строка списка — это ПЕРЕПИСКА, когда сервер прислал её сводку
 * (`message.thread`), и одно письмо, когда не прислал. Разницы в раскладке
 * между ними нет: в строке всё равно показывается последнее письмо
 * разговора — его тема, его дата, его начало, — а от переписки берутся
 * счётчик, участники и признаки «есть непрочитанное», «есть флажок»,
 * «есть вложение».
 *
 * Отсюда важное для виртуализации следствие: высота строки от группировки
 * НЕ зависит и остаётся той же (см. ROW_HEIGHT ниже). Так же устроен и
 * привычный почтовый интерфейс — строка с пилюлей «3» ровно такой же высоты, как без неё.
 * Держать это правилом дешевле, чем измерять каждую строку: как только
 * высоты разойдутся, `estimateSize` начнёт врать, и список поедет —
 * причём тем сильнее, чем дальше пролистали.
 */
export function flattenRows(messages: readonly MessageSummary[], now?: Date): ListRow[] {
  const rows: ListRow[] = [];
  const lifted = (m: MessageSummary): boolean =>
    Boolean(m.returnedFromSnooze) || m.awaitReply === 'overdue';
  const returned = messages.filter((m) => m.returnedFromSnooze);
  /*
   * Письма, на которые не ответили, поднимаются наверх ровно по той же
   * причине, что и вернувшиеся из «Отложенных»: сервер кладёт во «Входящие»
   * КОПИЮ отправленного письма, а дата у неё — старая, та самая, когда его
   * отправляли. Оставь его на своём месте по дате — и письмо, отправленное
   * неделю назад, окажется на седьмом экране списка, то есть напоминания
   * не будет вовсе.
   */
  const overdue = messages.filter((m) => !m.returnedFromSnooze && m.awaitReply === 'overdue');
  const rest = returned.length + overdue.length > 0 ? messages.filter((m) => !lifted(m)) : messages;

  if (returned.length > 0) {
    rows.push({ type: 'header', label: RETURNED_GROUP_LABEL });
    for (const message of returned) rows.push({ type: 'message', message });
  }
  if (overdue.length > 0) {
    rows.push({ type: 'header', label: NO_REPLY_GROUP_LABEL });
    for (const message of overdue) rows.push({ type: 'message', message });
  }
  for (const group of groupMessagesByPeriod(rest, now)) {
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
 *
 * Строка ПЕРЕПИСКИ той же высоты, и это не совпадение, а требование к
 * вёрстке. Всё, что добавляет группировка, — пилюля со счётчиком (24px
 * внутри 48px) и список участников в колонке отправителя, которая и без
 * того обрезается многоточием в одну строку. Ни то, ни другое строку не
 * растит, поэтому число здесь остаётся одно на оба вида строк.
 * Проверено измерением: tests/threadList.test.tsx.
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
  /**
   * Открыть письмо своим способом вместо перехода на страницу просмотра.
   *
   * Нужно папке «Черновики»: щелчок по черновику должен открывать окно
   * написания, а не просмотр письма — дописать неотправленное письмо иначе
   * нечем. Ссылка у строки при этом остаётся прежней, поэтому Ctrl+щелчок
   * и «Открыть в новой вкладке» по-прежнему показывают письмо.
   */
  /* Свойством, а не методом: страница передаёт сюда `undefined`, когда папка
     обычная, и при exactOptionalPropertyTypes это разные типы. */
  onOpen?: ((message: MessageSummary) => void) | undefined;
  /**
   * Ключ, под которым запоминается прокрутка списка («папка + отбор»).
   *
   * Без него список ничего не помнит и ведёт себя как раньше. С ним уход
   * в письмо и возврат обратно оставляют человека на том же месте — иначе
   * при просмотре нескольких писем подряд место приходится искать заново
   * после каждого.
   */
  scrollKey?: string | undefined;
  /**
   * Письмо, из которого вернулись: строка подсвечивается, и к ней же
   * доводится прокрутка, если она оказалась за пределами окна.
   */
  highlightId?: string | null | undefined;
  /**
   * Подвал списка — кнопка догрузки. Принимается сюда, а не рисуется
   * страницей рядом, потому что должен жить ВНУТРИ области прокрутки:
   * снаружи он висел под списком постоянно, ещё до того, как человек
   * долистал до конца.
   */
  footer?: ReactNode;
  /**
   * Сроки возврата отложенных писем: идентификатор письма -> «завтра в 08:00».
   *
   * Нужны только папке «Отложенные». Строка без срока там читается как
   * обычное письмо, и понять, чем эта папка отличается от «Архива», нельзя
   * ничем: срок — единственное, что в ней есть содержательного.
   */
  snoozeLabels?: ReadonlyMap<string, string> | undefined;
  /**
   * Справочник своих меток: имя и цвет каждой. Приходит СВЕРХУ, а не
   * спрашивается здесь хуком, нарочно — список рисуется и в проверках, где
   * никакого запроса к серверу нет вовсе, и заводить ради пилюли требование
   * «оберни список в провайдер запросов» значило бы поменять условия
   * отрисовки всему списку ради украшения строки.
   */
  labels?: readonly MailLabel[] | undefined;
}

/**
 * Имя для КРУЖКА строки. Кружок один, а участников переписки может быть
 * несколько, поэтому он остаётся кружком последнего письма — того самого,
 * которое строка и показывает. В колонке отправителя рядом при этом стоят
 * все участники (correspondentLabel).
 */
function senderName(m: MessageSummary): string {
  return displayName(m.from);
}

/* Цвет кружка и буква в нём переехали в SenderAvatar: тот же кружок теперь
   умеет показывать ещё и логотип домена, и держать это в двух местах
   значило бы рано или поздно развести букву с логотипом по виду. */

interface RowProps {
  message: MessageSummary;
  selection: RowSelectionState;
  focused: boolean;
  /** Из этого письма человек только что вернулся — строка подсвечена. */
  visited: boolean;
  /** Письмо уезжает из папки — строка гаснет и сдвигается. */
  leaving: boolean;
  /** Единственная строка списка, попадающая в обход по Tab (roving tabindex). */
  tabbable: boolean;
  threadCount: number;
  /** Срок возврата («завтра в 08:00») — только в папке «Отложенные». */
  snoozeLabel?: string | undefined;
  /** Справочник меток и ключевые слова ЭТОЙ строки (см. MessageListProps). */
  labels: readonly MailLabel[];
  labelKeys: readonly string[];
  onContextMenu?: MessageListProps['onContextMenu'];
  onSwipe?: MessageListProps['onSwipe'];
  onOpen?: MessageListProps['onOpen'];
  /** Ставится только на строку под курсором — по нему и переносится фокус. */
  rowRef?: ((node: HTMLAnchorElement | null) => void) | undefined;
}

/** Ось, по которой пошло касание. `'?'` — ещё не решили. */
type SwipeAxis = '?' | 'x' | 'y';

function Row({
  message,
  selection,
  focused,
  visited,
  leaving,
  tabbable,
  threadCount,
  snoozeLabel,
  labels,
  labelKeys,
  onContextMenu,
  onSwipe,
  onOpen,
  rowRef,
}: RowProps) {
  const toggleSelected = useUiStore((s) => s.toggleSelected);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const navigate = useNavigate();
  // Непрочитанность, флажок и скрепка берутся по ВСЕЙ переписке, а не по
  // последнему письму: строка представляет разговор целиком (см. threadList).
  const unread = isRowUnread(message);
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
        // Подсветка «отсюда ты вышел» — третье состояние строки, тише и
        // выделения галочкой, и клавиатурного курсора; поэтому и стоит
        // в списке классов после них.
        visited && styles.visited,
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
        const ids = selection.selected && selectedIds.size > 0 ? [...selectedIds] : [message.id];
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
        // Папка «Черновики» открывает письмо иначе — окном написания.
        // Проверка стоит ПОСЛЕ разбора Ctrl/Cmd и средней кнопки: открытие
        // в новой вкладке остаётся открытием ссылки, то есть просмотром.
        if (onOpen) {
          onOpen(message);
          return;
        }
        void navigate(`/${message.folderId}/${encodeURIComponent(message.id)}`);
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
        <SenderAvatar
          className={styles.avatar}
          name={senderName(message)}
          address={message.from.address}
          /* Домен ставит СЕРВЕР и только письмам, чья подлинность
             подтверждена: логотип читается как знак подлинности, и рядом
             с подделкой он опаснее, чем буква. Здесь его не вычисляют
             и не подменяют — см. apps/api/src/mail/sender-auth.ts. */
          logoDomain={message.senderLogoDomain}
        />
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
          {/* Строка-переписка выделяется целиком, и говорить об этом надо
              вслух: незрячий человек иначе не отличит выбор одного письма
              от выбора разговора из шести. */}
          <Checkbox
            checked={selection.selected}
            readOnly
            aria-label={threadCount > 1 ? 'Выбрать переписку' : 'Выбрать письмо'}
          />
        </span>
      </span>

      {/* Отправитель, 22%. У переписки здесь её участники: «Иван, Пётр» */}
      <span className={styles.correspondent}>
        <span className={styles.correspondentName}>{correspondentLabel(message)}</span>
      </span>

      {/* Флажок «важное», 24px — красная закладка-лента */}
      <span className={styles.flagCell}>
        {isRowFlagged(message) && (
          <span className={styles.flagIcon} title="Важное">
            <IconFlagFilled />
          </span>
        )}
      </span>

      {/*
        Тема + сниппет. Счётчик писем в цепочке — пилюля ПЕРЕД темой, в её же
        колонке: ровно так в привычных почтовых интерфейсах (01-inbox.png, колонка темы x=588, пилюля
        588…616, тема с 627). Раньше он стоял после имени отправителя.
      */}
      <span className={styles.title}>
        {threadCount > 1 && (
          <span className={styles.threadCount} title={`Писем в переписке: ${threadCount}`}>
            {threadCount}
          </span>
        )}
        {/*
          Свои метки — цветными пилюлями С НАЗВАНИЕМ, сразу после счётчика
          переписки и перед темой. Название рядом с цветом обязательно:
          цвет различают не все, и метка, показанная одним кружком, для
          части людей не значит ничего.

          Высоту строки это не меняет: пилюля 18px внутри 48px (у счётчика
          рядом — 24px), ряд не переносится и не растёт — см. .rowLabels
          в MessageList.module.css. Требование к вёрстке то же, что и для
          строки-переписки: ROW_HEIGHT одно на все виды строк.
        */}
        <LabelPills keywords={labelKeys} dictionary={labels} className={styles.rowLabels} />
        <span className={styles.subject}>{message.subject || '(без темы)'}</span>
        <span className={styles.snippet}>{message.snippet}</span>
      </span>

      {/* Значки: срок возврата, «вернулось», категория, вложение */}
      <span className={styles.secondaryData}>
        {/* Срок в папке «Отложенные»: ради него туда и заходят */}
        {snoozeLabel && (
          <span className={styles.snoozeUntil} title={`Вернётся ${snoozeLabel}`}>
            <IconClock size={12} />
            {snoozeLabel}
          </span>
        )}
        {/* Письмо вернулось и его ещё не открывали. Значок времени рядом
            со строкой объясняет, почему старое письмо оказалось наверху, —
            без него человек решил бы, что список сломался. */}
        {message.returnedFromSnooze && !snoozeLabel && (
          <span className={styles.returnedBadge} title="Письмо вернулось из «Отложенных»">
            <IconClock size={14} />
          </span>
        )}
        {/*
          Ожидание ответа. Без этой пометки поднятое письмо — это
          СОБСТВЕННОЕ письмо человека, внезапно оказавшееся во «Входящих»
          непрочитанным: он не поймёт ни откуда оно, ни что с ним делать.
          Подпись словами, а не одним значком: «ответа нет» — это вывод,
          который сделал сервер, и читаться он должен без догадок.
        */}
        {message.awaitReply === 'overdue' && (
          <span className={styles.awaitBadge} title="Собеседник не ответил к сроку">
            <IconAwaitReply size={12} />
            ответа нет
          </span>
        )}
        {message.awaitReply === 'waiting' && (
          <span className={styles.returnedBadge} title="Ждём ответа на это письмо">
            <IconAwaitReply size={14} />
          </span>
        )}
        {category && (
          <span
            className={styles.categoryDot}
            style={{ backgroundColor: `var(${category.colorVar})` }}
            title={category.name}
          />
        )}
        {rowHasAttachments(message) && (
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
  onOpen,
  scrollKey,
  highlightId,
  footer,
  snoozeLabels,
  labels,
}: MessageListProps) {
  const compact = useUiStore((s) => s.compactList);
  const selectedIds = useUiStore((s) => s.selectedIds);
  // Запомненная прокрутка читается разово, при восстановлении, а не
  // подпиской: подписка перерисовывала бы список на каждое сохранение.
  const rememberListScroll = useUiStore((s) => s.rememberListScroll);
  const phone = usePhone();
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => flattenRows(messages), [messages]);
  const leavingSet = useMemo(() => new Set(leavingIds ?? []), [leavingIds]);

  /**
   * Запасной счётчик писем в цепочке — по загруженному списку.
   *
   * Нужен только там, где сервер сводку переписки не прислал: список без
   * группировки и папки, где она не применяется. Как только сводка есть,
   * счётчик берётся из неё (rowThreadCount): она знает про всю папку,
   * а этот — только про загруженные страницы.
   */
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

  /* --- Возврат в список на то же место --------------------------------
   *
   * Уход в письмо размонтирует страницу папки вместе со списком, поэтому
   * положение приходится и запоминать, и восстанавливать самим. Прокрутка
   * держится в ссылке и обновляется по событию: читать её у DOM в момент
   * размонтирования поздно — узла может уже не быть.
   */

  const scrollTopRef = useRef(0);
  /** Восстанавливаем ровно один раз на монтирование списка. */
  const restored = useRef(false);

  useEffect(() => {
    if (!scrollKey) return;
    return () => {
      rememberListScroll(scrollKey, scrollTopRef.current);
    };
  }, [scrollKey, rememberListScroll]);

  /**
   * Восстановление ждёт, пока в списке появятся строки: до первого ответа
   * сервера прокручивать нечего, и попытка встать на прежнее место просто
   * пропала бы. Ровно поэтому же оно в layout-эффекте — иначе человек
   * успел бы увидеть начало списка и прыжок.
   */
  useLayoutEffect(() => {
    if (!scrollKey || restored.current || rows.length === 0) return;
    const element = scrollRef.current;
    if (!element) return;
    restored.current = true;
    const top = restoreScrollTop({
      savedTop: useUiStore.getState().listScroll[scrollKey],
      highlightIndex: rowIndexOf(rows, highlightId),
      rows,
      metrics: { rowHeight, headerHeight: HEADER_HEIGHT },
      viewportHeight: element.offsetHeight,
    });
    if (top === null) return;
    scrollTopRef.current = top;
    /**
     * Прокручиваем сам узел, а не через `scrollToOffset` виртуализации:
     * тот ходит в `element.scrollTo`, а высоту списка к этому моменту
     * задаёт уже отрисованная подложка (`inner`), поэтому обычного
     * присваивания достаточно и оно ведёт себя одинаково везде.
     */
    element.scrollTop = top;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, rows.length]);

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
  const firstMessage = rows.find(
    (r): r is Extract<ListRow, { type: 'message' }> => r.type === 'message',
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
        // Прокрутку держим в ссылке, а не читаем при уходе: к моменту
        // размонтирования узла может уже не быть
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop;
        }}
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
                    visited={row.message.id === highlightId}
                    leaving={leavingSet.has(row.message.id)}
                    tabbable={row.message.id === tabbableId}
                    rowRef={row.message.id === focusedId ? focusedRowRef : undefined}
                    threadCount={rowThreadCount(
                      row.message,
                      threadCounts.get(row.message.threadId) ?? 1,
                    )}
                    snoozeLabel={snoozeLabels?.get(row.message.id)}
                    labels={labels ?? NO_LABELS}
                    /* Метки СТРОКИ, а не показанного письма: у переписки
                       это объединение по всему разговору, и приходит оно
                       готовым в сводке от сервера (см. rowLabelKeys). */
                    labelKeys={rowLabelKeys(row.message)}
                    onContextMenu={onContextMenu}
                    onSwipe={onSwipe}
                    onOpen={onOpen}
                  />
                )}
              </div>
            );
          })}
        </div>
        {/*
          Подвал списка — ВНУТРИ области прокрутки, следом за письмами.

          Снаружи он висел под списком всегда: человек ещё не долистал до
          конца, а «Показать ещё» уже перед глазами. Кнопка догрузки должна
          встречаться там, где список кончился, — иначе она не сообщает
          ничего о том, где ты находишься, и спорит с прокруткой.
        */}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
