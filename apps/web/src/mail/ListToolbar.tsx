/**
 * Панель над списком писем. Два состояния:
 *   обычное — «Выделить все», «Отметить все прочитанными», справа «Фильтр»;
 *   режим выделения — × · счётчик · Выделить все · Удалить · В архив ·
 *   В папку · Отписаться · ⋯ (меню с горячими клавишами).
 */

import type { ReactNode } from 'react';
import type { Folder, MessageFilter } from '@mail-true/shared';
import { useUiStore } from '../app/store';
import { folderTitle } from '../lib/folderNames';
import { Button, Dropdown, IconButton, MenuItem, MenuSeparator } from '../components';
import { SnoozeMenu } from './SnoozeMenu';
import type { SnoozePreset } from './snoozeApi';
import {
  IconArchive,
  IconCheckAll,
  IconClock,
  IconClose,
  IconFilter,
  IconFlag,
  IconFolder,
  IconForward,
  IconMailRead,
  IconMailUnread,
  IconMore,
  IconPrint,
  IconRefresh,
  IconSpam,
  IconTrash,
  IconUnsubscribe,
} from './icons';
import styles from './ListToolbar.module.css';

const FILTER_TITLES: Record<MessageFilter, string> = {
  all: 'Все письма',
  unread: 'Непрочитанные',
  flagged: 'С флагом',
  'with-attachments': 'С вложениями',
};

export interface ListToolbarProps {
  selectedCount: number;
  /**
   * Подпись кнопки выделения. Выделяются только загруженные письма, и когда
   * загружено не всё, кнопка честно говорит сколько: обещать «все» и
   * выделять сотню — обман (см. lib/paging.ts).
   */
  selectAllLabel?: string;
  /**
   * В папке нет ни одного письма. Тогда «Выделить все» и «Отметить все
   * прочитанными» выключены: выделять и отмечать нечего, а живая кнопка
   * обещает действие, которого не будет.
   */
  emptyFolder?: boolean;
  filter: MessageFilter;
  onFilterChange(filter: MessageFilter): void;
  /** Папки для меню «В папку» (без текущей). */
  folders: readonly Folder[];
  onSelectAll(): void;
  onClearSelection(): void;
  onMarkAllRead(): void;
  /**
   * Обновить список. То же самое делает жест «потянуть вниз» на телефоне —
   * и именно поэтому кнопка обязана быть: жест не виден, его не найти
   * ощупью, и ни мыши, ни клавиатуре он не доступен вовсе.
   */
  onRefresh?(): void;
  /** Обновление уже идёт — кнопка не должна плодить запросы. */
  refreshing?: boolean;
  onDelete(): void;
  onArchive(): void;
  onMoveTo(folderId: string): void;
  onUnsubscribe(): void;
  onMarkUnread(): void;
  onToggleFlag(): void;
  onSpam(): void;
  onPrint(): void;
  onCreateFilter(): void;
  onForwardAsAttachment(): void;
  /**
   * Отложить выделенные письма до срока.
   *
   * Проп необязательный, и кнопки без него нет вовсе: пока сервер не
   * сказал, что возможность у него есть, показывать её нельзя (общее
   * правило продукта — кнопка появляется вместе с поведением).
   */
  onSnooze?: ((choice: { preset: SnoozePreset; until?: string }) => void) | undefined;
  /** Возврат по расписанию работает; иначе меню честно предупреждает. */
  snoozeScheduledReturn?: boolean | undefined;
  /**
   * Вернуть выделенные письма прямо сейчас. Есть только в папке
   * «Отложенные»: в остальных возвращать нечего.
   */
  onReturnNow?: (() => void) | undefined;
  /**
   * Меню «Метки» для выделенных писем — готовой разметкой.
   *
   * Именно разметкой, а не списком меток с обработчиком: чтобы показать
   * галочку «стоит / стоит на части выделения», надо знать метки КАЖДОЙ
   * выделенной строки, а строка бывает целой перепиской и её метки —
   * объединением по разговору. Всё это знает страница папки; панель
   * осталась бы посредником, который передаёт данные, не пользуясь ими.
   */
  labelMenu?: ReactNode;
}

