/**
 * Перетаскивание писем в папки.
 *
 * Данные кладём в собственный тип `application/x-mail-true-ids`, а не в
 * `text/plain`: так папка не примет случайный текст, перетащенный из другого
 * окна, и не начнёт двигать письма от чужого drop. Дублируем в `text/plain`
 * только затем, чтобы браузер вообще разрешил перетаскивание — без хотя бы
 * одного стандартного формата Firefox не начинает drag.
 */

export const MESSAGE_IDS_MIME = 'application/x-mail-true-ids';

export function setDragMessages(transfer: DataTransfer, ids: readonly string[]): void {
  transfer.setData(MESSAGE_IDS_MIME, JSON.stringify(ids));
  transfer.setData('text/plain', ids.join('\n'));
  transfer.effectAllowed = 'move';
}

/** Идентификаторы писем из drop-события; пустой список — это не наш перенос. */
export function getDragMessages(transfer: DataTransfer): string[] {
  const raw = transfer.getData(MESSAGE_IDS_MIME);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Наш ли это перенос — проверяется в dragover, где читать данные ещё нельзя
 * (браузер отдаёт только список типов).
 */
export function isMessageDrag(transfer: DataTransfer): boolean {
  return [...transfer.types].includes(MESSAGE_IDS_MIME);
}
