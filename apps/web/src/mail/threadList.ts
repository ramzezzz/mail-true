/**
 * Список, сгруппированный по перепискам: что показывает строка и над чем
 * работают действия.
 *
 * Всё здесь — чистые функции без React. Причина простая: именно тут живёт
 * дефект, ради которого возможность и делалась осторожно — «удалил цепочку,
 * а два письма остались». Проверять такое надо отдельно от разметки.
 *
 * Сводку переписки (`message.thread`) собирает СЕРВЕР. Клиент её не считает
 * и не достраивает: посчитать по загруженным строкам можно только то, что
 * загружено, а в переписке из шести писем на первой странице может лежать
 * два. Раньше счётчик в строке считался именно так — по загруженному, — и
 * потому показывал число, которое ни на что не опиралось.
 */

import type { MailAddress, MessageSummary } from '@mail-true/shared';

/**
 * Письма, которых касается действие над строкой.
 *
 * Строка-переписка представляет несколько писем, и «удалить» относится ко
 * всем. Без группировки (и в папках, где её нет) строка — это одно письмо,
 * и поведение остаётся прежним.
 */
export function threadMessageIds(message: MessageSummary): string[] {
  const ids = message.thread?.messageIds;
  return ids && ids.length > 0 ? ids : [message.id];
}

/**
 * Разворачивает идентификаторы строк в идентификаторы писем.
 *
 * Выделение, курсор и контекстное меню оперируют СТРОКАМИ — то есть
 * последними письмами переписок. Любое действие обязано пройти через эту
 * функцию, иначе оно затронет ровно одно письмо из шести, а список
 * покажет, что затронуло всю переписку.
 *
 * Порядок сохраняется, повторы убираются: одно и то же письмо не должно
 * уехать в корзину дважды.
 */
export function expandThreadIds(
  rowIds: readonly string[],
  messages: readonly MessageSummary[],
): string[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rowId of rowIds) {
    const message = byId.get(rowId);
    // Строки нет в списке — значит развернуть нечего, и идентификатор
    // уходит как есть. Терять его нельзя: он мог прийти из выделения,
    // сделанного до подгрузки следующей страницы.
    for (const id of message ? threadMessageIds(message) : [rowId]) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Предел числа писем в одном запросе к API (`ids` в /messages/flags и
 * /messages/move ограничены пятьюстами).
 *
 * До группировки упереться в него было почти невозможно: строка — письмо,
 * а на экране их сотня. С группировкой сотня строк — это легко больше
 * пятисот писем, и «выделить все, пометить прочитанными» упиралось бы
 * в отказ 400 ровно там, где действие нужнее всего.
 */
export const MAX_IDS_PER_REQUEST = 500;

/** Режет список писем на запросы допустимой длины. */
export function chunkIds(
  ids: readonly string[],
  size = MAX_IDS_PER_REQUEST,
): string[][] {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push([...ids.slice(i, i + size)]);
  return chunks;
}

/**
 * Переписка не прочитана, если не прочитано хоть одно её письмо.
 *
 * Ровно так это работает у всех, у кого группировка есть: строка гаснет
 * только когда прочитан весь разговор. Обратное («прочитано последнее —
 * значит прочитано всё») означало бы, что непрочитанное письмо исчезает
 * из виду от того, что пришёл ответ на него.
 */
export function isRowUnread(message: MessageSummary): boolean {
  const thread = message.thread;
  return thread ? thread.unreadCount > 0 : !message.flags.seen;
}

/** Флажок в строке: помечена вся переписка, если помечено хоть одно письмо. */
export function isRowFlagged(message: MessageSummary): boolean {
  return message.thread ? message.thread.flagged : message.flags.flagged;
}

/** Скрепка в строке: вложение есть у переписки, если оно есть хоть у письма. */
export function rowHasAttachments(message: MessageSummary): boolean {
  return message.thread ? message.thread.hasAttachments : message.hasAttachments;
}

/** Имя человека для колонки отправителя: имя из заголовка, иначе адрес. */
export function displayName(address: MailAddress): string {
  // Именно проверка на непустоту, а не `??`: у писем без отображаемого
  // имени в заголовке приходит пустая строка.
  const name = address.name?.trim();
  return name ? name : address.address;
}

/**
 * Что стоит в колонке отправителя.
 *
 * У переписки это её участники по порядку появления — «Иван, Пётр», как
 * в mail.ru. У одного письма (и у переписки одного человека с собой) —
 * прежнее имя отправителя, слово в слово.
 *
 * Колонка узкая и обрезается многоточием средствами CSS, поэтому список
 * участников здесь не режется по числу: обрезать «Иван, Пётр, Анна» до
 * «Иван, Пётр» значило бы решить за вёрстку, сколько влезет.
 */
export function correspondentLabel(message: MessageSummary): string {
  const participants = message.thread?.participants ?? [];
  if (participants.length <= 1) return displayName(message.from);
  return participants.map(displayName).join(', ');
}

/**
 * Сколько писем показывает счётчик строки.
 *
 * `fallback` — счёт по загруженным письмам с тем же `threadId`. Он остаётся
 * для списка БЕЗ группировки: там пилюля со счётчиком была и до этой
 * работы, и убирать её незачем. Как только сервер прислал сводку
 * переписки, считается по ней — она знает про всю папку, а не про
 * загруженную страницу.
 */
export function rowThreadCount(message: MessageSummary, fallback: number): number {
  return message.thread ? message.thread.count : fallback;
}
