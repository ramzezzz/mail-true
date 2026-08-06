/**
 * Нижняя навигация телефона — как в мобильном mail.ru.
 *
 * Зачем она вообще. До этого единственной дорогой к папкам был выдвижной
 * ящик: чтобы попасть из «Входящих» в «Отправленные», надо было нажать
 * гамбургер в самом верху экрана (там, куда большой палец не дотягивается)
 * и только потом выбрать папку. Нижняя полоса убирает и то и другое: до
 * четырёх главных папок — одно касание, до любой остальной — два («Ещё»
 * открывает тот же ящик).
 *
 * Полоса живёт только на телефоне (≤600px). На планшете и рабочем столе
 * колонка папок и так на виду или в одном касании гамбургера.
 */

import { NavLink } from 'react-router-dom';
import type { Folder, FolderRole } from '@mail-true/shared';
import { useFolders } from '../api/queries';
import { cx } from '../lib/cx';
import { folderTitle } from '../lib/folderNames';
import { IconFolderRole, IconMore } from '../mail/icons';
import styles from './BottomNav.module.css';

/**
 * Какие папки попадают в полосу и в каком порядке.
 *
 * Ровно четыре: пятое место занимает «Ещё». На 360 точках это по 72px
 * на цель — с запасом к обязательным 44.
 */
const PINNED: readonly FolderRole[] = ['inbox', 'sent', 'drafts', 'trash'];

/** Короткая подпись: полное название папки под значок не влезает. */
const SHORT: Partial<Record<FolderRole, string>> = {
  inbox: 'Входящие',
  sent: 'Отправл.',
  drafts: 'Черновики',
  trash: 'Корзина',
  archive: 'Архив',
  spam: 'Спам',
};

export interface BottomNavProps {
  /** Открыт ли ящик с папками — кнопка «Ещё» показывает это состояние. */
  navOpen: boolean;
  onToggleNav(): void;
  /** id ящика с папками для aria-controls. */
  drawerId: string;
}

/** Папки для полосы: только те из PINNED, что вправду есть у ящика. */
export function pinnedFolders(folders: readonly Folder[] | undefined): Folder[] {
  const found: Folder[] = [];
  for (const role of PINNED) {
    const folder = folders?.find((f) => f.role === role);
    if (folder) found.push(folder);
  }
  return found;
}

export function BottomNav({ navOpen, onToggleNav, drawerId }: BottomNavProps) {
  const { data: folders } = useFolders();
  const pinned = pinnedFolders(folders);

  return (
    <nav className={styles.bar} aria-label="Основные папки">
      {pinned.map((folder) => (
        <NavLink
          key={folder.id}
          to={`/${folder.id}/`}
          className={({ isActive }) => cx(styles.item, isActive && styles.active)}
        >
          <span className={styles.icon}>
            <IconFolderRole role={folder.role} size={24} />
            {/* Счётчик непрочитанных — только у входящих: в остальных
                папках он ничего не значит и только шумит */}
            {folder.role === 'inbox' && folder.unreadCount > 0 && (
              <span className={styles.badge} aria-hidden="true">
                {folder.unreadCount > 99 ? '99+' : folder.unreadCount}
              </span>
            )}
          </span>
          <span className={styles.label}>{SHORT[folder.role] ?? folderTitle(folder)}</span>
          {folder.role === 'inbox' && folder.unreadCount > 0 && (
            <span className={styles.srOnly}>непрочитанных: {folder.unreadCount}</span>
          )}
        </NavLink>
      ))}

      {/* «Ещё» — тот же выдвижной ящик, что и у гамбургера в шапке.
          Второе касание, которым достаётся любая непришпиленная папка. */}
      <button
        type="button"
        className={cx(styles.item, navOpen && styles.active)}
        aria-expanded={navOpen}
        aria-controls={drawerId}
        onClick={onToggleNav}
      >
        <span className={styles.icon}>
          <IconMore size={24} />
        </span>
        <span className={styles.label}>Ещё</span>
      </button>
    </nav>
  );
}
