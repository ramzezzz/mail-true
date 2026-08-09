/**
 * «Письмо не отправлено» — плашка о письме, которое сервер не смог
 * отправить и вернул в черновики.
 *
 * Зачем она есть. Пока письмо уходило прямо в запросе, отказ почтового
 * сервера человек видел сразу, в самом окне написания. Отмена отправки
 * поставила между нажатием и настоящей отправкой несколько секунд —
 * и отказывать стало некому: человек уже закрыл вкладку. Письмо при этом
 * сохранялось в черновики, но МОЛЧА, и человек узнавал о нём от адресата
 * вопросом «почему вы не ответили». Эта плашка — то место, где он узнаёт
 * об этом от нас.
 *
 * Два источника, и оба нужны:
 *   — список с сервера (`useSendFailures`) читается при открытии почты;
 *     он и есть гарантия — извещение лежит на постоянном томе и дожидается
 *     человека, сколько бы тот ни отсутствовал;
 *   — событие по сокету (`send-failed`) только ускоряет показ, если вкладка
 *     открыта прямо сейчас. Само по себе оно ничего не обещает: закрытая
 *     вкладка его не увидит.
 *
 * Уведомлений браузера здесь нет намеренно: они выключены по умолчанию
 * и требуют разрешения, то есть у большинства ящиков молчали бы. Строить
 * на них извещение об отказе — значит сделать заметность отказа
 * необязательной.
 */

import { useAckSendFailure, useSendFailures } from '../api/queries';
import { useMailEvents } from '../app/mailEvents';
import { useUiStore } from '../app/store';
import { useOpenDraft } from './useOpenDraft';
import styles from './SendFailureBanner.module.css';

/** Человеческая запись времени последней попытки: «6 августа в 12:20». */
export function formatAttemptedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day} в ${time}`;
}

/**
 * Одна строка о том, что произошло: причина, кому именно отказали и когда
 * пробовали в последний раз.
 *
 * Адреса перечисляются поимённо, если сервер их назвал: «не приняли»
 * без указания адресата не говорит человеку, что чинить, — а чинить обычно
 * надо один опечатанный адрес из пяти.
 */
export function failureSummary(notice: {
  reason: string;
  rejected: Array<{ address: string; message: string }>;
  envelopeTo: string[];
  attempts: number;
  lastAttemptAt: string;
}): string {
  /*
   * Слова САМОГО почтового сервера получателя, если он их сказал, идут
   * в скобках после адреса. Наша формулировка говорит, что произошло,
   * а его — что чинить: «User unknown» означает опечатку в адресе,
   * «over quota» — переполненный ящик получателя, и это разные действия
   * человека. Переводить их мы не беремся: врать в переводе чужого ответа
   * хуже, чем показать его как есть.
   */
  const named = notice.rejected.map((r) =>
    r.message.trim() ? `${r.address} (${r.message.trim()})` : r.address,
  );
  const who = named.length > 0 ? named : notice.envelopeTo;
  const parts = [notice.reason.replace(/\.$/, '')];
  if (who.length > 0) parts.push(`Не доставлено: ${who.join(', ')}`);
  const when = formatAttemptedAt(notice.lastAttemptAt);
  if (when) {
    // Число попыток говорит, что мы не сдались с первого раза, — иначе
    // «не отправилось» читается как «а вы пробовали ещё раз?»
    parts.push(
      notice.attempts > 1 ? `Попыток: ${notice.attempts}, последняя ${when}` : `Пробовали ${when}`,
    );
  }
  return `${parts.join('. ')}.`;
}

export function SendFailureBanner() {
  const { data, refetch } = useSendFailures();
  const showNotice = useUiStore((s) => s.showNotice);
  const ack = useAckSendFailure();
  const { openDraft, loading } = useOpenDraft();

  // Вкладка открыта в момент отказа — перечитываем список сразу же.
  // Отдельного состояния для события нет намеренно: показывать надо
  // ровно то, что лежит на сервере, а не две слегка разные правды.
  useMailEvents((event) => {
    if (event.type === 'send-failed') void refetch();
  });

  const notices = data ?? [];
  const notice = notices[0];
  if (!notice) return null;

  return (
    <div className={styles.banner} role="alert">
      <div className={styles.body}>
        {/*
          Заголовок обязан совпадать с тем, что случилось. Раньше он был
          безусловным «Письмо не отправлено» — в том числе над письмом,
          которое большинство получателей уже получило. Человек читал это
          и отправлял письмо заново: у получивших оказывался дубль, а
          строка причины ниже говорила обратное заголовку.
        */}
        <div className={styles.title}>
          {notice.partial ? 'Письмо дошло не всем' : 'Письмо не отправлено'}
          {notice.subject ? <span className={styles.subject}>: «{notice.subject}»</span> : null}
        </div>
        <div className={styles.reason}>{failureSummary(notice)}</div>
        <div className={styles.actions}>
          {/* Черновик уже лежит в ящике — открываем прямо отсюда, чтобы
              человеку не пришлось искать его среди своих черновиков */}
          {notice.draftUid !== null && (
            <button
              type="button"
              className={styles.action}
              disabled={loading}
              onClick={() => openDraft(notice.draftUid as number)}
            >
              Открыть письмо
            </button>
          )}
          {/*
            Извещение убирается только этим нажатием, а не показом: плашку
            легко не заметить, а извещение, пропавшее само, вернуло бы нас
            ровно к молчаливой потере, из-за которой всё и делалось.
          */}
          <button
            type="button"
            className={styles.action}
            disabled={ack.isPending}
            /*
              Отказ виден. Раньше обработчика отказа не было вовсе:
              не прошло «Понятно» — кнопка просто снова становилась
              доступной, а извещение оставалось на месте. Человек жал
              второй раз и третий, не понимая, почему плашка не уходит.
            */
            onClick={() =>
              ack.mutate(notice.id, {
                onError: () => showNotice('Не удалось убрать извещение — попробуйте ещё раз'),
              })
            }
          >
            Понятно
          </button>
          {notices.length > 1 && <span className={styles.more}>и ещё {notices.length - 1}</span>}
        </div>
      </div>
    </div>
  );
}
