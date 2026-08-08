/**
 * «Из Почты» — прикрепить к письму файл, который уже приходил в другом
 * письме. Возможность настоящая, из привычных почтовых интерфейсов (docs/features-reference.md).
 * Раньше кнопка в окне написания только писала в консоль.
 *
 * Отдельного маршрута «все вложения ящика» в API нет, поэтому окно собрано
 * из тех, что есть, и ровно тем же путём, каким вложение попадает в письмо
 * руками:
 *
 *   1. `GET /api/messages?filter=with-attachments` — письма с вложениями
 *      в выбранной папке;
 *   2. `GET /api/messages/:id` — состав письма (`attachments[]` с partId,
 *      именем, типом и размером). Запрашивается только для раскрытого
 *      письма: списку хватает `attachmentNames` из сводки;
 *   3. `GET /api/messages/:id/parts/:partId` — байты вложения;
 *   4. `POST /api/uploads` — те же байты обратно, уже как обычный файл;
 *      его `id` уходит в `attachmentIds` черновика.
 *
 * То есть выбранное вложение действительно прикрепляется к письму, а не
 * ссылается на чужое: пересланная копия живёт своей жизнью, как и в почте.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AttachmentInfo, MessageSummary } from '@mail-true/shared';
import { api } from '../api';
import { useFolders, useMessages } from '../api/queries';
import { MESSAGES_PAGE_SIZE } from '../api/client';
import type { UploadResponse } from '../api/types';
import { Button, Modal, Spinner } from '../components';
import { cx } from '../lib/cx';
import { actionErrorText } from '../lib/errorText';
import { folderTitle } from '../lib/folderNames';
import { formatListDate } from '../lib/listDates';
import styles from './MailAttachmentPicker.module.css';

/** Ключ выбранного вложения: письмо + номер части. */
function keyOf(messageId: string, partId: string): string {
  return `${messageId}\u0000${partId}`;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}

/**
 * Вложения, которые человек считает вложениями.
 *
 * Встроенные картинки письма (`inline` с Content-ID — подпись, логотип
 * в шапке рассылки) в списке «прикрепить» не нужны: в самом письме они
 * тоже не показаны отдельными плашками. Но если, кроме них, в письме нет
 * ничего, показываем и их — пустой список хуже лишней строки.
 */
export function pickableAttachments(all: readonly AttachmentInfo[]): AttachmentInfo[] {
  const visible = all.filter((a) => !a.inline);
  return visible.length > 0 ? visible : [...all];
}

interface PickerProps {
  onClose(): void;
  /** Загруженные файлы — их `id` уходит в `attachmentIds` черновика. */
  onPick(files: UploadResponse[]): void;
}

interface ChosenPart {
  messageId: string;
  attachment: AttachmentInfo;
}

