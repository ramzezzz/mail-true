/**
 * Медиазапрос как состояние React.
 *
 * Нужен там, где ширина экрана меняет не оформление, а поведение: высоту
 * строки списка задаёт виртуализация, и одним CSS её не переключить —
 * `estimateSize` живёт в JavaScript и обязан знать про телефон.
 */

import { useEffect, useState } from 'react';

/** Телефон: та же граница, на которой в стилях строка становится трёхстрочной. */
export const PHONE_QUERY = '(max-width: 600px)';

/** Совпадает ли медиазапрос прямо сейчас. Вне браузера (тесты) — нет. */
export function matchesQuery(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesQuery(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    // addEventListener есть не во всех движках (старый Safari) — там addListener
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', update);
      return () => list.removeEventListener('change', update);
    }
    list.addListener?.(update);
    return () => list.removeListener?.(update);
  }, [query]);

  return matches;
}

/** Узкий экран телефона: строка списка в три строки, жесты, нижняя навигация. */
export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
