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
import { SendFailureBanner } from './SendFailureBanner';

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
  /**
   * Порядковый номер плашки «Письмо отправлено · Отменить» снизу вверх.
   *
   * Отправить два письма подряд — обычное дело, а обе плашки стоят внизу
   * по центру: без своего номера вторая легла бы ровно на первую, и первую
   * стало бы нечем отменить.
   */
  undoIndex: number;
}

/**
 * Раскладка окон: один список в исходном порядке открытия.
 * Порядок и состав НЕ зависят от того, свёрнуто окно или нет.
 *
 * Окно, ждущее отмены, не занимает места ни в каскаде развёрнутых, ни
 * в ряду свёрнутых: на экране от него видна только плашка внизу. Иначе
 * отправленное письмо продолжало бы сдвигать соседние окна вправо.
 */
export function composeWindowPlaces(
  windows: readonly ComposeWindowState[],
): ComposeWindowPlace[] {
  let expanded = 0;
  let minimized = 0;
  let pending = 0;
  return windows.map((win) => {
    const waiting = win.draft.pending !== null;
    const place: ComposeWindowPlace = {
      win,
      offset: win.minimized || waiting ? 0 : expanded,
      minimizedLeft: MINIMIZED_LEFT + minimized * MINIMIZED_STEP,
      undoIndex: pending,
    };
    if (waiting) pending += 1;
    else if (win.minimized) minimized += 1;
    else expanded += 1;
    return place;
  });
}

export function ComposeWindows() {
  const windows = useUiStore((s) => s.composeWindows);

  return (
    <>
      {/*
        Плашка «письмо не отправлено» живёт здесь, а не рядом с окнами
        по смыслу, а по месту в дереве: она должна показываться поверх
        любой страницы почты и НЕ зависеть от того, открыто ли сейчас
        хоть одно окно написания. Ровно поэтому же ранний выход по
        пустому списку окон отсюда убран — иначе извещение об отказе
        не показывалось бы никому, кто ничего не пишет прямо сейчас,
        то есть почти никому.
      */}
      <SendFailureBanner />
      {composeWindowPlaces(windows).map(({ win, offset, minimizedLeft, undoIndex }) => (
        <ComposeWindow
          key={win.id}
          win={win}
          offset={offset}
          minimizedLeft={minimizedLeft}
          undoIndex={undoIndex}
        />
      ))}
    </>
  );
}
