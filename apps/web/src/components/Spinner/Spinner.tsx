/** Спиннер VKUI-образца: дуга, вращающаяся по кругу; цвет — currentColor. */

import { cx } from '../../lib/cx';
import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** Диаметр в пикселях. */
  size?: number;
  className?: string;
  /** Подпись для скринридеров. */
  label?: string;
}

export function Spinner({ size = 24, className, label = 'Загрузка' }: SpinnerProps) {
  const stroke = Math.max(2, Math.round(size / 12));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span role="progressbar" aria-label={label} className={cx(styles.spinner, className)}>
      {/* data-motion="keep" выводит крутилку из-под глобального выключателя
          движения: остановленная, она перестаёт означать «идёт работа» */}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={styles.svg}
        data-motion="keep"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * 0.25} ${c * 0.75}`}
        />
      </svg>
    </span>
  );
}
