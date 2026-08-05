/**
 * Переключатель по образцу VKUI Switch: дорожка 34×20, накладка 16×16
 * (--mt-size-switch-*). Внутри — настоящий input[type=checkbox], поэтому
 * работают клавиатура, форма и экранные читалки без единого aria-костыля.
 * Им включают и выключают правила фильтрации, не удаляя их.
 */

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import styles from './Switch.module.css';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Подпись справа от переключателя. */
  label?: string;
  /** Пояснение под подписью — мелким серым. */
  description?: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, description, className, ...rest },
  ref,
) {
  return (
    <label className={cx(styles.wrapper, rest.disabled && styles.disabled, className)}>
      <input ref={ref} type="checkbox" className={styles.input} {...rest} />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {(label || description) && (
        <span className={styles.text}>
          {label && <span className={styles.label}>{label}</span>}
          {description && <span className={styles.description}>{description}</span>}
        </span>
      )}
    </label>
  );
});
