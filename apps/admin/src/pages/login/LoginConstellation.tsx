/**
 * Холст с созвездием на фоне входа в панель.
 *
 * Здесь только связь с окном: сам счёт и рисование живут в constellation.ts.
 * Слушатели снимаются, а кадры отменяются при уходе со страницы — панель
 * управления одностраничная, и забытый цикл кадров крутился бы потом
 * во всех разделах.
 */
import { useEffect, useRef } from 'react';
import { startConstellation } from './constellation';
import styles from './LoginBackdrop.module.css';

export function LoginConstellation() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const sky = startConstellation(canvas, {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pixelRatio: window.devicePixelRatio || 1,
      reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      requestFrame: (run) => requestAnimationFrame(run),
      cancelFrame: (id) => {
        cancelAnimationFrame(id);
      },
      random: () => Math.random(),
    });
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

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', onResize);

    return () => {
      sky.stop();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={ref} className={styles.fx} aria-hidden="true" />;
}
