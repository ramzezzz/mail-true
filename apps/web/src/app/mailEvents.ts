/**
 * Раздача серверных событий (/ws) нескольким слушателям.
 *
 * Сокет открывает SessionProvider — один на вкладку, и открывать второй ради
 * уведомлений было бы расточительством: сервер держит на каждое соединение
 * своё IMAP-наблюдение. Поэтому подписка остаётся одна, а события отсюда
 * расходятся всем, кому они нужны.
 */

import { useEffect, useRef } from 'react';
import type { WsEvent } from '../api/types';

type Listener = (event: WsEvent) => void;

const listeners = new Set<Listener>();

/** Вызывается из подписки на сокет. */
export function publishMailEvent(event: WsEvent): void {
  // Копия списка: слушатель вправе отписаться прямо в обработчике.
  for (const listener of [...listeners]) listener(event);
}

export function subscribeMailEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Подписка на события внутри компонента.
 *
 * Обработчик держим в ref: он почти всегда новый на каждой отрисовке, а
 * переподписываться из-за этого незачем.
 */
export function useMailEvents(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeMailEvents((event) => ref.current(event)), []);
}
