/**
 * Выпадающее меню (по образцу .compose-dropdown / dropdown mail.ru).
 * Триггер задаётся рендер-функцией, пункты — детьми (MenuItem).
 * Закрывается по клику мимо и по Escape.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { cx } from '../../lib/cx';
import styles from './Dropdown.module.css';

const CloseContext = createContext<() => void>(() => {});

/**
 * Закрыть меню изнутри — для пунктов, которые нарисованы не через
 * `MenuItem` (тот закрывается сам). Без этого собственная строка меню
 * оставляла бы его открытым поверх уже изменившейся страницы.
 */
export function useDropdownClose(): () => void {
  return useContext(CloseContext);
}

export interface DropdownProps {
  /** Рендер триггера; open — текущее состояние. */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  /** Содержимое меню — обычно набор MenuItem. */
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string | undefined;
  /** Класс контейнера меню (например, чтобы задать точную ширину). */
  menuClassName?: string | undefined;
}

export function Dropdown({
  trigger,
  children,
  align = 'left',
  className,
  menuClassName,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return (
    <div ref={hostRef} className={cx(styles.host, className)}>
      {trigger({ open, toggle })}
      {open && (
        <div
          role="menu"
          className={cx(styles.menu, align === 'right' && styles.alignRight, menuClassName)}
        >
          <CloseContext.Provider value={close}>{children}</CloseContext.Provider>
        </div>
      )}
    </div>
  );
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  before?: ReactNode;
  /** Красный «опасный» пункт (удалить и т. п.). */
  danger?: boolean;
  /** Подпись справа — обычно горячая клавиша («Shift+J»). */
  hint?: ReactNode;
}

export function MenuItem({
  before,
  danger,
  hint,
  className,
  children,
  onClick,
  ...rest
}: MenuItemProps) {
  const close = useContext(CloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={cx(styles.item, danger && styles.danger, className)}
      onClick={(e) => {
        onClick?.(e);
        close();
      }}
      {...rest}
    >
      {before && <span className={styles.itemIcon}>{before}</span>}
      <span className={styles.itemText}>{children}</span>
      {hint != null && <span className={styles.itemHint}>{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className={styles.separator} role="separator" />;
}
