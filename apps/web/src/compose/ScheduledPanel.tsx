/**
 * «Уйдут позже» — письма, поставленные в очередь кнопкой «Отправить позже».
 *
 * ЗАЧЕМ. Между нажатием и сроком (а это до тридцати суток) письма не было
 * видно НИГДЕ: из «Черновиков» оно уходит при постановке в очередь — иначе
 * одно письмо лежало бы в двух местах и ушло бы дважды, — а в
 * «Отправленные» ещё не попало. Ни посмотреть, ни отменить, ни исправить
 * опечатку. Сервер список отдавал давно (`GET /api/messages/scheduled`),
 * а интерфейс его не спрашивал ни разу.
 *
 * Почему панель, а не папка. Папку в почте рисует IMAP, а очередь живёт на
 * диске сервера приложения и в ящике не существует; заводить ради неё
 * поддельную папку значило бы врать про её содержимое всем почтовым
 * программам сразу. Панель показывается там же, где извещение об отказе
 * отправки, и по той же причине: она должна быть видна независимо от
 * того, открыто ли сейчас окно написания.
 *
 * Отмена возвращает письмо в «Черновики» — это делает сервер (см.
 * /messages/send/undo). Поэтому кнопка так и называется: человек не теряет
 * написанное, а получает его обратно в привычное место.
 */

import { useState } from 'react';
import { useScheduledMessages, useUndoSend } from '../api/queries';
import { useUiStore } from '../app/store';
import styles from './ScheduledPanel.module.css';

/** «завтра в 9:00», «12 августа в 14:30» — то, что человек и задавал. */
export function formatSendAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return `сегодня в ${time}`;
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  if (at.toDateString() === tomorrow.toDateString()) return `завтра в ${time}`;
  const day = at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `${day} в ${time}`;
}

/** Кому уйдёт: один адрес целиком, несколько — первый и «ещё N». */
export function formatRecipients(to: readonly string[]): string {
  if (to.length === 0) return 'без получателей';
  if (to.length === 1) return to[0] ?? '';
  return `${to[0] ?? ''} и ещё ${String(to.length - 1)}`;
}

export function ScheduledPanel() {
  const { data } = useScheduledMessages();
  const undo = useUndoSend();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Куда делось отменённое письмо.
   *
   * Раньше удачная отмена не говорила ничего: строка исчезала из списка, и
   * человек оставался гадать, вернули ему письмо или выбросили. А выбросить
   * его тут действительно было можно — ровно это и чинится задачей.
   */
  const showNotice = useUiStore((state) => state.showNotice);
  const items = data ?? [];

  if (items.length === 0) return null;

  const cancel = (id: string): void => {
    setError(null);
    /*
     * `heldByWindow` здесь НЕ шлётся, и это главное отличие от полосы
     * «Отменить отправку» в окне написания: окна к этому времени нет —
     * ни у письма, отложенного на понедельник, ни у обычного, которому
     * почтовый сервер отказал временно. Сервер вернёт письмо в
     * «Черновики», а не сотрёт.
     */
    undo.mutate(
      { pendingId: id },
      {
        onSuccess: (result) => {
          if (result.cancelled) {
            /*
             * Говорим ОБЩИМ извещением, а не строкой внутри панели.
             *
             * Панель исчезает вместе с опустевшим списком — а он пустеет
             * ровно в самом частом случае: письмо в очереди было одно.
             * Строку внутри неё человек не видел никогда, то есть
             * молчаливая отмена, которую она должна была исправить,
             * оставалась молчаливой. Сообщения об ОШИБКЕ видны, потому
             * что при ошибке строка остаётся в списке.
             */
            showNotice(
              result.draftId
                ? 'Отправка отменена, письмо вернулось в «Черновики»'
                : 'Отправка отменена',
            );
            return;
          }
          /*
           * Причина отказа называется словами. Раньше на любой отказ
           * говорилось «письмо уже ушло» — в том числе когда письмо всего
           * лишь было в работе у очереди и лежало в ней дальше.
           */
          setError(
            result.reason === 'sending'
              ? 'Письмо прямо сейчас отправляется — попробуйте ещё раз через несколько секунд.'
              : result.reason === 'draft-failed'
                ? (result.message ??
                  'Письмо не удалось вернуть в «Черновики», оно осталось в очереди.')
                : 'Письмо уже ушло — отменить не получилось.',
          );
        },
        onError: () => setError('Не удалось связаться с сервером. Попробуйте ещё раз.'),
      },
    );
  };

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.head}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.title}>Уйдут позже: {items.length}</span>
        <span className={styles.chevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id} className={styles.row}>
              <div className={styles.text}>
                <div className={styles.subject}>{item.subject || 'Без темы'}</div>
                <div className={styles.meta}>
                  {formatRecipients(item.to)} · {formatSendAt(item.sendAt)}
                  {item.attempts > 0 && (
                    /* Сорвавшиеся попытки показываем до срока, а не после:
                       человеку лучше узнать о них, пока он может что-то
                       поправить. */
                    <span className={styles.attempts}> · попыток: {item.attempts}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className={styles.cancel}
                onClick={() => cancel(item.id)}
                disabled={undo.isPending}
              >
                Отменить
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
