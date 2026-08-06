/**
 * Помощь с ответом в окне написания письма.
 *
 * Три вещи: варианты ответа с разным тоном, продолжение начатой фразы
 * и правка написанного (сократить / смягчить / исправить). Результат
 * ВСЕГДА попадает в поле ввода как черновик и только по отдельному
 * нажатию — ничего не вставляется само и тем более не отправляется.
 *
 * Панель целиком исчезает, если администратор запретил помощника или
 * пользователь выключил возможность «Помощь с ответом».
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAiContinue, useAiReplies, useAiRewrite, useAiState } from '../api/aiQueries';
import type { AiRewriteMode } from '../api/aiTypes';
import { aiRewriteTitles, aiToneTitles } from '../api/aiTypes';
import {
  AI_SETTINGS_PATH,
  aiErrorText,
  aiFeatureVisible,
  aiNeedsConsent,
} from '../ai/aiVisibility';
import { OutboundDetails } from '../ai/OutboundDetails';
import { Button, Spinner } from '../components';
import { IconSparkles } from '../mail/icons';
import styles from './ComposeAiPanel.module.css';

/** Что помощник берёт из редактора и что возвращает в него. */
export interface ComposeAiPanelProps {
  /** Письмо, на которое отвечаем. Без него варианты ответа не предлагаются. */
  sourceMessageId?: string | undefined;
  /** Весь текст редактора — для продолжения фразы. */
  readAll(): string;
  /** Выделенный фрагмент или, если ничего не выделено, весь текст. */
  readSelectionOrAll(): { text: string; whole: boolean };
  /** Вставить текст в место курсора. */
  insert(text: string): void;
  /** Заменить выделенный фрагмент (или весь текст, если выделения нет). */
  replace(text: string, whole: boolean): void;
}

export function ComposeAiPanel({
  sourceMessageId,
  readAll,
  readSelectionOrAll,
  insert,
  replace,
}: ComposeAiPanelProps) {
  const navigate = useNavigate();
  const { data: state } = useAiState();
  const replies = useAiReplies();
  const continuation = useAiContinue();
  const rewrite = useAiRewrite();
  /** Правку надо вернуть туда же, откуда взяли: помним, был ли это весь текст. */
  const [rewriteWhole, setRewriteWhole] = useState(true);

  const visible = aiFeatureVisible(state, 'reply');
  const needsConsent = aiNeedsConsent(state);

  // Помощник запрещён администратором или выключен пользователем — панели нет.
  if (!visible) return null;

  const goToSettings = () => {
    void navigate(AI_SETTINGS_PATH);
  };

  const askReplies = () => {
    if (!sourceMessageId) return;
    replies.mutate({ messageId: sourceMessageId });
  };

  const askContinuation = () => {
    const draft = readAll().trim();
    if (!draft) return;
    continuation.mutate(
      sourceMessageId === undefined ? { draft } : { draft, messageId: sourceMessageId },
    );
  };

  const askRewrite = (mode: AiRewriteMode) => {
    const { text, whole } = readSelectionOrAll();
    if (!text.trim()) return;
    setRewriteWhole(whole);
    rewrite.mutate({ text, mode });
  };

  const pending = replies.isPending || continuation.isPending || rewrite.isPending;

  // Отдельные константы, а не `replies.data.…` внутри обработчиков:
  // сужение типа свойства не переживает создание функции.
  const repliesData = replies.data;
  const continuationData = continuation.data;
  const rewriteData = rewrite.data;

  return (
    <div
      className={styles.panel}
      // Как и панель форматирования: не даём кнопкам увести фокус,
      // иначе выделение в редакторе пропадёт и заменять будет нечего.
      onMouseDown={(e) => e.preventDefault()}
      aria-label="Помощник"
    >
      <div className={styles.row}>
        <span className={styles.rowTitle}>
          <span className={styles.rowIcon}>
            <IconSparkles size={14} />
          </span>
          Помощник
        </span>

        {needsConsent ? (
          <span className={styles.consent}>
            Помощник ещё не включён — сначала нужно посмотреть, что уходит наружу.
            <Button mode="tertiary" size="s" onClick={goToSettings}>
              Настроить
            </Button>
          </span>
        ) : (
          <>
            {sourceMessageId && (
              <Button mode="tertiary" size="s" onClick={askReplies} disabled={pending}>
                Варианты ответа
              </Button>
            )}
            <Button mode="tertiary" size="s" onClick={askContinuation} disabled={pending}>
              Продолжить фразу
            </Button>
            {(Object.keys(aiRewriteTitles) as AiRewriteMode[]).map((mode) => (
              <Button
                key={mode}
                mode="tertiary"
                size="s"
                onClick={() => askRewrite(mode)}
                disabled={pending}
              >
                {aiRewriteTitles[mode]}
              </Button>
            ))}
          </>
        )}
      </div>

      {pending && (
        <div className={styles.pending}>
          <Spinner size={16} label="Помощник думает" />
          Помощник думает…
        </div>
      )}

      {!pending && replies.error && (
        <div className={styles.error}>{aiErrorText(replies.error)}</div>
      )}
      {!pending && continuation.error && (
        <div className={styles.error}>{aiErrorText(continuation.error)}</div>
      )}
      {!pending && rewrite.error && (
        <div className={styles.error}>{aiErrorText(rewrite.error)}</div>
      )}

      {/* Варианты ответа */}
      {!pending && repliesData && (
        <div className={styles.variants}>
          {repliesData.value.variants.map((variant) => (
            <div key={variant.tone} className={styles.variant}>
              <div className={styles.variantHead}>
                <span className={styles.variantTone}>{aiToneTitles[variant.tone]}</span>
                <Button mode="secondary" size="s" onClick={() => insert(variant.body)}>
                  Вставить
                </Button>
              </div>
              <pre className={styles.variantBody}>{variant.body}</pre>
            </div>
          ))}
          {/* Опись отправленного; для ответа из кэша — строка про кэш */}
          <OutboundDetails disclosure={repliesData.disclosure} />
        </div>
      )}

      {/* Продолжение начатой фразы */}
      {!pending && continuationData && continuationData.value.continuation.trim() !== '' && (
        <div className={styles.variant}>
          <div className={styles.variantHead}>
            <span className={styles.variantTone}>Продолжение</span>
            <Button
              mode="secondary"
              size="s"
              onClick={() => insert(continuationData.value.continuation)}
            >
              Вставить
            </Button>
          </div>
          <pre className={styles.variantBody}>{continuationData.value.continuation}</pre>
          <OutboundDetails disclosure={continuationData.disclosure} />
        </div>
      )}

      {/* Правка написанного */}
      {!pending && rewriteData && (
        <div className={styles.variant}>
          <div className={styles.variantHead}>
            <span className={styles.variantTone}>
              {rewriteWhole ? 'Правка всего текста' : 'Правка выделенного'}
            </span>
            <Button
              mode="secondary"
              size="s"
              onClick={() => replace(rewriteData.value.text, rewriteWhole)}
            >
              Заменить
            </Button>
          </div>
          <pre className={styles.variantBody}>{rewriteData.value.text}</pre>
          {rewriteData.value.changes.length > 0 && (
            <ul className={styles.changes}>
              {rewriteData.value.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          )}
          <OutboundDetails disclosure={rewriteData.disclosure} />
        </div>
      )}
    </div>
  );
}
