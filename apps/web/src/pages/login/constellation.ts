/**
 * Фон страницы входа: три слоя на одном холсте.
 *
 *   1) звёзды — много мелких точек, которые медленно разгораются и гаснут;
 *   2) паутина — точки покрупнее, соединённые линиями друг с другом и с
 *      курсором (это единственное, на что фон отзывается);
 *   3) волновая сетка в нижнем правом углу — редкие точки по синусоиде.
 *
 * Считает и рисует всё этот файл, React-обёртка рядом только подключает его
 * к окну. Модуль общий для почты и панели управления: цвета приходят
 * снаружи (`ConstellationLook`), поэтому одна и та же сцена показывается в
 * фирменном синем на входе в почту и в графите с бирюзой на входе в панель.
 * Две копии одного холста рано или поздно разъезжаются — а чинить их потом
 * приходится дважды.
 *
 * Почему логика вынесена из компонента: у неё есть свойства, которые нужно
 * проверять, а не надеяться на них, — устойчивость к холсту без рисования,
 * число точек от площади окна, неподвижный кадр при выключенном движении и
 * остановка на невидимой вкладке. Для проверки хватает поддельного холста,
 * DOM не нужен.
 */

/** Ближе этого расстояния две точки паутины соединяются линией. */
const LINK_DISTANCE = 132;
/** Ближе этого расстояния точка паутины тянется линией к курсору. */
const MOUSE_DISTANCE = 185;

/** Одна точка паутины примерно на столько точек площади. */
export const AREA_PER_DOT = 16000;
export const MIN_DOTS = 30;
export const MAX_DOTS = 110;

/**
 * Одна звезда примерно на столько точек площади.
 *
 * Звёзды заметно дешевле точек паутины: у паутины на каждый кадр квадрат от
 * числа точек (все пары проверяются на близость), у звезды — один круг.
 * Поэтому их и можно позволить себе втрое больше.
 */
export const AREA_PER_STAR = 6800;
export const MIN_STARS = 60;
export const MAX_STARS = 220;

/** Часть холста, которая нужна для рисования. */
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

/** Всё, что фон берёт из окружения. В проверках подменяется целиком. */
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

/**
 * Цвета фона — каналами «R,G,B», потому что холст рисует через rgba(),
 * а не через hex.
 */
export interface ConstellationLook {
  /** Точки и линии паутины. */
  web: string;
  /** Звёзды. */
  star: string;
  /** Волновая сетка в углу. */
  mesh: string;
}

/** Гамма почты: фирменный светло-синий по тёмно-синему небу. */
export const MAIL_LOOK: ConstellationLook = {
  web: '150,190,245',
  star: '208,228,255',
  mesh: '120,170,240',
};

