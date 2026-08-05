/**
 * Отображаемые названия папок.
 *
 * Сервер отдаёт IMAP-имя как есть: «INBOX», «Sent», «Drafts». Показывать это
 * пользователю нельзя — в интерфейсе почты папки называются по-русски.
 * Перевод делаем по роли, а не по имени: роль сервер определяет по SPECIAL-USE,
 * поэтому она не зависит от того, как папка названа на конкретном сервере.
 *
 * Пользовательские папки роли не имеют и сохраняют собственное имя.
 */

import type { Folder, FolderRole } from '@mail-true/shared';

const BY_ROLE: Partial<Record<FolderRole, string>> = {
  inbox: 'Входящие',
  sent: 'Отправленные',
  drafts: 'Черновики',
  spam: 'Спам',
  trash: 'Корзина',
  archive: 'Архив',
};

/** Название папки для показа в левом меню и в списках выбора. */
export function folderTitle(folder: Pick<Folder, 'role' | 'name'>): string {
  return BY_ROLE[folder.role] ?? folder.name;
}
