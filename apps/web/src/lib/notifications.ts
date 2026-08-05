/**
 * Уведомления о новой почте: что писать в всплывающем окне браузера и что
 * дописывать в заголовок вкладки.
 *
 * Обе настройки — «Уведомления в браузере» и «Счётчик во вкладке» — до сих
 * пор никто не читал: их сохраняли, и на этом всё заканчивалось. Здесь —
 * чистые части, отдельно от работы с DOM и Notification API, чтобы их можно
 * было проверить без браузера.
 */

import type { MailAddress } from '@mail-true/shared';

/** Заголовок вкладки со счётчиком непрочитанных. */
export function tabTitle(baseTitle: string, unread: number, enabled: boolean): string {
  if (!enabled || unread <= 0) return baseTitle;
  // Число в скобках перед названием — так его видно в узкой вкладке,
  // где от заголовка остаётся несколько первых символов.
  return `(${unread}) ${baseTitle}`;
}

/**
 * Заголовок без счётчика.
 *
 * Название вкладки читается из неё же самой и каждый раз очищается от
 * прежнего числа: иначе счётчик наращивал бы скобки друг на друга
 * («(3) (2) Почта»), а запоминать исходный заголовок при загрузке модуля
 * значило бы зависеть от того, кто успел его выставить раньше.
 */
export function stripTabCounter(title: string): string {
  return title.replace(/^\(\d+\)\s*/u, '');
}

/** Событие сервера о новом письме — в текст всплывающего уведомления. */
export function newMailNotification(event: {
  from: MailAddress | null;
  subject: string;
}): { title: string; body: string } {
  const sender = event.from?.name?.trim() || event.from?.address || 'Неизвестный отправитель';
  const subject = event.subject.trim();
  return { title: sender, body: subject === '' ? '(без темы)' : subject };
}
