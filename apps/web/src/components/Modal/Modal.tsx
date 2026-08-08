/**
 * Модальное окно раздела настроек (образец — «Создание фильтра»,
 * эталонные снимки интерфейса): белая карточка радиусом 16px
 * поверх затемнения, заголовок 24px и крестик справа.
 *
 * Закрывается по Escape и по клику мимо карточки. Пока окно открыто,
 * страница под ним не прокручивается — иначе при длинном списке правил
 * фон уезжает вместе с колесом мыши.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { IconButton } from '../IconButton/IconButton';
import styles from './Modal.module.css';

/**
 * Сколько окно уезжает, мс. Ровно столько же длится обратный ход в
 * Modal.module.css (--mt-anim-duration-m). Само действие уже сделано —
 * закрытие только досматривается, ничего не ждёт.
 */
export const MODAL_EXIT_MS = 200;

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
  const [closing, setClosing] = useState(false);

  /** Запускает обратный ход и сообщает о закрытии, когда он доигран. */
  const requestClose = useCallback(() => setClosing(true), []);

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClose, MODAL_EXIT_MS);
    return () => clearTimeout(timer);
  }, [closing, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [requestClose]);

  // Фокус внутрь окна: иначе Tab уводит в страницу под затемнением
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  return (
    <div
      className={cx(styles.overlay, closing && styles.overlayClosing)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={cardRef}
        className={cx(styles.card, closing && styles.cardClosing, className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <IconButton label="Закрыть" onClick={requestClose} className={styles.close}>
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
