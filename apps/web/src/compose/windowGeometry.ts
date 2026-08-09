/**
 * Геометрия окна написания письма: перетаскивание за шапку и растягивание
 * за уголки.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ
 * ------------------------------------------------------------------
 * Вся арифметика здесь чистая: на вход — начальное положение, сдвиг мыши и
 * размер видимой области, на выход — новое положение. Ни DOM, ни React.
 * Так её можно проверить тестами построчно, а в самом окне остаётся только
 * подписка на события указателя.
 *
 * Главное правило, ради которого арифметика вообще нужна: окно не должно
 * уезжать за край экрана. Уехавшую шапку нечем поймать обратно — окно
 * останется недоступным до перезагрузки страницы, а в нём лежит письмо,
 * которое человек пишет прямо сейчас.
 */

/** Положение и размер окна в пикселях, от левого верхнего угла экрана. */
export interface ComposeGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Видимая область окна браузера. */
export interface Viewport {
  width: number;
  height: number;
}

/** Уголок, за который тянут. `n`/`s` — верх/низ, `w`/`e` — лево/право. */
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Меньше этого окно не ужимается.
 *
 * По ширине: ниже 360px строка «Кому» с кнопками «Копия» и «Скрытая» ломается
 * на две, а нижняя панель с «Отправить» переносится и наезжает на текст.
 * По высоте: 280px — это шапка, три строки полей и панель отправки; поле
 * письма при этом ещё видно, хотя и одной строкой.
 */
export const MIN_WIDTH = 360;
export const MIN_HEIGHT = 280;

/**
 * Ниже этой ширины экрана окно занимает его целиком (правило из CSS), и
 * двигать там нечего: перетаскивание и уголки выключены совсем.
 */
export const FREE_LAYOUT_MIN_VIEWPORT = 641;

/** Тот же порог медиазапросом — для подписки на изменение размера окна. */
export const FREE_LAYOUT_QUERY = `(min-width: ${FREE_LAYOUT_MIN_VIEWPORT}px)`;

/** Свободная раскладка вообще применима к такому экрану? */
export function canFloat(viewport: Viewport): boolean {
  return viewport.width >= FREE_LAYOUT_MIN_VIEWPORT;
}

function clamp(value: number, min: number, max: number): number {
  // max < min бывает на экране уже самого окна: тогда прижимаем к min,
  // то есть к левому/верхнему краю — так видно хотя бы шапку.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Положение после перетаскивания: окно целиком остаётся в видимой области.
 *
 * Размер здесь не меняется — только левый верхний угол.
 */
export function moveGeometry(
  start: ComposeGeometry,
  dx: number,
  dy: number,
  viewport: Viewport,
): ComposeGeometry {
  return {
    ...start,
    left: clamp(start.left + dx, 0, viewport.width - start.width),
    top: clamp(start.top + dy, 0, viewport.height - start.height),
  };
}

/**
 * Размер после растягивания за уголок.
 *
 * Противоположный угол стоит на месте — за него окно и «держится». Поэтому
 * тяга за левый край меняет не только ширину, но и `left`: иначе окно
 * расползалось бы вправо, хотя тянут влево.
 *
 * Ограничений два, и оба обязательны: меньше минимума окно не становится
 * (иначе поля схлопываются), и за край экрана не вылезает (иначе кнопка
 * «Отправить» оказывается за пределами видимого).
 */
export function resizeGeometry(
  start: ComposeGeometry,
  corner: ResizeCorner,
  dx: number,
  dy: number,
  viewport: Viewport,
): ComposeGeometry {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';

  // Неподвижная сторона: к ней всё и считается.
  const right = start.left + start.width;
  const bottom = start.top + start.height;

  let width: number;
  let left: number;
  if (west) {
    // Влево окно растёт до края экрана, вправо ужимается до минимума.
    width = clamp(start.width - dx, MIN_WIDTH, right);
    left = right - width;
  } else {
    width = clamp(start.width + dx, MIN_WIDTH, viewport.width - start.left);
    left = start.left;
  }

  let height: number;
  let top: number;
  if (north) {
    height = clamp(start.height - dy, MIN_HEIGHT, bottom);
    top = bottom - height;
  } else {
    height = clamp(start.height + dy, MIN_HEIGHT, viewport.height - start.top);
    top = start.top;
  }

  return { left, top, width, height };
}

/**
 * Подгон уже сохранённой геометрии под текущий экран.
 *
 * Нужен после поворота телефона, изменения размера браузера и переезда окна
 * на второй монитор: окно, поставленное у правого края широкого экрана, на
 * узком оказалось бы целиком за его пределами.
 */
export function fitGeometry(geom: ComposeGeometry, viewport: Viewport): ComposeGeometry {
  const width = Math.min(geom.width, Math.max(viewport.width, MIN_WIDTH));
  const height = Math.min(geom.height, Math.max(viewport.height, MIN_HEIGHT));
  return {
    width,
    height,
    left: clamp(geom.left, 0, viewport.width - width),
    top: clamp(geom.top, 0, viewport.height - height),
  };
}
