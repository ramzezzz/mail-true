/**
 * «Шаблоны» в панели написания письма.
 *
 * Место кнопки размечено по mail.ru: `docs/features-mailru.md`, панель
 * форматирования, «Справа: Вставить подпись, Шаблоны». Отсюда и разделение
 * — значки правки текста идут слева, а «Шаблоны» отжаты к правому краю той
 * же панели.
 *
 * ------------------------------------------------------------------
 * ГЛАВНОЕ ПРАВИЛО: ВСТАВКА НЕ ЗАТИРАЕТ НАПИСАННОЕ
 * ------------------------------------------------------------------
 * Шаблон вставляется В ПОЗИЦИЮ КУРСОРА, а не заменяет тело письма. Это
 * названо главным риском всей возможности в docs/gaps.md, и держится оно
 * на одной детали: панель форматирования гасит `mousedown`
 * (см. ComposeWindow.tsx), поэтому выделение в редакторе переживает
 * нажатие по кнопке и по пункту меню. Меню живёт ВНУТРИ этой панели — не
 * ради вида: вынеси его наружу, и курсор терялся бы при открытии, а
 * вставка уезжала бы в начало письма.
 *
 * Тема ведёт себя так же осторожно: пустую заполняем темой шаблона, уже
 * набранную — не трогаем и говорим об этом. Молча заменить набранную тему
 * значило бы отправить письмо с чужим заголовком.
 */

import { useState } from 'react';
import {
  Button,
  Checkbox,
  MenuItem,
  MenuSeparator,
  Modal,
  TextField,
  useDropdownClose,
} from '../components';
import { IconAttach, IconSettings } from '../mail/icons';
import type { MailTemplate } from '../mail/templatesApi';
import styles from './TemplateMenu.module.css';

/** Человеческий размер вложения для строки меню: «240 КБ». */
export function fileSizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
  if (bytes >= 1024) return `${String(Math.round(bytes / 1024))} КБ`;
  return `${String(bytes)} Б`;
}

/**
 * Короткая выжимка шаблона под его названием.
 *
 * Название человек придумывает сам и через месяц не всегда помнит, что за
 * ним стоит. Первые слова текста напоминают об этом, не заставляя вставлять
 * шаблон наугад и потом отменять.
 */
export function templatePreview(bodyHtml: string, limit = 68): string {
  const text = bodyHtml
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/<\/(p|div|li|tr)>/giu, ' ')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

export interface TemplateMenuProps {
  items: readonly MailTemplate[];
  /** Вставить шаблон в письмо. Вставку делает окно написания. */
  onPick(template: MailTemplate): void;
  /** «Сохранить как шаблон» — открывает окно с названием. */
  onSaveCurrent(): void;
}

/**
 * Содержимое меню «Шаблоны».
 *
 * Отдельный компонент нужен ради `useDropdownClose`: строки шаблонов
 * нарисованы своей разметкой (название + выжимка + скрепка), а не через
 * `MenuItem`, который закрывается сам. Без этого меню оставалось бы висеть
 * поверх уже изменившегося письма.
 */
export function TemplateMenu({ items, onPick, onSaveCurrent }: TemplateMenuProps) {
  const close = useDropdownClose();

  return (
    <div className={styles.menu}>
      {items.length === 0 ? (
        <p className={styles.empty}>
          Шаблонов пока нет. Напишите письмо и сохраните его как шаблон — в следующий раз он
          вставится одним нажатием.
        </p>
      ) : (
        <div className={styles.list}>
          {items.map((template) => (
            <button
              key={template.id}
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                onPick(template);
                close();
              }}
            >
              <span className={styles.itemName}>{template.name}</span>
              {template.attachments.length > 0 && (
                <span
                  className={styles.itemFiles}
                  title={template.attachments
                    .map((a) => `${a.filename} (${fileSizeText(a.size)})`)
                    .join(', ')}
                >
                  <IconAttach size={14} />
                  {template.attachments.length}
                </span>
              )}
              {templatePreview(template.bodyHtml) !== '' && (
                <span className={styles.itemPreview}>{templatePreview(template.bodyHtml)}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <MenuSeparator />
      <MenuItem onClick={onSaveCurrent}>Сохранить как шаблон</MenuItem>
      {/*
        Ссылка, а не пункт-переход: настройки — другой каркас страницы,
        и открывать их поверх недописанного письма нельзя. Новая вкладка
        оставляет письмо на месте.
      */}
      <a
        className={styles.manage}
        href="/settings/templates"
        target="_blank"
        rel="noreferrer"
        role="menuitem"
        onClick={close}
      >
        <IconSettings size={16} />
        Управление шаблонами
      </a>
    </div>
  );
}

export interface SaveTemplateDialogProps {
  /** Что попадёт в шаблон — показывается человеку до сохранения. */
  subject: string;
  attachmentCount: number;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onSubmit(name: string, withAttachments: boolean): void;
}

/**
 * «Сохранить как шаблон».
 *
 * Спрашивается ровно одно — название. Тема, текст и вложения берутся из
 * письма, которое человек прямо сейчас написал, и перечисляются здесь же:
 * шаблон, содержимое которого выяснится только при вставке, пришлось бы
 * проверять вставкой.
 */
export function SaveTemplateDialog({
  subject,
  attachmentCount,
  busy,
  error,
  onClose,
  onSubmit,
}: SaveTemplateDialogProps) {
  // Название по умолчанию — тема письма: чаще всего оно и подходит,
  // а исправить его в открытом поле дешевле, чем придумывать с нуля.
  const [name, setName] = useState(subject.trim());
  const [withAttachments, setWithAttachments] = useState(true);
  const trimmed = name.trim();

  return (
    <Modal
      title="Сохранить как шаблон"
      onClose={onClose}
      className={styles.dialog}
      footer={
        <>
          <Button disabled={trimmed === '' || busy} onClick={() => onSubmit(trimmed, withAttachments)}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          <Button mode="secondary" disabled={busy} onClick={onClose}>
            Отменить
          </Button>
        </>
      }
    >
      <TextField
        label="Название шаблона"
        autoFocus
        value={name}
        maxLength={120}
        placeholder="Например, «Ответ о сроках»"
        wrapperClassName={styles.dialogField}
        onChange={(e) => setName(e.target.value)}
        error={error}
      />

      <p className={styles.dialogNote}>
        В шаблон попадут тема и текст письма. Получатели — нет: шаблон вставляют в разные письма,
        и запомнить адрес значило бы однажды отправить не тому.
      </p>

      {attachmentCount > 0 && (
        <div className={styles.dialogCheck}>
          <Checkbox
            label={`Сохранить вложения (${String(attachmentCount)})`}
            checked={withAttachments}
            onChange={(e) => setWithAttachments(e.target.checked)}
          />
          {/*
            Копия файлов уходит в шаблон и живёт там столько же, сколько сам
            шаблон, — про это стоит сказать: человек вправе знать, что прайс
            теперь хранится дважды, а не ссылкой на письмо.
          */}
          <p className={styles.dialogCheckNote}>
            {withAttachments
              ? 'Копии файлов сохранятся вместе с шаблоном и будут прикрепляться при каждой вставке.'
              : 'Шаблон сохранится без файлов — вставится только тема и текст.'}
          </p>
        </div>
      )}
    </Modal>
  );
}
