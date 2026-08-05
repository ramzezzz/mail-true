/**
 * Результаты поиска: строки сгруппированы по периодам («Неделя», «Июль 2026»),
 * совпадения подсвечены, справа у каждой строки — чип папки, под письмом с
 * вложениями разворачивается карточка вложения (research/mailru/09-search.png).
 *
 * Список здесь НЕ виртуализирован намеренно: строки разной высоты (у части
 * есть карточка вложения), а результатов на экране единицы сотен. Список
 * писем в папке виртуализирован — там строки одинаковые и их тысячи.
 */

import { Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Folder, MessageSummary } from '@mail-true/shared';
import { cx } from '../lib/cx';
import { folderTitle } from '../lib/folderNames';
import { formatListDate, groupMessagesByPeriod } from '../lib/listDates';
import { highlightSegments } from '../lib/searchQuery';
import { IconAttach, IconFlag } from '../mail/icons';
import styles from './SearchResults.module.css';

export interface SearchResultsProps {
  items: readonly MessageSummary[];
  /** Основы слов запроса — по ним идёт подсветка. */
  stems: readonly string[];
  folders: readonly Folder[];
}

/** Текст с жёлтой подсветкой совпадений. */
export function Highlighted({ text, stems }: { text: string; stems: readonly string[] }) {
  return (
    <>
      {highlightSegments(text, stems).map((segment, i) =>
        segment.hit ? (
          <mark key={i} className={styles.mark}>
            {segment.text}
          </mark>
        ) : (
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

function extensionOf(filename: string): string {
  const ext = filename.split('.').pop();
  return ext && ext.length <= 5 ? ext.toUpperCase() : 'ФАЙЛ';
}

export function SearchResults({ items, stems, folders }: SearchResultsProps) {
  const navigate = useNavigate();
  const groups = groupMessagesByPeriod(items);

  return (
    <div className={styles.list}>
      {groups.map((group) => (
        <section key={group.label} className={styles.group}>
          <h2 className={styles.groupTitle}>{group.label}</h2>
          {group.items.map((message) => (
            <ResultRow
              key={message.id}
              message={message}
              stems={stems}
              folders={folders}
              onOpen={() =>
                void navigate(`/${message.folderId}/${encodeURIComponent(message.id)}`)
              }
            />
          ))}
        </section>
      ))}
    </div>
  );
}

interface ResultRowProps {
  message: MessageSummary;
  stems: readonly string[];
  folders: readonly Folder[];
  onOpen(): void;
}

function ResultRow({ message, stems, folders, onOpen }: ResultRowProps) {
  const folder = folders.find((f) => f.id === message.folderId);
  const unread = !message.flags.seen;
  const sender = message.from.name?.trim() || message.from.address;

  return (
    <div className={styles.result}>
      <a
        href={`/${message.folderId}/${encodeURIComponent(message.id)}`}
        className={cx(styles.row, unread && styles.unread)}
        onClick={(e) => {
          if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.button !== 0) return;
          e.preventDefault();
          onOpen();
        }}
      >
        <span className={styles.correspondent}>
          <Highlighted text={sender} stems={stems} />
        </span>

        <span className={styles.flagCell}>
          {message.flags.flagged && (
            <span className={styles.flagIcon} title="Важное">
              <IconFlag />
            </span>
          )}
        </span>

        <span className={styles.title}>
          <span className={styles.subject}>
            <Highlighted text={message.subject || '(без темы)'} stems={stems} />
          </span>
          <span className={styles.snippet}>
            <Highlighted text={message.snippet} stems={stems} />
          </span>
        </span>

        {/* Чип папки, где лежит письмо */}
        <span className={styles.folderChip}>{folder ? folderTitle(folder) : message.folderId}</span>

        <span className={styles.attachCell}>
          {message.hasAttachments && (
            <span className={styles.attachIcon} title="С вложением">
              <IconAttach />
            </span>
          )}
        </span>

        <span className={styles.date}>{formatListDate(message.date)}</span>
      </a>

      {message.attachmentNames.map((filename) => (
        <AttachmentCard
          key={filename}
          filename={filename}
          fragment={message.snippet}
          stems={stems}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

interface AttachmentCardProps {
  filename: string;
  /**
   * Фрагмент документа с подсвеченным совпадением.
   *
   * ОГРАНИЧЕНИЕ: своего фрагмента из PDF или офисного файла API пока не
   * отдаёт, поэтому сюда попадает текст самого письма. Настоящий фрагмент
   * берётся IMAP-командой `SNIPPET` — Dovecot её уже объявляет
   * (`SNIPPET=FUZZY`, см. docs/search.md), нужен маршрут в API.
   */
  fragment: string;
  stems: readonly string[];
  onOpen(): void;
}

function AttachmentCard({ filename, fragment, stems, onOpen }: AttachmentCardProps) {
  return (
    <button type="button" className={styles.attachment} onClick={onOpen}>
      <span className={styles.attachmentExt}>{extensionOf(filename)}</span>
      <span className={styles.attachmentBody}>
        <span className={styles.attachmentName}>
          <Highlighted text={filename} stems={stems} />
        </span>
        {fragment && (
          <span className={styles.attachmentFragment}>
            …&nbsp;
            <Highlighted text={fragment} stems={stems} />
          </span>
        )}
      </span>
    </button>
  );
}
