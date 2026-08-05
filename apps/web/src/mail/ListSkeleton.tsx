/**
 * Скелетоны списка писем — вместо пустого экрана и одинокого спиннера.
 *
 * Геометрия повторяет настоящую строку (48px, компактный режим 40px):
 * колонка непрочитанного, аватар 32×32, отправитель 22%, тема и дата.
 * Совпадение размеров важнее анимации: когда придут данные, содержимое
 * встанет на те же места и список не «прыгнет».
 */

import { useUiStore } from '../app/store';
import { cx } from '../lib/cx';
import styles from './ListSkeleton.module.css';

export interface ListSkeletonProps {
  /** Сколько строк нарисовать. По умолчанию — экран средней высоты. */
  rows?: number;
}

export function ListSkeleton({ rows = 12 }: ListSkeletonProps) {
  const compact = useUiStore((s) => s.compactList);
  return (
    <div
      className={cx(styles.list, compact && styles.compact)}
      aria-busy="true"
      aria-label="Загрузка писем"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row} aria-hidden="true">
          <span className={styles.avatar} />
          <span className={styles.correspondent} />
          <span
            className={styles.subject}
            /* Разная ширина строк — иначе блок читается как таблица, а не
               как список писем. Ширина детерминированная, без случайных
               чисел: скелетон не должен меняться между отрисовками. */
            style={{ width: `${40 + ((i * 37) % 45)}%` }}
          />
          <span className={styles.date} />
        </div>
      ))}
    </div>
  );
}
