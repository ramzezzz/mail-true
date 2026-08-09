/**
 * Перетаскивание и растягивание окна написания письма.
 *
 * Главное, что здесь проверяется, — окно не уезжает за край экрана. В окне
 * лежит письмо, которое пишут прямо сейчас: уехавшую шапку нечем поймать
 * обратно, и вернуть письмо можно будет только перезагрузкой страницы, то
 * есть никак.
 */
import { describe, expect, it } from 'vitest';
import {
  canFloat,
  fitGeometry,
  moveGeometry,
  resizeGeometry,
  MIN_HEIGHT,
  MIN_WIDTH,
} from '../src/compose/windowGeometry';

const SCREEN = { width: 1600, height: 900 };
const WINDOW = { left: 700, top: 300, width: 600, height: 400 };

describe('перетаскивание', () => {
  it('двигает окно на сдвиг указателя', () => {
    expect(moveGeometry(WINDOW, 50, -80, SCREEN)).toEqual({
      left: 750,
      top: 220,
      width: 600,
      height: 400,
    });
  });

  it('не пускает окно за правый и нижний край', () => {
    const moved = moveGeometry(WINDOW, 5000, 5000, SCREEN);
    expect(moved.left + moved.width).toBe(SCREEN.width);
    expect(moved.top + moved.height).toBe(SCREEN.height);
  });

  it('не пускает окно за левый и верхний край: шапка должна остаться видимой', () => {
    expect(moveGeometry(WINDOW, -5000, -5000, SCREEN)).toMatchObject({ left: 0, top: 0 });
  });

  it('размер при перетаскивании не меняется', () => {
    const moved = moveGeometry(WINDOW, 123, -45, SCREEN);
    expect(moved.width).toBe(WINDOW.width);
    expect(moved.height).toBe(WINDOW.height);
  });
});

describe('растягивание за уголок', () => {
  it('нижний правый уголок меняет только размер', () => {
    expect(resizeGeometry(WINDOW, 'se', 100, 50, SCREEN)).toEqual({
      left: 700,
      top: 300,
      width: 700,
      height: 450,
    });
  });

  it('верхний левый уголок держит противоположный угол на месте', () => {
    // Тянем влево-вверх: окно растёт, а правый нижний угол не двигается.
    const resized = resizeGeometry(WINDOW, 'nw', -100, -50, SCREEN);
    expect(resized).toEqual({ left: 600, top: 250, width: 700, height: 450 });
    expect(resized.left + resized.width).toBe(WINDOW.left + WINDOW.width);
    expect(resized.top + resized.height).toBe(WINDOW.top + WINDOW.height);
  });

  it('меньше минимума окно не ужимается', () => {
    // Ниже минимума ломается строка «Кому» и уезжает кнопка «Отправить».
    const resized = resizeGeometry(WINDOW, 'se', -5000, -5000, SCREEN);
    expect(resized.width).toBe(MIN_WIDTH);
    expect(resized.height).toBe(MIN_HEIGHT);
  });

  it('ужимание за верхний левый уголок не уводит окно вправо за край', () => {
    const resized = resizeGeometry(WINDOW, 'nw', 5000, 5000, SCREEN);
    expect(resized.width).toBe(MIN_WIDTH);
    expect(resized.left + resized.width).toBe(WINDOW.left + WINDOW.width);
  });

  it('окно не растягивается за пределы экрана', () => {
    const resized = resizeGeometry(WINDOW, 'se', 5000, 5000, SCREEN);
    expect(resized.left + resized.width).toBe(SCREEN.width);
    expect(resized.top + resized.height).toBe(SCREEN.height);
  });

  it('верхний правый уголок тянет вверх и вправо', () => {
    const resized = resizeGeometry(WINDOW, 'ne', 40, -60, SCREEN);
    expect(resized).toEqual({ left: 700, top: 240, width: 640, height: 460 });
  });
});

describe('подгон под изменившийся экран', () => {
  it('возвращает окно, оказавшееся за краем, обратно в видимую область', () => {
    // Браузер сузили с 1600 до 900: окно стояло у правого края.
    const fitted = fitGeometry(
      { left: 1200, top: 700, width: 600, height: 400 },
      {
        width: 900,
        height: 800,
      },
    );
    expect(fitted.left + fitted.width).toBeLessThanOrEqual(900);
    expect(fitted.top + fitted.height).toBeLessThanOrEqual(800);
    expect(fitted.left).toBeGreaterThanOrEqual(0);
    expect(fitted.top).toBeGreaterThanOrEqual(0);
  });

  it('окно шире экрана ужимается по экрану, а не остаётся обрезком', () => {
    const fitted = fitGeometry(
      { left: 0, top: 0, width: 1400, height: 900 },
      {
        width: 1000,
        height: 700,
      },
    );
    expect(fitted.width).toBe(1000);
    expect(fitted.height).toBe(700);
  });

  it('уже стоящее по месту окно не трогается', () => {
    expect(fitGeometry(WINDOW, SCREEN)).toEqual(WINDOW);
  });
});

describe('узкий экран', () => {
  it('на телефоне свободной раскладки нет: окно занимает экран целиком', () => {
    expect(canFloat({ width: 390, height: 844 })).toBe(false);
    expect(canFloat({ width: 640, height: 900 })).toBe(false);
  });

  it('на настольном экране свободная раскладка есть', () => {
    expect(canFloat({ width: 1280, height: 800 })).toBe(true);
  });
});
