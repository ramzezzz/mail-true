/**
 * Права на действия с папкой и счётчик писем — раздел настроек «Папки»
 * (см. research/mailru/12-folders.png и таблицу в docs/features-mailru.md).
 *
 * Права зависят от роли папки, а не от её имени: роль сервер определяет по
 * SPECIAL-USE, поэтому логика не ломается на серверах, где системные папки
 * названы иначе.
 *
 *   | Папка                   | Очистить | Переименовать | Удалить |
 *   | Входящие                | да       | нет           | нет     |
 *   | Вложенные автокатегории | да       | нет           | нет     |
 *   | Пользовательская        | да       | да            | ДА      |
 *   | Отправленные, Черновики | да       | нет           | нет     |
 *   | Спам                    | да       | нет           | нет     |
 *   | Корзина                 | нет      | нет           | нет     |
 *
 * Переименование разрешено ровно там, где его разрешает сервер:
 * `PATCH /api/folders/:id` отвечает «Системную папку переименовать нельзя»
 * на любую папку с `system: true` (apps/api/src/settings/folders.ts).
 * Раньше интерфейс предлагал переименовать «Входящие», «Отправленные»,
 * «Черновики» и «Архив» — и каждая такая попытка заканчивалась ошибкой.
 */

import type { Folder } from '@mail-true/shared';

export interface FolderRights {
  /** «Очистить» — удалить все письма, саму папку оставить. */
  canClear: boolean;
  canRename: boolean;
  canDelete: boolean;
}

/** Что нужно знать о папке, чтобы посчитать права. */
export type FolderLike = Pick<Folder, 'role' | 'system'>;

export function folderRights(folder: FolderLike): FolderRights {
  switch (folder.role) {
    case 'trash':
      // Корзина и так свалка удалённого — очищать её отдельной кнопкой
      // mail.ru не даёт, поэтому не даём и мы.
      return { canClear: false, canRename: false, canDelete: false };
    case 'spam':
      // Спам чистится, но переименовать или удалить его нельзя:
      // на него завязано обучение антиспама.
      return { canClear: true, canRename: false, canDelete: false };
    case 'inbox':
    case 'sent':
    case 'drafts':
    case 'archive':
      // Имена системных папок — часть соглашения с почтовыми клиентами
      // (SPECIAL-USE), сервер их переименовывать не даёт.
      return { canClear: true, canRename: false, canDelete: false };
    case 'custom':
      // Автокатегории («Рассылки», «Чеки») приходят с role=custom, но помечены
      // системными: это представления внутри «Входящих». Их сервер тоже не
      // даёт ни переименовать, ни удалить — решает флаг `system`.
      return { canClear: true, canRename: !folder.system, canDelete: !folder.system };
  }
}

/** Точный подсчёт больших папок дорог — свыше этого показываем «999+». */
export const COUNT_CAP = 999;

export function formatCount(value: number): string {
  return value > COUNT_CAP ? `${COUNT_CAP}+` : String(value);
}

/**
 * Счётчик писем в таблице настроек: у папки с непрочитанными — «10/999+»
 * (непрочитанные через дробь от общего числа), у остальных — только общее.
 */
export function formatFolderCount(folder: Pick<Folder, 'unreadCount' | 'totalCount'>): string {
  const total = formatCount(folder.totalCount);
  if (folder.unreadCount <= 0) return total;
  return `${formatCount(folder.unreadCount)}/${total}`;
}
