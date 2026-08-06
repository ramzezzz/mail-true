/**
 * Холст с фоном страницы входа.
 *
 * Здесь только связь с окном: сам счёт и рисование живут в constellation.ts.
 * Компонент общий для почты и панели управления — цвета приходят свойством
 * `look`, всё остальное одинаково.
 *
 * Слушатели снимаются, а кадры отменяются при уходе со страницы: оба
 * приложения одностраничные, и забытый цикл кадров крутился бы потом во
 * всех разделах, не рисуя ничего видимого.
 */
import { useEffect, useRef } from 'react';
import { MAIL_LOOK, startConstellation, type ConstellationLook } from './constellation';
import styles from './LoginBackdrop.module.css';

export interface LoginConstellationProps {
  /** Гамма фона. По умолчанию — фирменная синяя гамма почты. */
  look?: ConstellationLook;
}

export function LoginConstellation({ look = MAIL_LOOK }: LoginConstellationProps = {}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // Цвета читаем через ссылку: смена гаммы на живой странице не случается,
  // а без неё эффект пришлось бы перезапускать на каждой отрисовке.
  const lookRef = useRef(look);
  lookRef.current = look;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const sky = startConstellation(
      canvas,
      {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pixelRatio: window.devicePixelRatio || 1,
        /*
         * `matchMedia` есть не везде: в среде проверок его может не быть
         * вовсе. Фон — украшение, и падать из-за него страница входа не
         * должна. Нет ответа — считаем, что движение разрешено: так ведёт
         * себя и сам браузер по умолчанию.
         */
        reduceMotion:
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        requestFrame: (run) => requestAnimationFrame(run),
        cancelFrame: (id) => {
          cancelAnimationFrame(id);
        },
        random: () => Math.random(),
      },
      lookRef.current,
    );
    if (!sky) return;

    const onMove = (e: PointerEvent): void => {
      sky.pointTo(e.clientX, e.clientY);
    };
    const onLeave = (): void => {
      sky.forgetPointer();
    };
    const onResize = (): void => {
      sky.resize();
    };
    /*
     * Спрятанная вкладка не должна ничего считать. Браузер и сам не
     * вызывает requestAnimationFrame на скрытой вкладке, но полагаться на
     * это нельзя: во втором окне рядом или в фоновом окне поверх другого
     * кадры продолжают идти, а рисуем мы всё равно в никуда.
     */
    const onVisibility = (): void => {
      sky.setVisible(!document.hidden);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      sky.stop();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={ref} className={styles.fx} aria-hidden="true" />;
}
