/**
 * Виртуализированный список писем (@tanstack/react-virtual).
 * Повторяет строку .llc mail.ru: высота 48px (компактный режим — 40px/13px),
 * колонка точки непрочитанного 32px, аватар 32×32 с чекбоксом при наведении,
 * отправитель 22%, флажок 24px, тема+сниппет, значки, дата 44px.
 * Группировка по периодам: «Сегодня», «Вчера», «Неделя», «Июль 2026».
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MessageSummary } from '@mail-true/shared';
import { useUiStore } from '../app/store';
import { Checkbox } from '../components';
import { isReliable, messageCategory } from '../lib/categories';
import { cx } from '../lib/cx';
import { setDragMessages } from '../lib/dragMessages';
import { HOTKEY_SCOPE_ATTR, HOTKEY_SCOPE_LIST } from '../lib/hotkeys';
import { formatListDate, groupMessagesByPeriod } from '../lib/listDates';
import { rowSelectionStates, type RowSelectionState } from '../lib/selection';
import { IconAttach, IconFlag, IconShield } from './icons';
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

export interface MessageListProps {
  messages: readonly MessageSummary[];
  /** id письма, на котором стоит клавиатурный курсор. */
  focusedId?: string | null;
  onContextMenu?(message: MessageSummary, x: number, y: number): void;
  /**
   * Долистали до конца — пора просить следующую страницу.
   * Без этого всё, что дальше первой сотни писем, было недостижимо.
   */
  onEndReached?(): void;
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
  /** Единственная строка списка, попадающая в обход по Tab (roving tabindex). */
  tabbable: boolean;
  threadCount: number;
  onContextMenu?: MessageListProps['onContextMenu'];
  /** Ставится только на строку под курсором — по нему и переносится фокус. */
  rowRef?: ((node: HTMLAnchorElement | null) => void) | undefined;
}

function Row({
  message,
  selection,
  focused,
  tabbable,
  threadCount,
  onContextMenu,
  rowRef,
}: RowProps) {
  const toggleSelected = useUiStore((s) => s.toggleSelected);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const navigate = useNavigate();
  const unread = !message.flags.seen;
  const category = messageCategory(message.labels);
  const reliable = isReliable(message.labels);

  return (
    <a
      ref={rowRef}
      href={`/${message.folderId}/${encodeURIComponent(message.id)}`}
      className={cx(
        styles.row,
        unread && styles.unread,
        reliable && styles.reliable,
        selection.selected && styles.selected,
        selection.firstSelected && styles.firstSelected,
        selection.lastSelected && styles.lastSelected,
        focused && styles.focused,
      )}
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

      {/* Отправитель, 22% (+ счётчик писем в цепочке) */}
      <span className={styles.correspondent}>
        <span className={styles.correspondentName}>{senderName(message)}</span>
        {threadCount > 1 && <span className={styles.threadCount}>{threadCount}</span>}
      </span>

      {/* Флажок «важное», 24px */}
      <span className={styles.flagCell}>
        {message.flags.flagged && (
          <span className={styles.flagIcon} title="Важное">
            <IconFlag />
          </span>
        )}
      </span>

      {/* Тема + сниппет */}
      <span className={styles.title}>
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
}

export function MessageList({
  messages,
  focusedId,
  onContextMenu,
  onEndReached,
}: MessageListProps) {
  const compact = useUiStore((s) => s.compactList);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => flattenRows(messages), [messages]);

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

  const rowHeight = compact ? 40 : 48;
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

  return (
    <div
      ref={scrollRef}
      className={cx(styles.scroll, compact && styles.compact)}
      // Внутри списка стрелки и Enter — его собственное поведение,
      // поэтому глобальные горячие клавиши здесь не отключаются
      {...{ [HOTKEY_SCOPE_ATTR]: HOTKEY_SCOPE_LIST }}
    >
      <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
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
                  tabbable={row.message.id === tabbableId}
                  rowRef={row.message.id === focusedId ? focusedRowRef : undefined}
                  threadCount={threadCounts.get(row.message.threadId) ?? 1}
                  onContextMenu={onContextMenu}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
