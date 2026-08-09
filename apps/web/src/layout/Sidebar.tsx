/**
 * Левая колонка 232px: кнопка «Написать письмо» (164×36 + стрелка меню)
 * и список папок (пункты 200×36, шаг 37px — метрики привычный почтовый интерфейс).
 *
 * Папки принимают перетаскиваемые письма: строка списка тащится сюда, и
 * письмо переезжает. Подсветка цели включается только для нашего переноса
 * (см. lib/dragMessages.ts), чтобы папки не мигали от постороннего drag.
 */

import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useFolders, useMoveMessages } from '../api/queries';
import { useUiStore } from '../app/store';
import { Spinner } from '../components';
import { cx } from '../lib/cx';
import { getDragMessages, isMessageDrag } from '../lib/dragMessages';
import { chunkIds } from '../mail/threadList';
import { IconCompose, IconFolderRole } from '../mail/icons';
import { SavedSearches } from '../search/SavedSearches';
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
    /*
     * Порциями — как все остальные действия над письмами.
     *
     * Сервер отвергает запрос, в котором больше пятисот писем, целиком.
     * Перетаскивание отправляло список одним куском: выделив тысячу писем
     * и перетащив их в папку, человек не перемещал НИ ОДНОГО и видел
     * только общую плашку отказа. Раскрытие переписок делает список ещё
     * длиннее — под сотней строк легко лежит несколько сотен писем.
     */
    for (const chunk of chunkIds(ids)) {
      moveMessages.mutate({ ids: chunk, targetFolderId: folderId });
    }
    clearSelection();
  };

  return (
    <aside className={styles.sidebar}>
      {/*
        Стрелки с меню «Открытку · Опрос · Видеовстречу» здесь больше нет.
        Ни одного из этих трёх продуктов у нас нет и не будет — заказчик
        сказал об этом прямо, ровно как и о соседних сервисах, из-за которых
        отсюда уже убирали чужие кнопки (см. tests/noCloudCalendar.test.tsx).
        Пункты не делали ничего: нажатие просто закрывало меню. Кнопка,
        которая молча ничего не делает, хуже её отсутствия — человек не
        понимает, сломалось ли. Вместе с пунктами ушла и сама стрелка:
        пустое меню было бы ровно такой же пустышкой.
      */}
      <div className={styles.composeRow}>
        <button type="button" className={cx(styles.composeButton)} onClick={() => openCompose()}>
          <span className={styles.composeInner}>
            <IconCompose />
            <span>Написать письмо</span>
          </span>
        </button>
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
            {/* 20×20 — размер значков привычных почтовых интерфейсах в списке папок (класс
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
          <svg
            width="20"
            height="20"
            viewBox="0 0 16 16"
            aria-hidden="true"
            className={styles.folderIcon}
          >
            <path
              d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3Z"
              fill="currentColor"
            />
          </svg>
          <span className={styles.itemName}>Новая папка</span>
        </button>

        {/*
          Сохранённые запросы стоят СРАЗУ ПОД папками — там их и ищут, — но
          папками не притворяются: свой заголовок группы, значок лупы и
          строка запроса под именем. Перетащить на них письмо нельзя, и
          обработчиков переноса здесь нет вовсе: «папка», в которую письмо
          не переезжает, обманывает ровно один раз и надолго.
          Группы нет, пока сервер не сказал, что возможность есть.
        */}
        <SavedSearches />
      </nav>
    </aside>
  );
}
