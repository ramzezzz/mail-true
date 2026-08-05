/**
 * Кнопка по образцу VKUI Button / мейлового button2.
 * Все цвета — из токенов, ни одного зашитого значения.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Button.module.css';

export type ButtonMode = 'primary' | 'secondary' | 'outline' | 'tertiary';
export type ButtonSize = 's' | 'm' | 'l';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  mode?: ButtonMode;
  size?: ButtonSize;
  /** Иконка слева от текста. */
  before?: ReactNode;
  /** Иконка справа от текста. */
  after?: ReactNode;
  /** Растянуть на всю ширину контейнера. */
  stretched?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { mode = 'primary', size = 'm', before, after, stretched, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        styles.button,
        styles[`mode_${mode}`],
        styles[`size_${size}`],
        stretched && styles.stretched,
        className,
      )}
      {...rest}
    >
      {before && <span className={styles.icon}>{before}</span>}
      {children != null && <span className={styles.text}>{children}</span>}
      {after && <span className={styles.icon}>{after}</span>}
    </button>
  );
});
