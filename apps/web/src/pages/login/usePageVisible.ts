/**
 * Видно ли сейчас вкладку.
 *
 * Нужно ровно одному: остановить украшения страницы входа, когда человек
 * ушёл на другую вкладку. Браузер и сам придерживает часть работы на
 * спрятанной вкладке (кадры `requestAnimationFrame` там приходят раз в
 * секунду), но анимации CSS он продолжает считать: они идут в потоке
 * компоновщика, а тот про видимость вкладки не спрашивает.
 *
 * Отдельный модуль, а не приём внутри одного компонента: признак нужен и
 * сцене со сферой, и размытым пятнам на самой странице, причём один и тот
 * же — иначе половина украшений замрёт, а половина продолжит крутиться.
 */
import { useEffect, useState } from 'react';

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const onChange = (): void => {
      setVisible(!document.hidden);
    };
    // Первый вызов не лишний: вкладку могли открыть в фоне, и тогда
    // страница нарисовалась бы сразу с работающими анимациями.
    onChange();
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);

  return visible;
}

/**
 * Значение атрибута `data-paused` для корня украшения.
 *
 * Именно `undefined`, а не `'false'`: атрибута не должно быть вовсе, пока
 * пауза не нужна, — правило в CSS смотрит на его наличие.
 */
export function pausedAttr(visible: boolean): 'true' | undefined {
  return visible ? undefined : 'true';
}
