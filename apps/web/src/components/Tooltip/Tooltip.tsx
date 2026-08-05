/**
 * Тултип на чистом CSS (появление по hover/focus-within).
 * Оформление — токены портальной шапки (--mt-ph-custom-color-tooltip-*).
 */

import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  /** Текст подсказки. */
  text: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
  className?: string;
}

export function Tooltip({ text, placement = 'bottom', children, className }: TooltipProps) {
  return (
    <span className={cx(styles.host, className)}>
      {children}
      <span role="tooltip" className={cx(styles.bubble, styles[placement])}>
        {text}
      </span>
    </span>
  );
}
