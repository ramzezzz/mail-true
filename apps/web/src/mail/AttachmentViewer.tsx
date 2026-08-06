/**
 * Окно предпросмотра вложения: посмотреть файл, не скачивая.
 *
 * Что именно и почему можно показывать — в attachmentPreview.ts, там же
 * разобрана безопасность целиком. Здесь — только показ.
 *
 * Три вещи, которые легко потерять при правке:
 *
 * 1. Байты берутся ЗАПРОСОМ (`api.getMessagePart`), а не адресом в `src`.
 *    Маршрут выдачи части письма отвечает `application/octet-stream` с
 *    `Content-Disposition: attachment` и `frame-ancestors 'none'` — по
 *    прямой ссылке вложение не становится документом. Предпросмотр этого
 *    не отменяет: он работает с уже полученными байтами. Заодно это
 *    единственный способ показать вложение в режиме заглушек.
 *
 * 2. blob-адрес создаётся с НАШИМ типом (см. blobTypeFor): что бы ни было
 *    написано в письме, картинка показывается картинкой, PDF — PDF.
 *
 * 3. Текст выводится текстовым узлом React, без dangerouslySetInnerHTML.
 *    `<script>` внутри `акт.txt` обязан остаться буквами на экране.
 *
 * Почему у рамки с PDF нет атрибута `sandbox`. Проверено в браузере
 * (Chrome 141): встроенный просмотрщик PDF — это плагин, а плагины в
 * песочнице отключены — рамка с любым набором `sandbox` (пустым,
 * `allow-scripts`, `allow-same-origin`) показывает значок «файл не
 * открылся». Изоляция здесь достигается иначе и не слабее: документ в
 * рамке — это PDF, а не HTML, у него нет ни доступа к DOM страницы, ни
 * `document.cookie`, ни запросов к нашему API; сам просмотрщик Chrome
 * работает в отдельном процессе. Плюс проверка `%PDF-` по байтам: чужой
 * файл, назвавшийся PDF-ом, до просмотрщика не доходит. Наследуемая
 * политика страницы (`object-src 'none'`, `frame-src 'self' blob:`)
 * остаётся в силе.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentInfo } from '@mail-true/shared';
import { api } from '../api';
import { Button, IconButton, Modal, Spinner } from '../components';
import { errorText } from '../lib/errorText';
import { formatBytes } from '../layout/FooterStatus';
import { decidePreview, decodeTextPart, looksLikePdf } from './attachments';
import { IconArrowLeft, IconArrowRight, IconDownload } from './icons';
import styles from './AttachmentViewer.module.css';

export interface AttachmentViewerProps {
  /** Составной идентификатор письма (`${folderId}:${uid}`). */
  messageId: string;
  /** Все вложения письма — по ним листают стрелками. */
  attachments: AttachmentInfo[];
  /** Какое открыто сейчас. */
  index: number;
  onIndexChange(index: number): void;
  onClose(): void;
}

/** Ссылка на часть письма — тот же маршрут, что и у скачивания с карточки. */
function partUrl(messageId: string, partId: string): string {
  return `/api/messages/${encodeURIComponent(messageId)}/parts/${encodeURIComponent(partId)}`;
}

/** Что показано в окне прямо сейчас. */
type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'refused'; reason: string }
  | { state: 'image'; url: string }
  | { state: 'pdf'; url: string }
  | { state: 'text'; text: string; charset: string };

