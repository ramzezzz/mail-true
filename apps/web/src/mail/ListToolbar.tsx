/**
 * Панель над списком писем. Два состояния:
 *   обычное — «Выделить все», «Отметить все прочитанными», справа «Фильтр»;
 *   режим выделения — × · счётчик · Выделить все · Удалить · В архив ·
 *   В папку · Отписаться · ⋯ (меню с горячими клавишами).
 */

import type { Folder, MessageFilter } from '@mail-true/shared';
import { useUiStore } from '../app/store';
import { folderTitle } from '../lib/folderNames';
import { Button, Dropdown, IconButton, MenuItem, MenuSeparator } from '../components';
import {
  IconArchive,
  IconCheckAll,
  IconClose,
  IconFilter,
  IconFlag,
  IconFolder,
  IconForward,
  IconMailRead,
  IconMailUnread,
  IconMore,
  IconPrint,
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
  filter: MessageFilter;
  onFilterChange(filter: MessageFilter): void;
  /** Папки для меню «В папку» (без текущей). */
  folders: readonly Folder[];
  onSelectAll(): void;
  onClearSelection(): void;
  onMarkAllRead(): void;
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
}

export function ListToolbar(props: ListToolbarProps) {
  const compactList = useUiStore((s) => s.compactList);
  const toggleCompactList = useUiStore((s) => s.toggleCompactList);

  if (props.selectedCount === 0) {
    return (
      <div className={styles.toolbar}>
        <Button mode="tertiary" before={<IconCheckAll />} onClick={props.onSelectAll}>
          {props.selectAllLabel ?? 'Выделить все'}
        </Button>
        <Button mode="tertiary" before={<IconMailRead />} onClick={props.onMarkAllRead}>
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
