/**
 * Общие настройки ящика там, где они должны работать.
 *
 * Страница настроек их сохраняла, но больше их никто не читал: цитата в
 * ответе вставлялась всегда, после удаления письма всегда открывался список,
 * уведомления не показывались никогда, а подпись в окно написания приходила
 * не отсюда. Здесь собрано всё, что нужно остальным экранам: значения по
 * умолчанию (пока настройки грузятся, интерфейс должен вести себя как-то —
 * и вести себя одинаково), приведение дат к виду поля и выбор подписи.
 */

import { useGeneralSettings } from '../api/settingsQueries';
import { DEFAULT_UNDO_SEND_SECONDS, type GeneralSettings, type Signature } from '../api/settingsTypes';

/**
 * Чем пользуемся, пока настройки не загрузились или не загрузились вовсе.
 * Совпадает с тем, что отдаёт сервер новому ящику (см. `defaultMailSettings`
 * в apps/api): иначе поведение до и после загрузки различалось бы.
 */
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  senderName: '',
  signatures: [],
  defaultSignatureId: null,
  autoReply: { enabled: false, text: '', from: null, to: null },
  notifications: { browser: false, tabCounter: true },
  quoteOriginalOnReply: true,
  afterDelete: 'list',
  autoCollectContacts: true,
  // Выключено, как и на сервере: включение означает, что сервер пойдёт
  // в интернет за картинками, и это решение человека.
  showSenderLogos: false,
  // Включено, как и на сервере: см. DEFAULT_UNDO_SEND_SECONDS
  undoSendSeconds: DEFAULT_UNDO_SEND_SECONDS,
  /*
   * Включено, как и на сервере. Значение по умолчанию здесь — это ещё и
   * то, как выглядит список ПОКА настройки грузятся. Поставить сюда
   * `false` значило бы показывать при каждом открытии почты сначала
   * плоский список, а потом молча перестраивать его в переписки.
   */
  groupByThread: true,
};

/** Настройки для любого экрана: пока их нет — значения по умолчанию. */
export function useGeneralPreferences(): GeneralSettings {
  return useGeneralSettings().data ?? DEFAULT_GENERAL_SETTINGS;
}

/**
 * Значение для `<input type="date">`.
 *
 * Сервер отдаёт срок автоответчика полной датой ISO
 * («2026-08-01T00:00:00.000Z»), а поле принимает только «гггг-мм-дд» и на
 * всём остальном молча показывается пустым. Пустое поле пользователь
 * сохранял обратно как null — и автоответчик становился бессрочным.
 *
 * Берём первые десять символов, а не пересчитываем через `Date`: сервер
 * хранит дату полуночью по UTC, и перевод в местный пояс западнее Гринвича
 * сдвинул бы её на сутки назад.
 */
export function dateInputValue(value: string | null | undefined): string {
  if (!value) return '';
  const head = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(head) ? head : '';
}

/** Подпись по умолчанию или null, если её нет (либо ссылка протухла). */
export function defaultSignature(settings: GeneralSettings): Signature | null {
  if (settings.defaultSignatureId === null) return null;
  return settings.signatures.find((s) => s.id === settings.defaultSignatureId) ?? null;
}

/** Подпись из настроек — в разметку тела письма. */
export function signatureHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\n/gu, '<br>');
}
