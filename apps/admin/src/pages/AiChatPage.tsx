/**
 * Разговор с помощником, который знает про этот сервер.
 *
 * ------------------------------------------------------------------
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ ПОЛЬЗОВАТЕЛЬСКОГО
 * ------------------------------------------------------------------
 * Только правилами разговора: модели передан справочник по продукту —
 * разделы панели, устройство стека и список настроек с назначением. То
 * есть на вопрос «где выпустить ключ DKIM» она называет раздел, а не
 * рассуждает о почтовых серверах вообще.
 *
 * Доступа к серверу у неё при этом нет — ни здесь, ни в пользовательском
 * разговоре. ЗНАЧЕНИЙ настроек в справочнике тоже нет: иначе разговор
 * стал бы способом вытащить содержимое infra/.env вопросом «а что у меня
 * сейчас стоит», и помощник охотно бы его назвал.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ РАЗГОВОР НЕ СОХРАНЯЕТСЯ
 * ------------------------------------------------------------------
 * История живёт на этой странице и уезжает на сервер с каждым вопросом —
 * иначе «а подробнее?» превращается в бессмыслицу. Но нигде не хранится:
 * ушли со страницы — разговора нет. Хранить его значило бы завести ещё
 * одно место с описанием устройства сервера и чужими вопросами.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@web/components';
import { PageTitle } from '../app/AdminLayout';
import { Notice, Panel } from '../components/ui';
import {
  streamChat,
  trimHistoryForServer,
  CHAT_TURN_MAX_CHARS,
  type ChatTurn,
} from '../lib/chatStream';
import styles from './AiChatPage.module.css';

interface Turn extends ChatTurn {
  /** Ответ ещё пишется. */
  pending?: boolean;
}

/**
 * Подсказки для начала. Это не украшение: пустое поле ввода в разделе,
 * про который непонятно, что он умеет, остаётся пустым — а вопросы
 * показывают круг задач лучше любого описания.
 */
const EXAMPLES: readonly string[] = [
  'Где выпустить ключ DKIM и что потом сделать с DNS?',
  'Письма уходят в спам у получателей — с чего начать разбор?',
  'Как обновить сервер и что при этом прервётся?',
  'Какая настройка отвечает за срок хранения истории доставки?',
];

export function AiChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  // Уходя со страницы, обрываем поток: сервер по закрытию соединения
  // прекращает запрос к сервису ИИ, и за брошенный ответ не платят.
  useEffect(() => () => stopRef.current?.(), []);

  /**
   * Остановить ответ.
   *
   * Недостаточно оборвать поток: реплика помощника уже стоит на экране с
   * пометкой «печатает», и без уборки она остаётся такой навсегда. Текст,
   * успевший прийти, оставляем — он настоящий.
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

  const ask = (question: string): void => {
    const text = question.trim();
    if (text === '' || busy) return;
    // Разбор — тот же, что и в почте (apps/web ChatPanel): предел на
    // сервере применяется ко всей истории, а история уезжает с каждым
    // вопросом, поэтому одна длинная реплика ломает весь разговор.
    if (text.length > CHAT_TURN_MAX_CHARS) {
      setError(
        `Вопрос длиннее ${String(CHAT_TURN_MAX_CHARS)} знаков — сократите его ` +
          'или разбейте на несколько.',
      );
      return;
    }

    const history: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns([...history, { role: 'assistant', content: '', pending: true }]);
    setDraft('');
    setError(null);
    setBusy(true);

    const stream = streamChat(
      '/api/admin/ai/chat/stream',
      // Длинные ответы помощника обрезаются перед отправкой; на экране
      // они остаются целиком.
      trimHistoryForServer(history.map((turn) => ({ role: turn.role, content: turn.content }))),
      {
        onDelta: (chunk) => {
          setTurns((previous) => {
            const copy = [...previous];
            const last = copy[copy.length - 1];
            if (last?.pending) copy[copy.length - 1] = { ...last, content: last.content + chunk };
            return copy;
          });
        },
        onDone: (full) => {
          setBusy(false);
          stopRef.current = null;
          setTurns((previous) => {
            const copy = [...previous];
            const last = copy[copy.length - 1];
            if (last?.pending) copy[copy.length - 1] = { role: 'assistant', content: full };
            return copy;
          });
        },
        onError: (message) => {
          setBusy(false);
          stopRef.current = null;
          setError(message);
          // Пустой пузырь на экране выглядит как ответ, которого не было.
          setTurns((previous) => previous.filter((turn) => !turn.pending));
        },
      },
    );
    stopRef.current = stream.stop;
  };

  return (
    <>
      <PageTitle
        title="Помощник"
        subtitle="Спросить про настройку этого сервера, разобрать ошибку, понять, что изменится"
      />

      <Panel>
        <div className={styles.log} role="log" aria-live="polite">
          {turns.length === 0 && (
            <div className={styles.hello}>
              <p>
                Помощник знает устройство панели и назначение настроек этого продукта. Доступа к
                серверу у него нет: он подсказывает, что сделать, а делаете вы.
              </p>
              <p className={styles.small}>
                Значений ваших настроек, паролей и ключей он не видит — в справочник они не
                передаются. Разговор нигде не сохраняется: уйдёте со страницы — и его не станет.
              </p>
              <div className={styles.examples}>
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className={styles.example}
                    onClick={() => ask(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn, index) => (
            <div key={index} className={turn.role === 'user' ? styles.mine : styles.theirs}>
              {turn.content}
              {turn.pending && turn.content === '' && (
                <span className={styles.dots} aria-label="Помощник печатает" />
              )}
            </div>
          ))}
          <div ref={tailRef} />
        </div>

        {error !== null && <Notice tone="error">{error}</Notice>}

        <div className={styles.composer}>
          <textarea
            className={styles.input}
            rows={2}
            value={draft}
            placeholder="О чём спросить…"
            maxLength={CHAT_TURN_MAX_CHARS}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter отправляет, Shift+Enter переносит строку.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                ask(draft);
              }
            }}
          />
          {busy ? (
            <Button mode="secondary" onClick={stop}>
              Остановить
            </Button>
          ) : (
            <Button onClick={() => ask(draft)} disabled={draft.trim() === ''}>
              Спросить
            </Button>
          )}
          {turns.length > 0 && !busy && (
            <Button
              mode="secondary"
              onClick={() => {
                setTurns([]);
                setError(null);
              }}
            >
              Начать заново
            </Button>
          )}
        </div>
      </Panel>
    </>
  );
}