export function MailAttachmentPicker({ onClose, onPick }: PickerProps) {
  const { data: folders } = useFolders();
  const [folderId, setFolderId] = useState('inbox');
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Map<string, ChosenPart>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    data: page,
    isPending,
    isError,
    error: listError,
  } = useMessages({
    folderId,
    offset: 0,
    limit: MESSAGES_PAGE_SIZE,
    threaded: false,
    filter: 'with-attachments',
  });

  const toggle = (messageId: string, attachment: AttachmentInfo) => {
    setChosen((current) => {
      const next = new Map(current);
      const key = keyOf(messageId, attachment.partId);
      if (next.has(key)) next.delete(key);
      else next.set(key, { messageId, attachment });
      return next;
    });
  };

  /**
   * Скачиваем выбранное и тут же загружаем обратно. Обычной загрузке файла
   * это ничем не отличается: сервер получает те же байты тем же запросом.
   */
  const attach = async () => {
    if (chosen.size === 0) return;
    setBusy(true);
    setError(null);
    const uploaded: UploadResponse[] = [];
    try {
      for (const { messageId, attachment } of chosen.values()) {
        const blob = await api.getMessagePart(messageId, attachment.partId);
        const file = new File([blob], attachment.filename, {
          type: attachment.mimeType || blob.type || 'application/octet-stream',
        });
        uploaded.push(await api.uploadAttachment(file));
      }
    } catch (err) {
      // Уже загруженное не выбрасываем: оно на сервере и оплачено ожиданием
      if (uploaded.length > 0) onPick(uploaded);
      setError(actionErrorText('Не удалось прикрепить вложение', err));
      setBusy(false);
      return;
    }
    onPick(uploaded);
    onClose();
  };

  const items = page?.items ?? [];

  return (
    <Modal
      title="Прикрепить из Почты"
      onClose={onClose}
      className={styles.card}
      footer={
        <>
          <Button mode="primary" onClick={() => void attach()} disabled={chosen.size === 0 || busy}>
            {busy ? 'Прикрепление…' : `Прикрепить${chosen.size > 0 ? ` (${chosen.size})` : ''}`}
          </Button>
          <Button mode="secondary" onClick={onClose} disabled={busy}>
            Отменить
          </Button>
          {error && <span className={styles.error}>{error}</span>}
        </>
      }
    >
      <div className={styles.folderRow}>
        <label className={styles.folderLabel} htmlFor="mt-attach-folder">
          Папка
        </label>
        <select
          id="mt-attach-folder"
          className={styles.folderSelect}
          value={folderId}
          onChange={(e) => {
            setFolderId(e.target.value);
            setOpenedId(null);
          }}
        >
          {(folders ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {folderTitle(f)}
            </option>
          ))}
        </select>
      </div>

      {isPending && (
        <div className={styles.state}>
          <Spinner />
        </div>
      )}
      {isError && (
        <div className={styles.state}>
          {actionErrorText('Не удалось загрузить письма', listError)}
        </div>
      )}
      {!isPending && !isError && items.length === 0 && (
        <div className={styles.state}>В этой папке нет писем с вложениями.</div>
      )}

      <ul className={styles.list}>
        {items.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            opened={openedId === message.id}
            onToggleOpen={() => setOpenedId((id) => (id === message.id ? null : message.id))}
            isChosen={(partId) => chosen.has(keyOf(message.id, partId))}
            onChoose={(attachment) => toggle(message.id, attachment)}
          />
        ))}
      </ul>
    </Modal>
  );
}

interface RowProps {
  message: MessageSummary;
  opened: boolean;
  onToggleOpen(): void;
  isChosen(partId: string): boolean;
  onChoose(attachment: AttachmentInfo): void;
}

/**
 * Строка письма. Состав вложений (нужны `partId` и размер) запрашивается
 * только при раскрытии: иначе на полсотни писем ушло бы полсотни запросов
 * ради строчки, на которую, скорее всего, никто не нажмёт.
 */
function MessageRow({ message, opened, onToggleOpen, isChosen, onChoose }: RowProps) {
  const [parts, setParts] = useState<AttachmentInfo[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const full = await api.getMessage(message.id);
      setParts(pickableAttachments(full.attachments));
    } catch (err) {
      setFailed(actionErrorText('Не удалось прочитать письмо', err));
    }
  }, [message.id]);

  useEffect(() => {
    if (opened && parts === null && failed === null) void load();
  }, [opened, parts, failed, load]);

  return (
    <li className={styles.item}>
      <button
        type="button"
        className={cx(styles.itemHead, opened && styles.itemHeadOpen)}
        onClick={onToggleOpen}
        aria-expanded={opened}
      >
        <span className={styles.itemFrom}>{message.from.name || message.from.address}</span>
        <span className={styles.itemSubject}>{message.subject || '(без темы)'}</span>
        <span className={styles.itemNames}>{message.attachmentNames.join(', ')}</span>
        <span className={styles.itemDate}>{formatListDate(message.date)}</span>
      </button>

      {opened && (
        <div className={styles.parts}>
          {failed && <div className={styles.state}>{failed}</div>}
          {!failed && parts === null && (
            <div className={styles.state}>
              <Spinner size={18} />
            </div>
          )}
          {parts?.length === 0 && <div className={styles.state}>В письме нет вложений.</div>}
          {parts?.map((a) => (
            <label key={a.partId} className={styles.part}>
              <input type="checkbox" checked={isChosen(a.partId)} onChange={() => onChoose(a)} />
              <span className={styles.partName}>{a.filename}</span>
              <span className={styles.partSize}>{formatAttachmentSize(a.size)}</span>
            </label>
          ))}
        </div>
      )}
    </li>
  );
}
