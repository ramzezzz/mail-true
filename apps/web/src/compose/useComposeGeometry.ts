/**
 * Жесты окна написания: перетаскивание за шапку и растягивание за уголки.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ДВИЖЕНИЕ ИДЁТ МИМО REACT
 * ------------------------------------------------------------------
 * Пока указатель не отпущен, положение пишется прямо в стиль элемента, а в
 * общее состояние уходит только итог. Окно написания — тяжёлый компонент:
 * редактор письма, список вложений, подписи, панель ИИ. Перерисовывать его
 * на каждое движение мыши (а это до сотни событий в секунду) значит получить
 * рывки ровно там, где нужна плавность.
 *
 * Итог всё равно попадает в общее состояние — иначе свёрнутое окно, которое
 * React размонтирует, вернулось бы обратно в угол и прежнего размера.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useUiStore } from '../app/store';
import { useMediaQuery } from '../lib/useMediaQuery';
import {
  canFloat,
  fitGeometry,
  moveGeometry,
  resizeGeometry,
  FREE_LAYOUT_QUERY,
  type ComposeGeometry,
  type ResizeCorner,
} from './windowGeometry';

/** Курсор на время жеста — свой для каждого уголка. */
const CURSORS: Record<ResizeCorner, string> = {
  nw: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  se: 'nwse-resize',
};

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Раскладка окна и обработчики жестов.
 *
 * @param id номер окна — под ним запоминается положение
 * @param geometry запомненное положение (`null` — окно стоит в углу каскадом)
 * @param enabled жесты вообще применимы: окно не свёрнуто и не развёрнуто
 *   на весь экран
 */
export function useComposeGeometry(id: number, geometry: ComposeGeometry | null, enabled: boolean) {
  const setGeometry = useUiStore((s) => s.setComposeGeometry);
  const ref = useRef<HTMLElement | null>(null);

  /*
   * На телефоне окно занимает экран целиком — так велит правило из CSS, и это
   * привычное поведение почты. Встроенный стиль сильнее любого правила, так
   * что запомненное положение туда пускать нельзя: окно осталось бы висеть
   * посреди экрана обрезком в 600 пикселей.
   */
  const floating = useMediaQuery(FREE_LAYOUT_QUERY);

  /**
   * Окно, поставленное у правого края широкого экрана, на узком оказалось бы
   * целиком за его пределами: браузер уменьшили, окно поймать нечем. Поэтому
   * после каждого изменения размера экрана положение подгоняется обратно.
   */
  useEffect(() => {
    if (!geometry) return;
    const onResize = () => {
      const size = viewport();
      // Узкий экран рисует окно во весь экран правилом из CSS — запомненное
      // положение там только мешало бы.
      if (!canFloat(size)) return;
      const fitted = fitGeometry(geometry, size);
      if (
        fitted.left !== geometry.left ||
        fitted.top !== geometry.top ||
        fitted.width !== geometry.width ||
        fitted.height !== geometry.height
      ) {
        setGeometry(id, fitted);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [geometry, id, setGeometry]);

  /**
   * Начало жеста. `corner === null` — перетаскивание за шапку.
   *
   * Начальная геометрия берётся у самого элемента, когда окно ещё ни разу не
   * двигали: так оно не прыгает под курсором в первый же кадр — жест
   * продолжается ровно оттуда, где окно нарисовано сейчас.
   */
  const startGesture = useCallback(
    (event: ReactPointerEvent, corner: ResizeCorner | null) => {
      const el = ref.current;
      if (!el || !enabled) return;
      // Левая кнопка и касание. Правая кнопка открывает меню браузера, и
      // окно, поехавшее вместе с ним, — это не то, чего от неё ждут.
      if (event.button !== 0) return;
      if (!canFloat(viewport())) return;

      const rect = el.getBoundingClientRect();
      const start: ComposeGeometry = geometry ?? {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      const startX = event.clientX;
      const startY = event.clientY;

      event.preventDefault();
      const target = event.currentTarget as HTMLElement;
      target.setPointerCapture(event.pointerId);

      // Пока тянут, выделение текста только мешает: жест по шапке иначе
      // подсвечивает тему письма, а по уголку — половину окна.
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = corner ? CURSORS[corner] : 'grabbing';
      document.body.style.userSelect = 'none';

      let last = start;
      const apply = (next: ComposeGeometry) => {
        last = next;
        el.style.left = `${next.left}px`;
        el.style.top = `${next.top}px`;
        el.style.width = `${next.width}px`;
        el.style.height = `${next.height}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.maxHeight = 'none';
        el.style.minHeight = '0';
      };

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        apply(
          corner
            ? resizeGeometry(start, corner, dx, dy, viewport())
            : moveGeometry(start, dx, dy, viewport()),
        );
      };

      const onUp = () => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
        setGeometry(id, last);
      };

      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      // Касание прервали системным жестом — сохраняем то, что уже намерили,
      // иначе окно останется сдвинутым в стиле, но забытым в состоянии.
      target.addEventListener('pointercancel', onUp);
    },
    [enabled, geometry, id, setGeometry],
  );

  /** Встроенный стиль окна: только когда его действительно двигали. */
  const style: CSSProperties | null =
    enabled && floating && geometry
      ? {
          left: geometry.left,
          top: geometry.top,
          width: geometry.width,
          height: geometry.height,
          right: 'auto',
          bottom: 'auto',
          maxHeight: 'none',
          minHeight: 0,
        }
      : null;

  return { ref, startGesture, style };
}
