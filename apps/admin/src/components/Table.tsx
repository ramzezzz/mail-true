/** Оболочка плотной таблицы: прокрутка по горизонтали, липкая шапка. */
import type { ReactNode } from 'react';
import { cx } from '@web/lib/cx';
import styles from './Table.module.css';

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className={styles.wrap}>{children}</div>;
}

export function Table({ children }: { children: ReactNode }) {
  return <table className={styles.table}>{children}</table>;
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td className={styles.empty} colSpan={colSpan}>
        {children}
      </td>
    </tr>
  );
}

export const tableStyles = styles;
export { cx };
