/**
 * Окно «Сохранить запрос».
 *
 * Спрашивает только имя. Строку запроса окно не даёт править намеренно:
 * правится она там же, где набирается, — в поисковой строке, и результат
 * человек видит сразу. Вторая форма ввода того же самого означала бы, что
 * сохранить можно запрос, которого человек не видел в работе.
 *
 * Имя предлагается сразу — из самого запроса. Пустое поле в такой форме
 * заставляет придумывать название на ровном месте, и половина запросов
 * остаётся несохранённой именно из-за этого.
 */

import { useState, type FormEvent } from 'react';
import { parseSearch } from '@mail-true/shared';
import { Button, Modal, TextField } from '../components';
import { MAX_SAVED_SEARCH_NAME_LENGTH } from './savedSearchLimits';
import styles from './SaveSearchDialog.module.css';

export interface SaveSearchDialogProps {
  query: string;
  includeJunk: boolean;
  busy: boolean;
  onSave(name: string): void;
  onClose(): void;
}

/**
 * Имя по умолчанию: условия пересказанные словами.
 *
 * Не сама строка запроса (`от:волкова есть:вложение` — это запись условий,
 * а не название) и не первое слово («договор» одинаково подойдёт трём
 * разным запросам, и различить их в колонке будет нельзя).
 *
 * Даты и размеры в имя не идут намеренно: они длинные, а видны и так —
 * строка запроса показана прямо под полем и в подсказке к пункту колонки.
 */
export function suggestSavedSearchName(query: string): string {
  const q = parseSearch(query);
  const parts: string[] = [];
  if (q.text) parts.push(q.text);
  if (q.from) parts.push(`от ${q.from}`);
  if (q.to) parts.push(`кому ${q.to}`);
  if (q.cc) parts.push(`копия ${q.cc}`);
  if (q.subject) parts.push(`тема ${q.subject}`);
  if (q.folder) parts.push(`в папке ${q.folder}`);
  if (q.filename) parts.push(`файл ${q.filename}`);
  else if (q.hasAttachment) parts.push('с вложением');
  if (q.seen === false) parts.push('непрочитанные');
  if (q.seen === true) parts.push('прочитанные');
  if (q.flagged === true) parts.push('важные');
  const name = parts.join(', ').slice(0, MAX_SAVED_SEARCH_NAME_LENGTH).trim();
  // С заглавной буквы: это название в колонке, а не продолжение фразы.
  return name === '' ? '' : name[0]?.toUpperCase() + name.slice(1);
}

export function SaveSearchDialog({
  query,
  includeJunk,
  busy,
  onSave,
  onClose,
}: SaveSearchDialogProps) {
  const [name, setName] = useState(() => suggestSavedSearchName(query));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    onSave(trimmed);
  };

  return (
    <Modal
      title="Сохранить запрос"
      onClose={onClose}
      className={styles.card}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отменить
          </Button>
          <Button onClick={submit} disabled={name.trim() === '' || busy}>
            Сохранить
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <TextField
          label="Название"
          value={name}
          autoFocus
          maxLength={MAX_SAVED_SEARCH_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
        />
        {/* Что именно сохраняется — показано целиком, а не пересказано */}
        <div className={styles.preview}>
          <span className={styles.previewLabel}>Запрос</span>
          <code className={styles.previewValue}>{query}</code>
        </div>
        {includeJunk && (
          <p className={styles.note}>Запрос сохранится вместе с поиском в спаме и корзине.</p>
        )}
      </form>
    </Modal>
  );
}
