/**
 * Живые обновления переживают обрыв связи.
 *
 * Сокет создавался один раз и обработчиков `close`/`error` не имел: после
 * любого обрыва (перезапуск API, усыпление ноутбука, разрыв сети) события
 * переставали приходить до перезагрузки страницы — молча.
 */

import { describe, expect, it, vi } from 'vitest';
import { connectWithRetry, reconnectDelay, type SocketLike } from '../src/lib/reconnectingSocket';

/** Поддельный сокет: помнит обработчики и умеет «обрываться». */
class FakeSocket implements SocketLike {
  closed = false;
  private handlers = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event?: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

/** Немедленный планировщик — вместо ожидания таймера. */
function immediateScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
      return queue.length;
    },
    cancel: () => undefined,
    run: () => {
      const pending = queue.splice(0, queue.length);
      for (const cb of pending) cb();
    },
    get pending() {
      return queue.length;
    },
  };
}

describe('connectWithRetry', () => {
  it('переподключается после обрыва', () => {
    const sockets: FakeSocket[] = [];
    const timers = immediateScheduler();
    connectWithRetry({
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: () => undefined,
      delay: () => 0,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    expect(sockets).toHaveLength(1);
    sockets[0]!.emit('close');
    timers.run();
    // Прежний код на этом месте замолкал навсегда
    expect(sockets).toHaveLength(2);
  });

  it('переподключается и после ошибки соединения', () => {
    const sockets: FakeSocket[] = [];
    const timers = immediateScheduler();
    connectWithRetry({
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: () => undefined,
      delay: () => 0,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    sockets[0]!.emit('error');
    timers.run();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
  });

  it('после нового соединения события снова доходят', () => {
    const sockets: FakeSocket[] = [];
    const seen: string[] = [];
    const timers = immediateScheduler();
    connectWithRetry({
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: (data) => seen.push(data),
      delay: () => 0,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    sockets[0]!.emit('message', { data: '{"type":"message.new"}' });
    sockets[0]!.emit('close');
    timers.run();
    sockets[1]!.emit('message', { data: '{"type":"folder.counters"}' });

    expect(seen).toEqual(['{"type":"message.new"}', '{"type":"folder.counters"}']);
  });

  it('отписка прекращает попытки и закрывает сокет', () => {
    const sockets: FakeSocket[] = [];
    const timers = immediateScheduler();
    const stop = connectWithRetry({
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: () => undefined,
      delay: () => 0,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    stop();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.emit('close');
    timers.run();
    expect(sockets).toHaveLength(1);
  });

  it('не падает, если сокет не удалось даже создать', () => {
    const timers = immediateScheduler();
    let attempts = 0;
    expect(() =>
      connectWithRetry({
        open: () => {
          attempts += 1;
          throw new Error('нет сети');
        },
        onMessage: () => undefined,
        delay: () => 0,
        schedule: timers.schedule,
        cancel: timers.cancel,
      }),
    ).not.toThrow();
    expect(attempts).toBe(1);
    expect(timers.pending).toBe(1);
  });

  it('сообщает интерфейсу о потере и восстановлении связи', () => {
    const sockets: FakeSocket[] = [];
    const states: boolean[] = [];
    const timers = immediateScheduler();
    connectWithRetry({
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: () => undefined,
      delay: () => 0,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onStateChange: (connected) => states.push(connected),
    });

    sockets[0]!.emit('open');
    sockets[0]!.emit('close');
    timers.run();
    sockets[1]!.emit('open');
    expect(states).toEqual([true, false, true]);
  });
});

describe('reconnectDelay', () => {
  it('пауза растёт, но не до бесконечности', () => {
    expect(reconnectDelay(1)).toBe(1000);
    expect(reconnectDelay(2)).toBe(2000);
    expect(reconnectDelay(3)).toBe(4000);
    expect(reconnectDelay(10)).toBe(30_000);
    expect(reconnectDelay(100)).toBe(30_000);
  });
});

describe('настоящий клиент', () => {
  it('подписка возвращает функцию отписки', () => {
    // WebSocket в узле нет — подменяем, чтобы проверить сам договор
    class StubSocket {
      addEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', StubSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });

    return import('../src/api/client').then(({ httpApi }) => {
      const stop = httpApi.subscribe(() => undefined);
      expect(typeof stop).toBe('function');
      stop();
      vi.unstubAllGlobals();
    });
  });
});
