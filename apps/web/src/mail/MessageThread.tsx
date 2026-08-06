/**
 * Цепочка переписки под раскрытым письмом (docs/features-mailru.md,
 * «Цепочки переписки»).
 *
 * Одно письмо раскрыто целиком — его рисует страница письма, — а остальные
 * идут свёрнутыми строками по 48px: отправитель, начало текста, дата.
 * Нажатие разворачивает строку прямо на месте, не уводя со страницы;
 * повторное — сворачивает обратно.
 *
 * Скругления по краям цепочки и у соседей раскрытого письма считает
 * `threadRowStates` (lib/threads.ts) — там же они и проверены тестами.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MessageSummary } from '@mail-true/shared';
import { useMessage } from '../api/queries';
import { Spinner } from '../components';
import { cx } from '../lib/cx';
import { formatListDate, formatMessageDate } from '../lib/listDates';
import { threadRowStates } from '../lib/threads';
import { IconAttach, IconNewTab } from './icons';
import styles from './MessageThread.module.css';
import { SenderAvatar } from './SenderAvatar';

export interface MessageThreadProps {
  /** Остальные письма цепочки, старые сверху — как в mail.ru. */
  messages: readonly MessageSummary[];
  /** Всего писем в цепочке, включая раскрытое: число в заголовке. */
  totalCount: number;
}

export function MessageThread({ messages, totalCount }: MessageThreadProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (messages.length === 0) return null;

  const states = threadRowStates(
    messages.map((m) => m.id),
    expanded,
  );

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className={styles.thread} aria-label="Переписка">
      <h3 className={styles.title}>Ещё писем в переписке: {totalCount - 1}</h3>

      <div className={styles.letters}>
        {states.map((state, index) => {
          const message = messages[index];
          if (!message) return null;
          return (
            <ThreadLetter
              key={message.id}
              message={message}
              expanded={state.expanded}
              first={state.first}
              last={state.last}
              expandedPrev={state.expandedPrev}
              expandedNext={state.expandedNext}
              onToggle={() => toggle(message.id)}
            />
          );
        })}
      </div>
    </section>
  );
}

interface ThreadLetterProps {
  message: MessageSummary;
  expanded: boolean;
  first: boolean;
  last: boolean;
  expandedPrev: boolean;
  expandedNext: boolean;
  onToggle(): void;
}

function ThreadLetter({
  message,
  expanded,
  first,
  last,
  expandedPrev,
  expandedNext,
  onToggle,
}: ThreadLetterProps) {
  const sender = message.from.name?.trim() || message.from.address;

  return (
    <div
      className={cx(
        styles.letter,
        expanded ? styles.letterExpanded : styles.letterCollapsed,
        first && styles.letterFirst,
        last && styles.letterLast,
        expandedPrev && styles.letterExpandedPrev,
        expandedNext && styles.letterExpandedNext,
        !message.flags.seen && styles.letterUnread,
      )}
    >
      {/* Шапка письма — 60px у раскрытого, 48px у свёрнутого */}
      <button
        type="button"
        className={cx(styles.head, expanded && styles.headExpanded)}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={styles.readStatus}>
          {!message.flags.seen && <span className={styles.unreadDot} aria-hidden="true" />}
        </span>
        {/* Тот же кружок, что в списке и в шапке открытого письма.
            `tint={false}` — потому что кружки цепочки намеренно серые, одним
            цветом из темы: в переписке двух человек разноцветная лесенка
            выглядела бы пестрее самих писем. Логотип это не отменяет: под
            ним подложка своя. */}
        <SenderAvatar
          className={styles.avatar}
          name={sender}
          address={message.from.address}
          logoDomain={message.senderLogoDomain}
          tint={false}
        />
        <span className={styles.details}>
          <span className={styles.detailsLine}>
            <span className={styles.sender}>{sender}</span>
            {!expanded && <span className={styles.snippet}>{message.snippet}</span>}
          </span>
          {expanded && <span className={styles.to}>Кому: вам</span>}
        </span>
        {message.hasAttachments && (
          <span className={styles.attachIcon} title="С вложением">
            <IconAttach />
          </span>
        )}
        <span className={styles.date}>
          {expanded ? formatMessageDate(message.date) : formatListDate(message.date)}
        </span>
      </button>

      {expanded && <ThreadLetterBody id={message.id} folderId={message.folderId} />}
    </div>
  );
}

/** Тело письма подгружается только когда строку развернули. */
function ThreadLetterBody({ id, folderId }: { id: string; folderId: string }) {
  const navigate = useNavigate();
  const { data, isPending, isError } = useMessage(id);

  if (isPending) {
    return (
      <div className={styles.bodyLoading}>
        <Spinner size={20} />
      </div>
    );
  }

  if (isError || !data) {
    return <div className={styles.bodyLoading}>Не удалось загрузить письмо</div>;
  }

  // Внешние картинки уже заблокированы сервером: в теле стоят прозрачные
  // пиксели, адреса лежат в data-mt-src. Ничего доблокировать не нужно —
  // а «Показать» в свёрнутой строке цепочки и не предлагается.
  return (
    <div className={styles.body}>
      {data.bodyHtml ? (
        <div dangerouslySetInnerHTML={{ __html: data.bodyHtml }} />
      ) : (
        <pre className={styles.bodyText}>{data.bodyText}</pre>
      )}
      <button
        type="button"
        className={styles.openFull}
        onClick={() => void navigate(`/${folderId}/${encodeURIComponent(id)}`)}
      >
        <IconNewTab size={14} />
        Открыть письмо целиком
      </button>
    </div>
  );
}
