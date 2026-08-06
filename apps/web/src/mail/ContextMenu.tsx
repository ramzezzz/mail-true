/**
 * Контекстное меню по правой кнопке: позиционируется в точке клика,
 * закрывается по клику мимо, Escape и прокрутке.
 * Геометрия mail.ru: ширина 301px, пункт 36px.
 */

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { cx } from '../lib/cx';
import { LabelMenu, type LabelTarget } from './LabelMenu';
import { IconLabel } from './icons';
import { useLabelsState } from './useLabels';
import styles from './ContextMenu.module.css';

const CloseContext = createContext<() => void>(() => {});

export interface ContextMenuProps {
  x: number;
  y: number;
  onClose(): void;
  children: ReactNode;
}

export function ContextMenu({ x, y, onClose, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Не даём меню вылезти за края окна
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y, children]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = () => onClose();
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} role="menu" className={styles.menu} style={pos}>
      <CloseContext.Provider value={onClose}>{children}</CloseContext.Provider>
    </div>
  );
}

export interface ContextMenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  before?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  /** Не закрывать меню после клика (переход в подменю). */
  keepOpen?: boolean;
}

export function ContextMenuItem({
  before,
  hint,
  danger,
  keepOpen,
  className,
  children,
  onClick,
  ...rest
}: ContextMenuItemProps) {
  const close = useContext(CloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={cx(styles.item, danger && styles.danger, className)}
      onClick={(e) => {
        onClick?.(e);
        if (!keepOpen) close();
      }}
      {...rest}
    >
      {before && <span className={styles.itemIcon}>{before}</span>}
      <span className={styles.itemText}>{children}</span>
      {hint != null && <span className={styles.itemHint}>{hint}</span>}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className={styles.separator} role="separator" />;
}

/**
 * Пункт «Метки» со списком, раскрывающимся ПРЯМО В МЕНЮ.
 *
 * Раскрытие на месте, а не переход в отдельный вид меню (как у «В папку» и
 * «Отложить»), потому что метки ставят пачками: «оплатить» и «спросить у
 * юриста» на одно письмо. Переход туда-обратно за каждой меткой означал бы
 * два лишних нажатия на каждую.
 *
 * Пункта нет вовсе, пока сервер не сказал, что справочник меток доступен, —
 * общее правило продукта: кнопка появляется вместе с поведением.
 */
export function ContextMenuLabels({ messages }: { messages: readonly LabelTarget[] }) {
  const { available } = useLabelsState();
  const [open, setOpen] = useState(false);
  if (!available) return null;
  return (
    <>
      <ContextMenuItem
        before={<IconLabel />}
        keepOpen
        aria-expanded={open}
        hint={open ? '▴' : '▾'}
        onClick={() => setOpen((v) => !v)}
      >
        Метки
      </ContextMenuItem>
      {open && <LabelMenu messages={messages} />}
    </>
  );
}