export function ListToolbar(props: ListToolbarProps) {
  const compactList = useUiStore((s) => s.compactList);
  const toggleCompactList = useUiStore((s) => s.toggleCompactList);

  if (props.selectedCount === 0) {
    return (
      <div className={styles.toolbar}>
        {props.onRefresh && (
          <Button
            mode="tertiary"
            before={<IconRefresh />}
            onClick={props.onRefresh}
            disabled={props.refreshing}
          >
            Обновить
          </Button>
        )}
        <Button
          mode="tertiary"
          before={<IconCheckAll />}
          onClick={props.onSelectAll}
          disabled={props.emptyFolder}
        >
          {props.selectAllLabel ?? 'Выделить все'}
        </Button>
        <Button
          mode="tertiary"
          before={<IconMailRead />}
          onClick={props.onMarkAllRead}
          disabled={props.emptyFolder}
        >
          Отметить все прочитанными
        </Button>

        <div className={styles.spacer} />

        <Dropdown
          align="right"
          menuClassName={styles.filterMenu}
          trigger={({ toggle }) => (
            <Button mode="tertiary" before={<IconFilter />} onClick={toggle}>
              Фильтр
            </Button>
          )}
        >
          {(Object.keys(FILTER_TITLES) as MessageFilter[]).map((f) => (
            <MenuItem
              key={f}
              onClick={() => props.onFilterChange(f)}
              hint={props.filter === f ? '✓' : undefined}
            >
              {FILTER_TITLES[f]}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={toggleCompactList} hint={compactList ? '✓' : undefined}>
            Компактный список
          </MenuItem>
        </Dropdown>
      </div>
    );
  }

  return (
    <div className={styles.toolbar}>
      <IconButton label="Снять выделение" onClick={props.onClearSelection}>
        <IconClose size={20} />
      </IconButton>
      <span className={styles.counter} aria-live="polite">
        <IconCheckAll />
        {props.selectedCount}
      </span>

      <Button mode="tertiary" onClick={props.onSelectAll}>
        {props.selectAllLabel ?? 'Выделить все'}
      </Button>
      <Button mode="tertiary" before={<IconTrash />} onClick={props.onDelete}>
        Удалить
      </Button>
      <Button mode="tertiary" before={<IconArchive />} onClick={props.onArchive}>
        В архив
      </Button>

      {/* «Отложить» стоит рядом с «В архив» намеренно: это соседние по
          смыслу действия — «убрать с глаз сейчас» и «убрать с глаз до
          срока», — и человек ищет их в одном месте. */}
      {props.onSnooze && (
        <SnoozeMenu
          onSnooze={props.onSnooze}
          scheduledReturn={props.snoozeScheduledReturn ?? true}
        />
      )}

      {/* А в самой папке «Отложенные» на том же месте — обратное действие. */}
      {props.onReturnNow && (
        <Button mode="tertiary" before={<IconClock />} onClick={props.onReturnNow}>
          Вернуть сейчас
        </Button>
      )}

      <Dropdown
        trigger={({ toggle }) => (
          <Button mode="tertiary" before={<IconFolder />} onClick={toggle}>
            В папку
          </Button>
        )}
      >
        {/* Название по роли папки, а не IMAP-имя: только здесь про
            folderTitle и забыли — в меню светились INBOX, Sent, Drafts */}
        {props.folders.map((f) => (
          <MenuItem key={f.id} onClick={() => props.onMoveTo(f.id)}>
            {f.depth > 0 ? `  ${folderTitle(f)}` : folderTitle(f)}
          </MenuItem>
        ))}
      </Dropdown>

      <Button mode="tertiary" before={<IconUnsubscribe />} onClick={props.onUnsubscribe}>
        Отписаться
      </Button>

      <Dropdown
        align="right"
        menuClassName={styles.moreMenu}
        trigger={({ toggle }) => (
          <IconButton label="Ещё действия" onClick={toggle}>
            <IconMore size={20} />
          </IconButton>
        )}
      >
        <MenuItem before={<IconMailUnread />} hint="U" onClick={props.onMarkUnread}>
          Пометить непрочитанным
        </MenuItem>
        <MenuItem before={<IconFlag />} hint="I" onClick={props.onToggleFlag}>
          Пометить флажком
        </MenuItem>
        <MenuItem before={<IconSpam />} hint="Shift+J" onClick={props.onSpam}>
          Спам
        </MenuItem>
        {/*
          Метки для всего выделения. Приходят готовой разметкой, а не
          списком меток: панель ничего не знает ни о выделенных письмах,
          ни о том, что строка бывает целой перепиской, — это знает
          страница папки, она и собирает меню.
        */}
        {props.labelMenu && (
          <>
            <MenuSeparator />
            {props.labelMenu}
            <MenuSeparator />
          </>
        )}
        <MenuItem before={<IconPrint />} hint="Ctrl+P" onClick={props.onPrint}>
          Распечатать
        </MenuItem>
        <MenuItem before={<IconFilter />} hint="Shift+L" onClick={props.onCreateFilter}>
          Создать фильтр
        </MenuItem>
        <MenuItem before={<IconForward />} onClick={props.onForwardAsAttachment}>
          Переслать как вложение
        </MenuItem>
      </Dropdown>
    </div>
  );
}
