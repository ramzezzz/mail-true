/**
 * Опись отправленного — что именно ушло наружу вместе с этим ответом.
 *
 * Экран согласия объясняет словами, а здесь показывается факт: адрес
 * сервиса, модель, каждое отправленное поле целиком, что было вырезано
 * до отправки и какие вложения не отправлялись. Обещание и проверка
 * должны стоять рядом, иначе обещание ничего не стоит.
 *
 * Значения выводятся как текст: это содержимое письма, и вставлять его
 * в разметку нельзя.
 *
 * `disclosure === null` означает, что ответ взят из сохранённого ранее
 * и наружу не уходило ничего — тогда вместо описи одна честная строка.
 */

import { useState } from 'react';
import type { AiOutboundDisclosure, AiOutboundField } from '../api/aiTypes';
import { cx } from '../lib/cx';
import { IconChevronDown } from '../mail/icons';
import styles from './OutboundDetails.module.css';

/** Строка для ответа из кэша. */
export const OUTBOUND_CACHED_NOTE = 'Ответ сохранён ранее, наружу ничего не отправлялось.';

/** Сколько символов значения показываем до раскрытия. */
const PREVIEW_CHARS = 220;

export interface OutboundDetailsProps {
  /** null — ответ из кэша: отправки не было, описывать нечего. */
  disclosure: AiOutboundDisclosure | null;
  className?: string | undefined;
}

export function OutboundDetails({ disclosure, className }: OutboundDetailsProps) {
  if (!disclosure) {
    return <div className={cx(styles.cached, className)}>{OUTBOUND_CACHED_NOTE}</div>;
  }

  return (
    <details className={cx(styles.details, className)}>
      <summary className={styles.summary}>
        <span className={styles.summaryIcon}>
          <IconChevronDown size={12} />
        </span>
        Что ушло наружу
        <span className={styles.summaryTotal}>
          {formatNumber(disclosure.totalChars)}{' '}
          {plural(disclosure.totalChars, ['символ', 'символа', 'символов'])}, примерно{' '}
          {formatNumber(disclosure.approxTokens)}{' '}
          {plural(disclosure.approxTokens, ['токен', 'токена', 'токенов'])}
        </span>
      </summary>

      <div className={styles.body}>
        {/* Куда ушло */}
        {disclosure.local ? (
          <p className={styles.local}>
            Модель поднята на этом же сервере — письмо не покидало периметр.
          </p>
        ) : (
          <p className={styles.remote}>
            Это внешний сервис: перечисленное ниже ушло за пределы вашего сервера.
          </p>
        )}

        <div className={styles.rows}>
          <span className={styles.rowKey}>Сервис</span>
          <span className={styles.rowValue}>{disclosure.providerLabel}</span>
          <span className={styles.rowKey}>Адрес</span>
          <span className={styles.rowValue}>{disclosure.endpoint}</span>
          <span className={styles.rowKey}>Модель</span>
          <span className={styles.rowValue}>{disclosure.model}</span>
        </div>

        {/* Что ушло */}
        {disclosure.fields.length > 0 && (
          <div>
            <div className={styles.blockTitle}>Отправлено</div>
            {disclosure.fields.map((field, i) => (
              <FieldRow key={`${field.field}-${i}`} field={field} />
            ))}
          </div>
        )}

        {/* Что вырезано до отправки */}
        {disclosure.removed.length > 0 && (
          <div>
            <div className={styles.blockTitle}>Вырезано до отправки</div>
            <ul className={styles.list}>
              {disclosure.removed.map((part, i) => (
                <li key={`${part.kind}-${i}`}>
                  {part.note} — {formatNumber(part.count)}{' '}
                  {plural(part.count, ['фрагмент', 'фрагмента', 'фрагментов'])},{' '}
                  {formatNumber(part.chars)} {plural(part.chars, ['символ', 'символа', 'символов'])}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Вложения не отправляются никогда */}
        {disclosure.attachmentsExcluded.length > 0 && (
          <div>
            <div className={styles.blockTitle}>
              {plural(disclosure.attachmentsExcluded.length, [
                'Вложение не отправлялось',
                'Вложения не отправлялись',
                'Вложения не отправлялись',
              ])}
            </div>
            <ul className={styles.list}>
              {disclosure.attachmentsExcluded.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.total}>
          Итого отправлено {formatNumber(disclosure.totalChars)}{' '}
          {plural(disclosure.totalChars, ['символ', 'символа', 'символов'])} — примерно{' '}
          {formatNumber(disclosure.approxTokens)}{' '}
          {plural(disclosure.approxTokens, ['токен', 'токена', 'токенов'])}.
        </div>
      </div>
    </details>
  );
}

/** Одно поле запроса: подпись, длина и само значение. */
function FieldRow({ field }: { field: AiOutboundField }) {
  const [expanded, setExpanded] = useState(false);
  const long = field.value.length > PREVIEW_CHARS;
  const shown = long && !expanded ? `${field.value.slice(0, PREVIEW_CHARS)}…` : field.value;

  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{field.label}</span>
        <span className={styles.fieldChars}>
          {formatNumber(field.chars)} {plural(field.chars, ['символ', 'символа', 'символов'])}
        </span>
      </div>
      {/* Текст письма — именно текст, без вставки разметки */}
      <pre className={styles.fieldValue}>{shown}</pre>
      {long && (
        <button
          type="button"
          className={styles.more}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Свернуть' : 'Показать целиком'}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function formatNumber(value: number): string {
  return value.toLocaleString('ru-RU');
}

/** Русское склонение по числу: 1 символ, 2 символа, 5 символов. */
function plural(count: number, forms: [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}
