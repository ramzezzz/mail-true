/**
 * Левая колонка 232px: кнопка «Написать письмо» (164×36 + стрелка меню)
 * и список папок (пункты 200×36, шаг 37px — метрики mail.ru).
 *
 * Папки принимают перетаскиваемые письма: строка списка тащится сюда, и
 * письмо переезжает. Подсветка цели включается только для нашего переноса
 * (см. lib/dragMessages.ts), чтобы папки не мигали от постороннего drag.
 */

import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useFolders, useMoveMessages } from '../api/queries';
import { useUiStore } from '../app/store';
import { Dropdown, IconButton, MenuItem, Spinner } from '../components';
import { cx } from '../lib/cx';
import { getDragMessages, isMessageDrag } from '../lib/dragMessages';
import { IconCompose, IconFolderRole } from '../mail/icons';
import styles from './Sidebar.module.css';
import { folderTitle } from '../lib/folderNames';

export function Sidebar() {
  const { data: folders, isPending } = useFolders();
  const openCompose = useUiStore((s) => s.openCompose);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const moveMessages = useMoveMessages();
  const navigate = useNavigate();

  /** id папки, над которой сейчас держат письмо. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const drop = (folderId: string, transfer: DataTransfer) => {
    setDropTarget(null);
    const ids = getDragMessages(transfer);
    if (ids.length === 0) return;
    moveMessages.mutate({ ids, targetFolderId: folderId });
    clearSelection();
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.composeRow}>
        <button
          type="button"
          className={cx(styles.composeButton)}
          onClick={() => openCompose()}
        >
          <span className={styles.composeInner}>
            <IconCompose />
            <span>Написать письмо</span>
          </span>
        </button>
        <Dropdown
          align="right"
          className={cx(styles.composeDropdownHost)}
          trigger={({ toggle }) => (
            <IconButton
              label="Ещё варианты письма"
              onClick={toggle}
              className={styles.composeArrow}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4.15 6.15a.9.9 0 0 1 1.27 0L8 8.72l2.58-2.57a.9.9 0 0 1 1.27 1.27l-3.21 3.22a.9.9 0 0 1-1.28 0L4.15 7.42a.9.9 0 0 1 0-1.27Z"
                  fill="currentColor"
                />
              </svg>
            </IconButton>
          )}
        >
          <MenuItem>Открытку</MenuItem>
          <MenuItem>Опрос</MenuItem>
          <MenuItem>Видеовстречу</MenuItem>
        </Dropdown>
      </div>

      <nav className={styles.nav} aria-label="Папки">
        {isPending && (
          <div className={styles.loading}>
            <Spinner size={20} />
          </div>
        )}
        {folders?.map((f) => (
          <NavLink
            key={f.id}
            to={`/${f.id}/`}
            className={({ isActive }) =>
              cx(
                styles.item,
                f.depth > 0 && styles.nested,
                isActive && styles.active,
                dropTarget === f.id && styles.dropTarget,
              )
            }
            onDragOver={(e) => {
              if (!isMessageDrag(e.dataTransfer)) return;
              // preventDefault обязателен: без него браузер запрещает drop
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropTarget(f.id);
            }}
            onDragLeave={() => setDropTarget((current) => (current === f.id ? null : current))}
            onDrop={(e) => {
              if (!isMessageDrag(e.dataTransfer)) return;
              e.preventDefault();
              drop(f.id, e.dataTransfer);
            }}
          >
            {/* 20×20 — размер значков mail.ru в списке папок (класс
                ico_size_s: svg width=20 height=20 при viewBox 0 0 16 16).
                Были 16×16 — заметно мельче эталона. */}
            <span className={styles.folderIcon}>
              <IconFolderRole role={f.role} size={20} />
            </span>
            <span className={styles.itemName}>{folderTitle(f)}</span>
            {f.unreadCount > 0 && <span className={styles.counter}>{f.unreadCount}</span>}
          </NavLink>
        ))}
        <button
          type="button"
          className={cx(styles.item, styles.newFolder)}
          onClick={() => void navigate('/settings/folders')}
        >
          <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" className={styles.folderIcon}>
            <path
              d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3Z"
              fill="currentColor"
            />
          </svg>
          <span className={styles.itemName}>Новая папка</span>
        </button>
      </nav>
    </aside>
  );
}