export interface Constellation {
  /** Пересчитать размеры и заново разбросать точки (окно изменили). */
  resize: () => void;
  /** Курсор над страницей. */
  pointTo: (x: number, y: number) => void;
  /** Курсор ушёл. */
  forgetPointer: () => void;
  /**
   * Вкладку показали или спрятали. На спрятанной кадры не запрашиваются
   * вовсе: браузер их всё равно не покажет, а батарею они тратят.
   */
  setVisible: (visible: boolean) => void;
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

interface Star {
  x: number;
  y: number;
  r: number;
  /** Нижняя граница яркости. */
  base: number;
  /** Скорость мерцания. */
  speed: number;
  /** Сдвиг фазы, чтобы звёзды не мигали в такт. */
  phase: number;
  dx: number;
  dy: number;
}

/**
 * Сколько точек паутины рисовать на окне такого размера.
 *
 * Именно от площади, а не постоянным числом: восемьдесят точек на телефоне —
 * это впустую потраченная батарея, а на большом экране их не хватает.
 */
export function dotCount(width: number, height: number): number {
  const wanted = Math.round((width * height) / AREA_PER_DOT);
  return Math.max(MIN_DOTS, Math.min(MAX_DOTS, wanted));
}

/** Сколько звёзд рисовать. Та же мера, что и для паутины, — от площади. */
export function starCount(width: number, height: number): number {
  const wanted = Math.round((width * height) / AREA_PER_STAR);
  return Math.max(MIN_STARS, Math.min(MAX_STARS, wanted));
}

/**
 * Запустить фон. Возвращает null, если рисовать нечем: холст — украшение,
 * и его отсутствие не должно мешать войти.
 *
 * `getContext` не только возвращает null, но и умеет бросать: так ведёт себя
 * среда без поддержки холста и браузер с запретом на рисование. Без try
 * страница входа падала бы целиком — из-за фона.
 */
export function startConstellation(
  canvas: CanvasLike,
  host: ConstellationHost,
  look: ConstellationLook = MAIL_LOOK,
): Constellation | null {
  let paint: PaintLike | null = null;
  try {
    paint = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (!paint) return null;
  const ctx = paint;

  // Плотность ограничиваем двойной: на экране с большим множителем холст
  // вчетверо больше по площади, а разницы глазом почти не видно.
  const dpr = Math.min(host.pixelRatio || 1, 2);
  const dots: Dot[] = [];
  const stars: Star[] = [];
  const mouse = { x: -9999, y: -9999, active: false };
  let width = 0;
  let height = 0;
  let frameId = 0;
  let stopped = false;
  let visible = true;
  /** Время сцены в секундах: мерцание звёзд и бег волны считаются от него. */
  let clock = 0;

  const measure = (): void => {
    width = canvas.clientWidth || host.viewportWidth;
    height = canvas.clientHeight || host.viewportHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const seed = (): void => {
    dots.length = 0;
    for (let i = 0, n = dotCount(width, height); i < n; i += 1) {
      dots.push({
        x: host.random() * width,
        y: host.random() * height,
        vx: (host.random() - 0.5) * 0.28,
        vy: (host.random() - 0.5) * 0.28,
        r: host.random() * 1.5 + 0.7,
      });
    }
    stars.length = 0;
    for (let i = 0, n = starCount(width, height); i < n; i += 1) {
      stars.push({
        x: host.random() * width,
        y: host.random() * height,
        r: host.random() * 1.7 + 0.55,
        base: host.random() * 0.45 + 0.55,
        speed: host.random() * 0.9 + 0.2,
        phase: host.random() * Math.PI * 2,
        dx: (host.random() - 0.5) * 0.04,
        dy: (host.random() - 0.5) * 0.04,
      });
    }
  };

  /** Звёзды: мелкие точки переменной яркости, у крупных — мягкий ореол. */
  const drawStars = (): void => {
    for (const s of stars) {
      if (!host.reduceMotion) {
        s.x += s.dx;
        s.y += s.dy;
        // Звезда уходит за край и появляется с другой стороны: отражать её,
        // как точку паутины, незачем — небо однородно.
        if (s.x < 0) s.x += width;
        else if (s.x > width) s.x -= width;
        if (s.y < 0) s.y += height;
        else if (s.y > height) s.y -= height;
      }
      const alpha = Math.max(0.12, s.base * (0.5 + 0.5 * Math.sin(clock * s.speed + s.phase)));
      if (s.r > 1.3) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 2.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${look.star},${String(alpha * 0.16)})`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${look.star},${String(alpha)})`;
      ctx.fill();
    }
  };

  /** Углы фигуры из редких линий в самом углу — доли от ширины и высоты. */
  const CORNER = [
    [0.78, 0.6],
    [0.9, 0.72],
    [0.7, 0.82],
    [0.96, 0.87],
    [0.83, 0.96],
    [0.66, 0.7],
  ] as const;

  /**
   * Волновая сетка в нижнем правом углу: бегущие по синусоиде точки и
   * несколько неподвижных линий между узлами.
   *
   * Шаг по горизонтали намеренно крупный (10 точек, а не 7, как в
   * прототипе): при 7 на широком экране это давало около четырёхсот кругов
   * в кадре — больше половины всей работы холста, а разница видна только
   * если знать, куда смотреть. Замеры — в отчёте к этой правке.
   */
  const drawMesh = (): void => {
    const from = width * 0.6;
    for (let row = 0; row < 5; row += 1) {
      const alpha = 0.11 - row * 0.014;
      if (alpha <= 0) break;
      ctx.fillStyle = `rgba(${look.mesh},${String(alpha)})`;
      const baseY = height * 0.66 + row * 20;
      for (let x = from; x < width; x += 10) {
        const y = baseY + Math.sin(x * 0.012 + clock * 0.4 + row * 0.7) * 11 + (x - from) * 0.07;
        if (y <= 0 || y >= height) continue;
        ctx.beginPath();
        ctx.arc(x, y, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Полтора десятка неподвижных линий: они и делают угол «схемой», а не
    // просто россыпью точек. Стоят почти ничего — считать нечего.
    ctx.strokeStyle = `rgba(${look.mesh},0.1)`;
    ctx.lineWidth = 1;
    const near = (width * 0.23) ** 2;
    for (let i = 0; i < CORNER.length; i += 1) {
      const a = CORNER[i]!;
      const ax = a[0] * width;
      const ay = a[1] * height;
      for (let j = i + 1; j < CORNER.length; j += 1) {
        const b = CORNER[j]!;
        const bx = b[0] * width;
        const by = b[1] * height;
        if ((ax - bx) ** 2 + (ay - by) ** 2 >= near) continue;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
  };

  /** Паутина: точки, линии между близкими и линии к курсору. */
  const drawWeb = (): void => {
    for (const d of dots) {
      if (!host.reduceMotion) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < 0 || d.x > width) d.vx *= -1;
        if (d.y < 0 || d.y > height) d.vy *= -1;
      }
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${look.web},0.8)`;
      ctx.fill();
    }

    /*
     * Пары точек сравниваются по КВАДРАТУ расстояния, и корень берётся
     * только у тех, что действительно соединяются. Пар в кадре порядка
     * трёх тысяч, а Math.hypot — самая дорогая из мыслимых записей этого
     * сравнения: она умеет работать с любым числом слагаемых и бережётся
     * от переполнения, и всё это в самом горячем цикле страницы.
     */
    const linkNear = LINK_DISTANCE * LINK_DISTANCE;
    const mouseNear = MOUSE_DISTANCE * MOUSE_DISTANCE;
    for (let i = 0; i < dots.length; i += 1) {
      const a = dots[i]!;
      for (let j = i + 1; j < dots.length; j += 1) {
        const b = dots[j]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const square = dx * dx + dy * dy;
        if (square >= linkNear) continue;
        const dist = Math.sqrt(square);
        ctx.strokeStyle = `rgba(${look.web},${String(0.18 * (1 - dist / LINK_DISTANCE))})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (mouse.active) {
        const mx = a.x - mouse.x;
        const my = a.y - mouse.y;
        const square = mx * mx + my * my;
        if (square < mouseNear) {
          const dm = Math.sqrt(square);
          ctx.strokeStyle = `rgba(${look.web},${String(0.5 * (1 - dm / MOUSE_DISTANCE))})`;
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
      ctx.fillStyle = `rgba(${look.web},0.95)`;
      ctx.fill();
    }
  };

  const draw = (): void => {
    if (stopped) return;
    if (!host.reduceMotion) clock += 0.016;
    ctx.clearRect(0, 0, width, height);
    drawStars();
    drawMesh();
    drawWeb();

    // При выключенном движении цикла кадров нет — остаётся один неподвижный
    // кадр. Не пустой фон: человеку, которому мешает движение, картинка
    // нужна не меньше. На спрятанной вкладке кадры тоже не запрашиваются.
    if (!host.reduceMotion && visible) frameId = host.requestFrame(draw);
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
    setVisible: (next) => {
      if (next === visible) return;
      visible = next;
      if (!next) {
        host.cancelFrame(frameId);
        return;
      }
      // Вкладку вернули — цикл кадров надо завести заново, сам он не
      // оживёт: последний кадр не запросил следующего.
      if (!host.reduceMotion && !stopped) draw();
    },
    stop: () => {
      stopped = true;
      host.cancelFrame(frameId);
    },
  };
}
