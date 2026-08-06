/**
 * «Исходный текст письма» — письмо целиком, как оно пришло: все заголовки
 * и тело в исходном виде.
 *
 * Зачем это нужно. Маршрут `GET /api/messages/:id/source` на сервере был, но
 * в интерфейсе его не вызывал никто: пункта в меню письма не существовало.
 * А смотрят исходник ровно за тем, чего нет ни на одной другой странице:
 * разобрать путь письма по Received, проверить подпись DKIM, увидеть
 * настоящего отправителя за подставленным именем.
 *
 * Исходник здесь — ТЕКСТ, а не разметка. Никакого dangerouslySetInnerHTML:
 * письмо приходит от кого угодно, и содержимое, которое смотрят как раз
 * потому, что подозревают в нём подделку, не должно выполниться в интерфейсе.
 * React вставляет текстовый узел, поэтому <script> и onerror в теле письма
 * остаются буквами на экране.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Button, Modal, Spinner } from '../components';
import { errorText } from '../lib/errorText';
import { foldMessageSource } from '../lib/messageSource';
import { IconCheck, IconCopy } from './icons';
import styles from './MessageSource.module.css';

export interface MessageSourceProps {
  /** Составной идентификатор письма (`${folderId}:${uid}`). */
  messageId: string;
  /** Тема — только для имени скачиваемого файла и заголовка окна. */
  subject: string;
  onClose(): void;
}

/** Ссылка на исходник как файл — тот же маршрут отдаёт его вложением. */
function sourceUrl(messageId: string): string {
  return `/api/messages/${encodeURIComponent(messageId)}/source`;
}

export function MessageSource({ messageId, subject, onClose }: MessageSourceProps) {
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setRaw(null);
    setError(null);
    api
      .getMessageSource(messageId)
      .then((text) => {
        if (alive) setRaw(text);
      })
      .catch((err: unknown) => {
        if (alive) setError(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, [messageId]);

  /**
   * Полосы base64 сворачиваются перед показом. Письмо с фотографией — это
   * десятки тысяч строк из букв и цифр: браузер делает из них узлы разметки
   * и надолго задумывается, а найти в них всё равно нечего. Заголовки и текст
   * остаются целиком, письмо байт в байт — рядом, кнопкой «Скачать .eml».
   */
  const folded = useMemo(() => (raw === null ? null : foldMessageSource(raw)), [raw]);

  const copy = () => {
    // Копируется ПОЛНЫЙ исходник, а не свёрнутый: свёртка сделана ради
    // экрана, а вставляют текст обычно туда, где его будут разбирать.
    const text = raw ?? '';
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    // navigator.clipboard есть не везде (http-стенд, старые браузеры),
    // поэтому запасной путь через скрытое поле — иначе кнопка молча
    // не работала бы ровно там, где почту и проверяют.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => setError('Не удалось скопировать'));
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } finally {
      area.remove();
    }
  };

  return (
    <Modal title="Исходный текст письма" onClose={onClose} className={styles.card}>
      <div className={styles.head}>
        <span className={styles.subject}>{subject || '(без темы)'}</span>
        <div className={styles.actions}>
          <Button
            mode="secondary"
            size="s"
            before={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            onClick={copy}
            disabled={raw === null}
          >
            {copied ? 'Скопировано' : 'Скопировать'}
          </Button>
          {/* Именно ссылка, а не кнопка: маршрут уже отдаёт письмо файлом
              с Content-Disposition: attachment, и скачивание тут — обычный
              переход по ссылке, который работает и без JavaScript. */}
          <a className={styles.download} href={sourceUrl(messageId)} download>
            Скачать .eml
          </a>
        </div>
      </div>

      {error && <p className={styles.error}>Не удалось загрузить исходник. {error}</p>}
      {!error && folded === null && (
        <div className={styles.loading}>
          <Spinner size={24} />
        </div>
      )}
      {folded && (
        <>
          {(folded.foldedLines > 0 || folded.truncated) && (
            <p className={styles.notice}>
              {folded.truncated
                ? 'Исходник очень велик и показан не целиком.'
                : `Длинные части вложений свёрнуты (${folded.foldedLines} строк).`}{' '}
              Письмо полностью — кнопкой «Скачать .eml».
            </p>
          )}
          {/* Текстовый узел, а не разметка. Переносы сохраняет CSS
              (white-space: pre-wrap), поэтому заголовки видны так же,
              как в файле. */}
          <pre className={styles.source} data-testid="message-source">
            {folded.text}
          </pre>
        </>
      )}
    </Modal>
  );
}
