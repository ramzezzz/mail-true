/**
 * Фон страницы входа: точки, которые тянутся линиями друг к другу и к курсору.
 *
 * Перенесено из прототипа `login_page/` на React. Отличия от прототипа:
 *
 *  - всё живёт внутри одного холста и убирается за собой при уходе со
 *    страницы: слушатели снимаются, кадры отменяются. Прототип был отдельной
 *    страницей и мог себе позволить не убираться — у нас это одностраничное
 *    приложение, и оставленный цикл кадров крутился бы и в почте;
 *  - число точек зависит от площади окна: на телефоне восемьдесят точек — это
 *    впустую потраченная батарея, а на большом экране их не хватает;
 *  - при `prefers-reduced-motion` рисуется один неподвижный кадр. Не пустой
 *    фон, а именно кадр: человеку, которому мешает движение, картинка нужна
 *    не меньше.
 */
import { useEffect, useRef } from 'react';
import styles from './LoginBackdrop.module.css';

/** Цвет точек и линий — светло-синий по тёмному фону, см. docs/brand.md. */
const DOT_RGB = '150,190,245';
/** Ближе этого расстояния две точки соединяются линией. */
const LINK_DISTANCE = 130;
/** Ближе этого расстояния точка тянется линией к курсору. */
const MOUSE_DISTANCE = 180;
/** Одна точка примерно на столько точек площади. */
const AREA_PER_DOT = 16000;
const MIN_DOTS = 30;
const MAX_DOTS = 110;

interface Dot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export function LoginConstellation() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    /*
     * Холст — украшение, и его отсутствие не должно мешать войти в почту.
     * `getContext` не только возвращает null, но и умеет бросать: так ведёт
     * себя среда без поддержки холста (в том числе та, в которой идут
     * проверки) и браузер с запретом на рисование. Без этой защиты страница
     * входа падала бы целиком — из-за фона.
     */
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return;
    }
    if (!ctx) return;
    const paint = ctx;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Плотность точек ограничиваем двойной: на экране с большим множителем
    // холст вчетверо больше по площади, а разницы глазом почти не видно.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const dots: Dot[] = [];
    const mouse = { x: -9999, y: -9999, active: false };
    let width = 0;
    let height = 0;
    let frameId = 0;

    const resize = (): void => {
      width = canvas.clientWidth || window.innerWidth;
      height = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      paint.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const seed = (): void => {
      const count = Math.max(MIN_DOTS, Math.min(MAX_DOTS, Math.round((width * height) / AREA_PER_DOT)));
      dots.length = 0;
      for (let i = 0; i < count; i += 1) {
        dots.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.28,
          vy: (Math.random() - 0.5) * 0.28,
          r: Math.random() * 1.6 + 0.6,
        });
      }
    };

    const draw = (): void => {
      paint.clearRect(0, 0, width, height);

      for (const d of dots) {
        if (!reduceMotion) {
          d.x += d.vx;
          d.y += d.vy;
          if (d.x < 0 || d.x > width) d.vx *= -1;
          if (d.y < 0 || d.y > height) d.vy *= -1;
        }
        paint.beginPath();
        paint.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        paint.fillStyle = `rgba(${DOT_RGB},0.75)`;
        paint.fill();
      }

      for (let i = 0; i < dots.length; i += 1) {
        const a = dots[i] as Dot;
        for (let j = i + 1; j < dots.length; j += 1) {
          const b = dots[j] as Dot;
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist >= LINK_DISTANCE) continue;
          paint.strokeStyle = `rgba(${DOT_RGB},${0.18 * (1 - dist / LINK_DISTANCE)})`;
          paint.lineWidth = 1;
          paint.beginPath();
          paint.moveTo(a.x, a.y);
          paint.lineTo(b.x, b.y);
          paint.stroke();
        }
        if (mouse.active) {
          const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y);
          if (dm < MOUSE_DISTANCE) {
            paint.strokeStyle = `rgba(${DOT_RGB},${0.5 * (1 - dm / MOUSE_DISTANCE)})`;
            paint.lineWidth = 1;
            paint.beginPath();
            paint.moveTo(a.x, a.y);
            paint.lineTo(mouse.x, mouse.y);
            paint.stroke();
          }
        }
      }

      if (mouse.active) {
        paint.beginPath();
        paint.arc(mouse.x, mouse.y, 2.4, 0, Math.PI * 2);
        paint.fillStyle = `rgba(${DOT_RGB},0.95)`;
        paint.fill();
      }

      if (!reduceMotion) frameId = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent): void => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.active = true;
      // При выключенном движении цикла кадров нет — перерисовываем сами,
      // иначе линии к курсору не появлялись бы вовсе.
      if (reduceMotion) draw();
    };
    const onLeave = (): void => {
      mouse.active = false;
      mouse.x = -9999;
      mouse.y = -9999;
      if (reduceMotion) draw();
    };
    const onResize = (): void => {
      resize();
      seed();
      if (reduceMotion) draw();
    };

    resize();
    seed();
    draw();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={ref} className={styles.fx} aria-hidden="true" />;
}
