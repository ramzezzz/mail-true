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
 * Сколько уезжает меню, от которого отказались, мс — столько же длится
 * обратный ход в Dropdown.module.css (--mt-anim-duration-s).
 */
export const MENU_EXIT_MS = 100;

type MenuState = 'closed' | 'open' | 'closing';

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
  const [state, setState] = useState<MenuState>('closed');
  const open = state === 'open';
  const hostRef = useRef<HTMLDivElement>(null);
  /**
   * Выбранный пункт закрывает меню мгновенно: страница уже меняется, и
   * досматривать нечего. А отказ от выбора (Escape, клик мимо, повторное
   * нажатие) уезжает с ходом — тогда видно, что меню именно закрылось.
   */
  const close = useCallback(() => setState('closed'), []);
  const dismiss = useCallback(() => setState((s) => (s === 'open' ? 'closing' : s)), []);
  const toggle = useCallback(() => setState((s) => (s === 'open' ? 'closing' : 'open')), []);

  // Уехавшее меню убирается из разметки — иначе оно осталось бы в обходе Tab
  useEffect(() => {
    if (state !== 'closing') return;
    const timer = setTimeout(() => setState('closed'), MENU_EXIT_MS);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) dismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, dismiss]);

  return (
    <div ref={hostRef} className={cx(styles.host, className)}>
      {trigger({ open, toggle })}
      {state !== 'closed' && (
        <div
          role="menu"
          aria-hidden={state === 'closing' || undefined}
          className={cx(
            styles.menu,
            state === 'closing' && styles.menuClosing,
            align === 'right' && styles.alignRight,
            menuClassName,
          )}
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
