/**
 * WebSocket, который переживает обрыв связи.
 *
 * Раньше сокет создавался один раз и обработчиков `close`/`error` не имел:
 * после любого обрыва — усыпления ноутбука, перезапуска API, разрыва сети —
 * живые обновления умирали до перезагрузки страницы, и пользователь этого
 * никак не замечал: письма просто переставали приходить сами.
 *
 * Здесь — переподключение с растущей паузой. Открытие сокета и таймер
 * вынесены в параметры, чтобы логику можно было проверить тестом без сети.
 */

/** То немногое, что нам нужно от сокета. */
export interface SocketLike {
  addEventListener(
    type: 'message' | 'close' | 'error' | 'open',
    handler: (event: unknown) => void,
  ): void;
  close(): void;
}

/** Пауза перед попыткой номер `attempt` (нумерация с единицы), мс. */
export function reconnectDelay(attempt: number): number {
  const base = 1000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 30_000);
}

export interface ReconnectingOptions {
  /** Открыть новый сокет. */
  open: () => SocketLike;
  /** Пришёл кадр. */
  onMessage: (data: string) => void;
  /** Пауза перед повтором; по умолчанию — растущая до 30 секунд. */
  delay?: (attempt: number) => number;
  /** Планировщик; по умолчанию setTimeout. */
  schedule?: (callback: () => void, ms: number) => unknown;
  /** Отмена запланированного повтора. */
  cancel?: (handle: unknown) => void;
  /** Смена состояния связи — для индикатора в интерфейсе. */
  onStateChange?: (connected: boolean) => void;
}

/**
 * Держит соединение живым. Возвращает функцию отписки: после неё
 * переподключений больше не будет.
 */
export function connectWithRetry(options: ReconnectingOptions): () => void {
  const {
    open,
    onMessage,
    delay = reconnectDelay,
    schedule = (cb, ms) => setTimeout(cb, ms),
    cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onStateChange,
  } = options;

  let stopped = false;
  let attempt = 0;
  let socket: SocketLike | null = null;
  let timer: unknown = null;

  const scheduleReconnect = (): void => {
    if (stopped || timer !== null) return;
    attempt += 1;
    timer = schedule(() => {
      timer = null;
      connect();
    }, delay(attempt));
  };

  function connect(): void {
    if (stopped) return;
    let current: SocketLike;
    try {
      current = open();
    } catch {
      // Не смогли даже создать сокет — это тоже повод попробовать снова
      scheduleReconnect();
      return;
    }
    socket = current;

    current.addEventListener('open', () => {
      if (stopped) return;
      attempt = 0;
      onStateChange?.(true);
    });
    current.addEventListener('message', (event) => {
      const data = (event as { data?: unknown } | null)?.data;
      /*
       * Только строка. Наш протокол текстовый, но сокет по стандарту может
       * принести Blob или ArrayBuffer — и прежний String() превращал их в
       * «[object Object]», который дальше молча не разбирался как JSON.
       * Такое сообщение лучше не заметить вовсе, чем принять за пустое
       * обновление.
       */
      if (typeof data === 'string') onMessage(data);
    });
    current.addEventListener('close', () => {
      if (stopped) return;
      onStateChange?.(false);
      scheduleReconnect();
    });
    current.addEventListener('error', () => {
      if (stopped) return;
      onStateChange?.(false);
      // Браузер после ошибки сам закроет сокет, но не всякая реализация
      // это делает, поэтому закрываем сами — close сработает один раз.
      try {
        current.close();
      } catch {
        /* уже закрыт */
      }
      scheduleReconnect();
    });
  }

  connect();

  return () => {
    stopped = true;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    try {
      socket?.close();
    } catch {
      /* уже закрыт */
    }
    socket = null;
  };
}
