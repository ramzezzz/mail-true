/**
 * Фон входа: то, из-за чего страница входа однажды падала целиком, и то,
 * что зря жгло батарею — на телефоне и на спрятанной вкладке.
 *
 * DOM здесь не нужен: холст подделан, окружение подделано. Модуль общий для
 * почты и панели управления, поэтому и проверка одна.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AREA_PER_DOT,
  AREA_PER_STAR,
  MAX_DOTS,
  MAX_STARS,
  MIN_DOTS,
  MIN_STARS,
  dotCount,
  starCount,
  startConstellation,
  type CanvasLike,
  type ConstellationHost,
  type PaintLike,
} from '../src/pages/login/constellation';

/** Поддельный холст, который считает вызовы рисования. */
function fakePaint() {
  const calls = { fill: 0, stroke: 0, clear: 0 };
  const paint = {
    setTransform: () => undefined,
    clearRect: () => {
      calls.clear += 1;
    },
    beginPath: () => undefined,
    arc: () => undefined,
    fill: () => {
      calls.fill += 1;
    },
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => {
      calls.stroke += 1;
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  } as unknown as PaintLike;
  return { paint, calls };
}

function fakeCanvas(paint: PaintLike | null, width = 1440, height = 900): CanvasLike {
  return {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
    getContext: () => paint,
  };
}

function fakeHost(over: Partial<ConstellationHost> = {}): ConstellationHost {
  return {
    viewportWidth: 1440,
    viewportHeight: 900,
    pixelRatio: 1,
    reduceMotion: false,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    random: () => 0.5,
    ...over,
  };
}

describe('холст может не дать рисовать', () => {
  it('не роняет страницу, если обращение к холсту бросает исключение', () => {
    const canvas: CanvasLike = {
      clientWidth: 1440,
      clientHeight: 900,
      width: 0,
      height: 0,
      getContext: () => {
        throw new Error('рисование запрещено');
      },
    };
    let sky;
    expect(() => {
      sky = startConstellation(canvas, fakeHost());
    }).not.toThrow();
    expect(sky).toBeNull();
  });

  it('не роняет страницу, если холста в среде нет вовсе', () => {
    expect(startConstellation(fakeCanvas(null), fakeHost())).toBeNull();
  });
});

describe('число точек и звёзд считается от площади окна', () => {
  it('на телефоне точек заметно меньше, чем на большом экране', () => {
    expect(dotCount(390, 780)).toBeLessThan(dotCount(1440, 900));
    expect(starCount(390, 780)).toBeLessThan(starCount(1440, 900));
  });

  it('на телефоне берётся нижняя граница, а не постоянные сто точек', () => {
    expect(dotCount(390, 780)).toBe(MIN_DOTS);
    expect(dotCount(1440, 900)).toBe(Math.round((1440 * 900) / AREA_PER_DOT));
    expect(starCount(390, 780)).toBe(MIN_STARS);
    expect(starCount(1440, 900)).toBe(Math.round((1440 * 900) / AREA_PER_STAR));
  });

  it('на огромном экране точки не размножаются без меры', () => {
    expect(dotCount(7680, 4320)).toBe(MAX_DOTS);
    expect(starCount(7680, 4320)).toBe(MAX_STARS);
  });
});

describe('уважение к просьбе не двигать картинку', () => {
  it('без движения кадры не запрашиваются, но кадр всё-таки нарисован', () => {
    const { paint, calls } = fakePaint();
    const requestFrame = vi.fn(() => 1);
    const sky = startConstellation(fakeCanvas(paint), fakeHost({ reduceMotion: true, requestFrame }));

    expect(sky).not.toBeNull();
    expect(requestFrame).not.toHaveBeenCalled();
    // Не пустой фон: и звёзды, и точки нарисованы один раз.
    expect(calls.clear).toBe(1);
    expect(calls.fill).toBeGreaterThan(dotCount(1440, 900));
  });

  it('при обычной настройке кадры запрашиваются', () => {
    const { paint } = fakePaint();
    const requestFrame = vi.fn(() => 7);
    startConstellation(fakeCanvas(paint), fakeHost({ requestFrame }));
    expect(requestFrame).toHaveBeenCalled();
  });

  it('без движения звёзды не мерцают: второй кадр в точности повторяет первый', () => {
    /*
     * Мерцание и бег волны считаются от часов сцены, а яркость приезжает
     * в цвете заливки. При выключенном движении часы стоят, значит два
     * кадра подряд обязаны дать в точности тот же список цветов. Это и
     * есть «остановить, а не замедлить»: без остановки часов картинка
     * продолжала бы дышать при каждой перерисовке.
     */
    const seen: string[] = [];
    const paint = {
      setTransform: () => undefined,
      clearRect: () => undefined,
      beginPath: () => undefined,
      arc: () => undefined,
      fill(this: { fillStyle: string }) {
        seen.push(this.fillStyle);
      },
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
    } as unknown as PaintLike;

    const sky = startConstellation(fakeCanvas(paint), fakeHost({ reduceMotion: true }));
    const first = seen.splice(0, seen.length);
    expect(first.length).toBeGreaterThan(0);

    // Перерисовка без курсора — тот же кадр, что и первый.
    sky?.forgetPointer();
    expect(seen).toEqual(first);
  });

  it('без движения линии к курсору всё равно появляются: кадр перерисовывается', () => {
    const { paint, calls } = fakePaint();
    const sky = startConstellation(fakeCanvas(paint), fakeHost({ reduceMotion: true }));
    const before = calls.clear;
    sky?.pointTo(700, 400);
    expect(calls.clear).toBe(before + 1);
  });
});

describe('невидимая вкладка ничего не считает', () => {
  it('когда вкладку спрятали, следующий кадр не запрашивается', () => {
    const { paint } = fakePaint();
    let next: (() => void) | null = null;
    const requestFrame = vi.fn((run: () => void) => {
      next = run;
      return 3;
    });
    const cancelFrame = vi.fn();
    const sky = startConstellation(fakeCanvas(paint), fakeHost({ requestFrame, cancelFrame }));

    expect(requestFrame).toHaveBeenCalledTimes(1);
    sky?.setVisible(false);
    expect(cancelFrame).toHaveBeenCalledWith(3);

    // Если кадр всё-таки успел начаться — он не заводит следующий.
    const before = requestFrame.mock.calls.length;
    (next as unknown as () => void)();
    expect(requestFrame.mock.calls.length).toBe(before);
  });

  it('когда вкладку вернули, движение оживает само', () => {
    const { paint } = fakePaint();
    const requestFrame = vi.fn(() => 3);
    const sky = startConstellation(fakeCanvas(paint), fakeHost({ requestFrame }));
    sky?.setVisible(false);
    const before = requestFrame.mock.calls.length;
    sky?.setVisible(true);
    expect(requestFrame.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('уборка за собой', () => {
  it('останов отменяет кадр и больше не рисует', () => {
    const { paint, calls } = fakePaint();
    const cancelFrame = vi.fn();
    const sky = startConstellation(fakeCanvas(paint), fakeHost({ cancelFrame, reduceMotion: true }));
    sky?.stop();
    expect(cancelFrame).toHaveBeenCalled();

    const after = calls.clear;
    sky?.pointTo(10, 10);
    sky?.forgetPointer();
    expect(calls.clear).toBe(after);
  });
});
