/**
 * Созвездие на фоне входа: точки, которые тянутся линиями друг к другу и к
 * курсору. Считает и рисует всё этот файл, React-обёртка рядом только
 * подключает его к окну.
 *
 * Почему логика вынесена из компонента: у неё три свойства, которые нужно
 * проверять, а не надеяться на них, — устойчивость к холсту без
 * рисования, число точек от площади окна и неподвижный кадр при
 * выключенном движении. Для проверки хватает поддельного холста, DOM не нужен.
 */
import { DOT_ALPHA, dotRgbChannels } from './loginPalette';

/** Ближе этого расстояния две точки соединяются линией. */
const LINK_DISTANCE = 130;
/** Ближе этого расстояния точка тянется линией к курсору. */
const MOUSE_DISTANCE = 180;
/** Одна точка примерно на столько точек площади. */
export const AREA_PER_DOT = 16000;
export const MIN_DOTS = 30;
export const MAX_DOTS = 110;

/** Часть холста, которая нужна для рисования созвездия. */
export type PaintLike = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'clearRect'
  | 'beginPath'
  | 'arc'
  | 'fill'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
>;

/** Часть холста, которая нужна для его настройки. */
export interface CanvasLike {
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  getContext: (id: '2d') => PaintLike | null;
}

/** Всё, что созвездие берёт из окружения. В проверках подменяется целиком. */
export interface ConstellationHost {
  /** Ширина окна — запасная, если холст ещё не разложен по странице. */
  viewportWidth: number;
  viewportHeight: number;
  /** Плотность точек экрана. */
  pixelRatio: number;
  /** Человек попросил не двигать картинку. */
  reduceMotion: boolean;
  requestFrame: (run: () => void) => number;
  cancelFrame: (id: number) => void;
  random: () => number;
}

export interface Constellation {
  /** Пересчитать размеры и заново разбросать точки (окно изменили). */
  resize: () => void;
  /** Курсор над страницей. */
  pointTo: (x: number, y: number) => void;
  /** Курсор ушёл. */
  forgetPointer: () => void;
  /** Отменить кадры. */
  stop: () => void;
}

interface Dot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/**
 * Сколько точек рисовать на окне такого размера.
 *
 * Именно от площади, а не постоянным числом: восемьдесят точек на телефоне —
 * это впустую потраченная батарея, а на большом экране их не хватает.
 */
export function dotCount(width: number, height: number): number {
  const wanted = Math.round((width * height) / AREA_PER_DOT);
  return Math.max(MIN_DOTS, Math.min(MAX_DOTS, wanted));
}

/**
 * Запустить созвездие. Возвращает null, если рисовать нечем: холст — украшение,
 * и его отсутствие не должно мешать войти в панель.
 *
 * `getContext` не только возвращает null, но и умеет бросать: так ведёт себя
 * среда без поддержки холста и браузер с запретом на рисование. Без try
 * страница входа падала бы целиком — из-за фона.
 */
export function startConstellation(canvas: CanvasLike, host: ConstellationHost): Constellation | null {
  let paint: PaintLike | null = null;
  try {
    paint = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (!paint) return null;
  const ctx = paint;

  const rgb = dotRgbChannels();
  // Плотность ограничиваем двойной: на экране с большим множителем холст
  // вчетверо больше по площади, а разницы глазом почти не видно.
  const dpr = Math.min(host.pixelRatio || 1, 2);
  const dots: Dot[] = [];
  const mouse = { x: -9999, y: -9999, active: false };
  let width = 0;
  let height = 0;
  let frameId = 0;
  let stopped = false;

  const measure = (): void => {
    width = canvas.clientWidth || host.viewportWidth;
    height = canvas.clientHeight || host.viewportHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const seed = (): void => {
    const count = dotCount(width, height);
    dots.length = 0;
    for (let i = 0; i < count; i += 1) {
      dots.push({
        x: host.random() * width,
        y: host.random() * height,
        vx: (host.random() - 0.5) * 0.28,
        vy: (host.random() - 0.5) * 0.28,
        r: host.random() * 1.6 + 0.6,
      });
    }
  };

  const draw = (): void => {
    if (stopped) return;
    ctx.clearRect(0, 0, width, height);

    for (const d of dots) {
      if (!host.reduceMotion) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < 0 || d.x > width) d.vx *= -1;
        if (d.y < 0 || d.y > height) d.vy *= -1;
      }
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb},${String(DOT_ALPHA)})`;
      ctx.fill();
    }

    for (let i = 0; i < dots.length; i += 1) {
      const a = dots[i]!;
      for (let j = i + 1; j < dots.length; j += 1) {
        const b = dots[j]!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist >= LINK_DISTANCE) continue;
        ctx.strokeStyle = `rgba(${rgb},${String(0.18 * (1 - dist / LINK_DISTANCE))})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (mouse.active) {
        const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y);
        if (dm < MOUSE_DISTANCE) {
          ctx.strokeStyle = `rgba(${rgb},${String(0.5 * (1 - dm / MOUSE_DISTANCE))})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }
    }

    if (mouse.active) {
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb},0.95)`;
      ctx.fill();
    }

    // При выключенном движении цикла кадров нет — остаётся один неподвижный
    // кадр. Не пустой фон: человеку, которому мешает движение, картинка
    // нужна не меньше.
    if (!host.reduceMotion) frameId = host.requestFrame(draw);
  };

  measure();
  seed();
  draw();

  return {
    resize: () => {
      measure();
      seed();
      if (host.reduceMotion) draw();
    },
    pointTo: (x, y) => {
      mouse.x = x;
      mouse.y = y;
      mouse.active = true;
      // Кадров нет — перерисовываем сами, иначе линии к курсору при
      // выключенном движении не появлялись бы вовсе.
      if (host.reduceMotion) draw();
    },
    forgetPointer: () => {
      mouse.active = false;
      mouse.x = -9999;
      mouse.y = -9999;
      if (host.reduceMotion) draw();
    },
    stop: () => {
      stopped = true;
      host.cancelFrame(frameId);
    },
  };
}