export function AttachmentViewer({
  messageId,
  attachments,
  index,
  onIndexChange,
  onClose,
}: AttachmentViewerProps) {
  const current = attachments[index];
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  /**
   * Созданные blob-адреса живут ровно до смены вложения. Без отзыва байты
   * каждого просмотренного файла остаются в памяти вкладки до её закрытия —
   * десяток фотографий, и это сотни мегабайт.
   */
  const urlRef = useRef<string | null>(null);

  const releaseUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => releaseUrl, [releaseUrl]);

  useEffect(() => {
    if (!current) return;
    let alive = true;
    releaseUrl();
    setLoaded({ state: 'loading' });

    const verdict = decidePreview(current);
    if (verdict.kind === null) {
      setLoaded({ state: 'refused', reason: verdict.reason });
      return;
    }

    void (async () => {
      try {
        const blob = await api.getMessagePart(messageId, current.partId);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!alive) return;

        if (verdict.kind === 'text') {
          const { text, charset } = decodeTextPart(bytes);
          setLoaded({ state: 'text', text, charset });
          return;
        }
        if (verdict.kind === 'pdf' && !looksLikePdf(bytes)) {
          setLoaded({
            state: 'refused',
            reason:
              'Это не PDF: внутри файла лежит что-то другое, как бы он ни назывался. ' +
              'Открывать такое просмотрщиком мы не станем — файл можно скачать.',
          });
          return;
        }
        // Тип blob-а — наш, а не заявленный в письме (см. attachmentPreview.ts)
        const url = URL.createObjectURL(new Blob([bytes], { type: verdict.blobType }));
        urlRef.current = url;
        setLoaded(verdict.kind === 'pdf' ? { state: 'pdf', url } : { state: 'image', url });
      } catch (err: unknown) {
        if (alive) setLoaded({ state: 'error', message: errorText(err) });
      }
    })();

    return () => {
      alive = false;
    };
  }, [messageId, current, releaseUrl]);

  /* Листание стрелками клавиатуры — как в просмотре картинок у mail.ru.
     Escape уже закрывает окно (Modal). */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        onIndexChange(index - 1);
      }
      if (e.key === 'ArrowRight' && index < attachments.length - 1) {
        e.preventDefault();
        onIndexChange(index + 1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [index, attachments.length, onIndexChange]);

  const counter = useMemo(
    () => (attachments.length > 1 ? `${String(index + 1)} из ${String(attachments.length)}` : null),
    [index, attachments.length],
  );

  if (!current) return null;

  return (
    <Modal title="Просмотр вложения" onClose={onClose} className={styles.card}>
      <div className={styles.head}>
        <span className={styles.name} title={`${current.filename} — ${current.mimeType}`}>
          {current.filename}
        </span>
        <span className={styles.size}>{formatBytes(current.size)}</span>
        {/* Скачивание — обычная ссылка на маршрут выдачи части письма:
            работает и без JavaScript, и это тот же адрес, что на карточке. */}
        <a
          className={styles.download}
          href={partUrl(messageId, current.partId)}
          download={current.filename}
        >
          <IconDownload size={16} />
          Скачать
        </a>
      </div>

      <div className={styles.stage} data-testid="attachment-preview">
        {loaded.state === 'loading' && (
          <div className={styles.centered}>
            <Spinner size={28} />
          </div>
        )}
        {loaded.state === 'error' && (
          <div className={styles.centered}>
            <p className={styles.message}>Не удалось получить вложение. {loaded.message}</p>
          </div>
        )}
        {/* Отказ — словами, а не пустым квадратом: человек должен понимать,
            что файл цел, а показать его мы не беремся, и почему. */}
        {loaded.state === 'refused' && (
          <div className={styles.centered}>
            <p className={styles.message} data-testid="attachment-preview-refused">
              {loaded.reason}
            </p>
            <a
              className={styles.downloadBig}
              href={partUrl(messageId, current.partId)}
              download={current.filename}
            >
              <IconDownload size={16} />
              Скачать файл
            </a>
          </div>
        )}
        {loaded.state === 'image' && (
          <img
            className={styles.image}
            src={loaded.url}
            alt={current.filename}
            onError={() =>
              setLoaded({
                state: 'refused',
                reason:
                  'Картинка не открылась: похоже, файл повреждён или это не изображение. ' +
                  'Скачайте его, чтобы посмотреть другой программой.',
              })
            }
          />
        )}
        {loaded.state === 'pdf' && (
          /* Просмотрщик браузера. Без sandbox — иначе плагин не работает
             вовсе; почему это допустимо, разобрано в шапке файла. */
          <iframe
            className={styles.pdf}
            src={loaded.url}
            title={`Просмотр ${current.filename}`}
            referrerPolicy="no-referrer"
            allow=""
          />
        )}
        {loaded.state === 'text' && (
          <>
            {loaded.charset !== 'UTF-8' && (
              <p className={styles.notice}>
                Файл не в UTF-8 — показан как {loaded.charset}.
              </p>
            )}
            {/* Текстовый узел, а не разметка: содержимое чужого файла не
                должно выполниться в интерфейсе ни при каких условиях. */}
            <pre className={styles.text} data-testid="attachment-preview-text">
              {loaded.text}
            </pre>
          </>
        )}
      </div>

      {attachments.length > 1 && (
        <div className={styles.pager}>
          <IconButton
            label="Предыдущее вложение"
            disabled={index === 0}
            onClick={() => onIndexChange(index - 1)}
          >
            <IconArrowLeft size={20} />
          </IconButton>
          <span className={styles.counter}>{counter}</span>
          <IconButton
            label="Следующее вложение"
            disabled={index === attachments.length - 1}
            onClick={() => onIndexChange(index + 1)}
          >
            <IconArrowRight size={20} />
          </IconButton>
        </div>
      )}

      <div className={styles.foot}>
        <Button mode="tertiary" size="s" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </Modal>
  );
}
