/**
 * Жест «назад»: провести пальцем от левого края вправо.
 *
 * Ровно так уходят назад во всех телефонных приложениях, и открытое письмо —
 * не исключение: кнопка «К списку» стоит в верхнем левом углу, куда большим
 * пальцем не дотянуться. Кнопка при этом остаётся на месте — жест её не
 * заменяет, а дополняет.
 *
 * Начало обязано быть у самого края экрана. Иначе жест отбирал бы
 * горизонтальную прокрутку у широких писем: таблицы в рассылках шире
 * телефона, и их листают именно так.
 */

import { useRef, type TouchEvent as ReactTouchEvent } from 'react';
import { SWIPE_TRIGGER, isHorizontalSwipe } from './gestures';

/** Насколько близко к левому краю должен начаться жест. */
export const EDGE_WIDTH = 40;

export interface SwipeBackHandlers {
  onTouchStart(e: ReactTouchEvent): void;
  onTouchMove(e: ReactTouchEvent): void;
  onTouchEnd(e: ReactTouchEvent): void;
  onTouchCancel(): void;
}

/** Довёл ли жест до срабатывания: от края, вправо и достаточно далеко. */
export function swipeBackDone(startX: number, dx: number, dy: number): boolean {
  if (startX > EDGE_WIDTH) return false;
  if (!isHorizontalSwipe(dx, dy)) return false;
  return dx >= SWIPE_TRIGGER;
}

export function useSwipeBack(onBack: () => void): SwipeBackHandlers {
  const from = useRef<{ x: number; y: number } | null>(null);
  const last = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  return {
    onTouchStart(e) {
      const point = e.touches[0];
      if (!point || point.clientX > EDGE_WIDTH) {
        from.current = null;
        return;
      }
      from.current = { x: point.clientX, y: point.clientY };
      last.current = { dx: 0, dy: 0 };
    },
    onTouchMove(e) {
      const start = from.current;
      const point = e.touches[0];
      if (!start || !point) return;
      last.current = { dx: point.clientX - start.x, dy: point.clientY - start.y };
    },
    onTouchEnd() {
      const start = from.current;
      from.current = null;
      if (!start) return;
      // Недоведённый жест не делает ничего — это и есть его отмена
      if (swipeBackDone(start.x, last.current.dx, last.current.dy)) onBack();
    },
    onTouchCancel() {
      from.current = null;
    },
  };
}
