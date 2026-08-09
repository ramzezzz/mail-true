/**
 * Разговор с помощником.
 *
 * ------------------------------------------------------------------
 * ЧТО ЭТО И ЧЕГО ЗДЕСЬ НЕТ
 * ------------------------------------------------------------------
 * Свободный разговор на любые темы. Помощник в этом режиме НЕ видит
 * почту и ничего не может изменить: маршрут разговора не читает ни
 * одного письма и не даёт модели никаких средств что-либо запросить.
 * Так и написано на экране — обещание, которое человек проверит первым
 * же вопросом «покажи мои письма», должно быть честным.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ РАЗГОВОР НЕ СОХРАНЯЕТСЯ
 * ------------------------------------------------------------------
 * История живёт в этом компоненте и уезжает на сервер с каждым
 * вопросом — иначе «а подробнее?» превращается в бессмыслицу. Но нигде
 * не хранится: закрыли окно — разговора нет. Это осознанный выбор,
 * а не недоделка. Хранить переписку человека с моделью значило бы
 * завести ещё одно место, где она лежит, и ещё один вопрос «а кто это
 * читает». О том, что разговор исчезнет, сказано прямо в окне.
 */

import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '../components';
import { useAiState } from '../api/aiQueries';
import { aiFeatureVisible, aiNeedsConsent, AI_SETTINGS_PATH } from './aiVisibility';
import { streamChat, type ChatTurn } from './chatStream';
import styles from './ChatPanel.module.css';

/** Реплика на экране: у ответа помощника бывает состояние «печатает». */
interface Turn extends ChatTurn {
  /** Ответ ещё пишется — показываем курсор и кнопку «остановить». */
  pending?: boolean;
}

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { data: state } = useAiState();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);

  const provider = state?.provider ?? null;
  const needsConsent = aiNeedsConsent(state);

  // Прокрутка к последней реплике: разговор читают снизу вверх, и
  // ответ, появляющийся за краем экрана, читателю не достаётся.
  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  // Уходя со страницы, обрываем поток: сервер по закрытию соединения
  // прекращает запрос к сервису ИИ, и за брошенный ответ не платят.
  useEffect(() => () => stopRef.current?.(), []);

  /**
   * Остановить ответ.
   *
   * Недостаточно оборвать поток: реплика помощника уже стоит на экране
   * с пометкой «печатает», и без уборки она остаётся такой навсегда —
   * три точки мигают, а ответа не будет уже никогда. Успевший прийти
   * текст оставляем: он настоящий, за него заплачено.
   */
  const stop = (): void => {
    stopRef.current?.();
    stopRef.current = null;
    setBusy(false);
    setTurns((previous) =>
      previous
        .map((turn) => (turn.pending ? { role: turn.role, content: turn.content } : turn))
        .filter((turn) => turn.content !== ''),
    );
  };

  const send = (): void => {
    const question = draft.trim();
    if (question === '' || busy) return;

    const history: Turn[] = [...turns, { role: 'user', content: question }];
    setTurns([...history, { role: 'assistant', content: '', pending: true }]);
    setDraft('');
    setError(null);
    setBusy(true);

    /*
     * На сервер уходит история БЕЗ пустой реплики помощника: она нужна
     * только экрану, чтобы было куда писать ответ.
     */
    const stream = streamChat(
      '/api/ai/chat/stream',
      history.map((turn) => ({ role: turn.role, content: turn.content })),
      {
        onDelta: (text) => {
          setTurns((previous) => {
            const copy = [...previous];
            const last = copy[copy.length - 1];
            if (last?.pending) copy[copy.length - 1] = { ...last, content: last.content + text };
            return copy;
          });
        },
        onDone: (text) => {
          setBusy(false);
          stopRef.current = null;
          setTurns((previous) => {
            const copy = [...previous];
            const last = copy[copy.length - 1];
            if (last?.pending) copy[copy.length - 1] = { role: 'assistant', content: text };
            return copy;
          });
        },
        onError: (message) => {
          setBusy(false);
          stopRef.current = null;
          setError(message);
          // Пустую реплику помощника убираем: пустой пузырь на экране
          // выглядит как ответ, которого не было.
          setTurns((previous) => previous.filter((turn) => !turn.pending));
        },
      },
    );
    stopRef.current = stream.stop;
  };

  return (
    <Modal title="Разговор с помощником" onClose={onClose} className={styles.card}>
      {!aiFeatureVisible(state, 'chat') ? (
        <p className={styles.note}>
          Разговор с помощником выключен. Включить его можно в{' '}
          <a href={AI_SETTINGS_PATH}>настройках помощника</a>, если администратор домена это
          разрешил.
        </p>
      ) : needsConsent ? (
        <p className={styles.note}>
          Прежде чем начать, нужно согласиться на передачу текста сервису ИИ — это делается один раз
          в <a href={AI_SETTINGS_PATH}>настройках помощника</a>.
        </p>
      ) : (
        <>
          <div className={styles.log} role="log" aria-live="polite">
            {turns.length === 0 && (
              <div className={styles.hello}>
                <p>
                  Спрашивайте о чём угодно. Помощник <b>не видит вашу почту</b> и ничего не может
                  изменить — он только отвечает.
                </p>
                <p className={styles.small}>
                  Разговор нигде не сохраняется: закроете окно — и его не станет.
                  {provider
                    ? ` Текст уходит сервису «${provider.label}»${
                        provider.local ? ' на этом же сервере' : ''
                      }.`
                    : ''}
                </p>
              </div>
            )}

            {turns.map((turn, index) => (
              <div
                key={index}
                className={turn.role === 'user' ? styles.mine : styles.theirs}
                data-pending={turn.pending ? 'yes' : undefined}
              >
                {turn.content}
                {turn.pending && turn.content === '' && (
                  <span className={styles.dots} aria-label="Помощник печатает" />
                )}
              </div>
            ))}
            <div ref={tailRef} />
          </div>

          {error !== null && <p className={styles.error}>{error}</p>}

          <div className={styles.composer}>
            <textarea
              className={styles.input}
              rows={2}
              value={draft}
              placeholder="Ваш вопрос…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter отправляет, Shift+Enter переносит строку — так же,
                // как в поле ответа на письмо.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            {busy ? (
              <Button mode="secondary" onClick={stop}>
                Остановить
              </Button>
            ) : (
              <Button onClick={send} disabled={draft.trim() === ''}>
                Спросить
              </Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
