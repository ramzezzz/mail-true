/**
 * Модальное окно раздела настроек (образец — «Создание фильтра»,
 * research/mailru/06-filter-editor.png): белая карточка радиусом 16px
 * поверх затемнения, заголовок 24px и крестик справа.
 *
 * Закрывается по Escape и по клику мимо карточки. Пока окно открыто,
 * страница под ним не прокручивается — иначе при длинном списке правил
 * фон уезжает вместе с колесом мыши.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { IconButton } from '../IconButton/IconButton';
import styles from './Modal.module.css';

export interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  /** Нижняя панель — обычно «Сохранить» и «Отменить». */
  footer?: ReactNode;
  /** Класс карточки: ширина окна задаётся вызывающей стороной. */
  className?: string | undefined;
}

export function Modal({ title, onClose, children, footer, className }: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // Фокус внутрь окна: иначе Tab уводит в страницу под затемнением
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={cx(styles.card, className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <IconButton label="Закрыть" onClick={onClose} className={styles.close}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M5.3 4.05a.9.9 0 0 0-1.25 1.28L8.72 10l-4.67 4.67a.9.9 0 1 0 1.28 1.28L10 11.28l4.67 4.67a.9.9 0 0 0 1.28-1.28L11.28 10l4.67-4.67a.9.9 0 0 0-1.28-1.28L10 8.72 5.33 4.05Z"
                fill="currentColor"
              />
            </svg>
          </IconButton>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
