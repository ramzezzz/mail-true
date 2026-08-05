/**
 * Контейнер окон написания письма (.compose-windows mail.ru):
 * развёрнутые окна каскадом у правого края, свёрнутые — плашками внизу.
 *
 * Все окна рисуются ОДНИМ списком у одного родителя. Раньше развёрнутые и
 * свёрнутые окна лежали в разных родителях, поэтому при сворачивании React
 * размонтировал компонент и всё введённое исчезало: получатели, тема,
 * вложения, тело письма. Место свёрнутой плашки задаётся смещением в стиле,
 * а не отдельной обёрткой, — тогда родитель и порядок у окна не меняются
 * никогда, и состояние переживает сворачивание.
 */

import { useUiStore, type ComposeWindowState } from '../app/store';
import { ComposeWindow } from './ComposeWindow';

/** Ширина свёрнутой плашки вместе с зазором — шаг раскладки внизу экрана. */
const MINIMIZED_STEP = 268;
/** Отступ первой плашки от левого края. */
const MINIMIZED_LEFT = 16;

export interface ComposeWindowPlace {
  win: ComposeWindowState;
  /** Порядковый номер среди развёрнутых окон — для каскада справа. */
  offset: number;
  /** Сдвиг свёрнутой плашки от левого края, px. */
  minimizedLeft: number;
}

/**
 * Раскладка окон: один список в исходном порядке открытия.
 * Порядок и состав НЕ зависят от того, свёрнуто окно или нет.
 */
export function composeWindowPlaces(
  windows: readonly ComposeWindowState[],
): ComposeWindowPlace[] {
  let expanded = 0;
  let minimized = 0;
  return windows.map((win) => {
    const place: ComposeWindowPlace = {
      win,
      offset: win.minimized ? 0 : expanded,
      minimizedLeft: MINIMIZED_LEFT + minimized * MINIMIZED_STEP,
    };
    if (win.minimized) minimized += 1;
    else expanded += 1;
    return place;
  });
}

export function ComposeWindows() {
  const windows = useUiStore((s) => s.composeWindows);
  if (windows.length === 0) return null;

  return (
    <>
      {composeWindowPlaces(windows).map(({ win, offset, minimizedLeft }) => (
        <ComposeWindow key={win.id} win={win} offset={offset} minimizedLeft={minimizedLeft} />
      ))}
    </>
  );
}
