/**
 * Чекбокс по образцу VKUI: 16×16, радиус 4px
 * (--mt-size-check-border-radius), синяя заливка в выбранном состоянии.
 */

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Подпись справа; без неё чекбокс остаётся одиночным квадратом. */
  label?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, ...rest },
  ref,
) {
  return (
    <label className={cx(styles.wrapper, className)}>
      <input ref={ref} type="checkbox" className={styles.input} {...rest} />
      <span className={styles.box} aria-hidden="true">
        <svg className={styles.mark} width="12" height="12" viewBox="0 0 12 12">
          <path
            d="M1.5 6.5 4.5 9.5 10.5 2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {label && <span className={styles.label}>{label}</span>}
    </label>
  );
});
