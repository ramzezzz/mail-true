/** Квадратная кнопка-иконка 36×36 (как в шапке и панелях привычных почтовых интерфейсов). */

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import styles from './IconButton.module.css';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Обязательная подпись для доступности (иконка текста не несёт). */
  label: string;
  size?: 's' | 'm';
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'm', active, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={rest.title ?? label}
      className={cx(styles.iconButton, styles[`size_${size}`], active && styles.active, className)}
      {...rest}
    >
      {children}
    </button>
  );
});
