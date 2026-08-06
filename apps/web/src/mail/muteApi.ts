/**
 * «Заглушить цепочку» — обращения к серверу и слова, которыми это
 * называется в интерфейсе.
 *
 * Отдельным файлом, а не внутри общего клиента API, по той же причине, по
 * какой отдельно живут метки и отложенные письма: возможность целиком
 * принадлежит работе со списком писем и не должна появляться в интерфейсе,
 * пока сервер не сказал, что она у него есть.
 *
 * ЗАГЛУШКА РАБОТАЕТ ПРИ ДОСТАВКЕ. Отсюда это не видно никак, и потому
 * важно: `delivery: false` означает, что кнопка нажмётся, запись появится,
 * а письма всё равно пойдут во «Входящие». Такой заглушки продукт не
 * делает — при `delivery: false` кнопки нет, как и при `available: false`.
 */

import { useMocks } from '../api/mockFlag';
import { apiFetch } from '../api/http';

/** Строка подборки «Заглушённые». */
export interface MutedThread {
  /** Ключ переписки — им она и расглушается. */
  key: string;
  subject: string;
  from: string;
  /** Когда заглушили (ISO). */
  mutedAt: string;
  /** Сколько писем переписки узнаёт правило доставки. */
  knownMessages: number;
}

export interface MutedState {
  /**
   * Возможность есть. Ложь — кнопки «Заглушить» в интерфейсе НЕ ПОЯВЛЯЕТСЯ
   * вовсе: общее правило продукта — кнопка появляется вместе с поведением.
   */
  available: boolean;
  /**
   * Заглушка доедет до ДОСТАВКИ (есть доступ к хранилищу правил Dovecot).
   *
   * Отдельно от `available`, потому что половинчатая заглушка — это ровно
   * та мёртвая кнопка, ради отказа от которой возможность и делалась:
   * человек нажимает, а письма продолжают падать во «Входящие».
   */
  delivery: boolean;
  reason: string | null;
  items: MutedThread[];
}

/** Возможности нет, пока сервер не сказал обратного. */
export const MUTE_UNAVAILABLE: MutedState = {
  available: false,
  delivery: false,
  reason: null,
  items: [],
};

/** На заглушках интерфейса — с объяснением, а не молча. */
export const MUTE_ON_MOCKS: MutedState = {
  available: false,
  delivery: false,
  reason: 'На заглушечных данных переписку заглушить нельзя: правила доставки живут на сервере',
  items: [],
};

export const muteApi = {
  async fetchMuted(): Promise<MutedState> {
    /*
     * На заглушках запроса нет вовсе: без сессии настоящий адрес ответит
     * 401, и общий обработчик увёл бы человека на экран входа — из режима,
     * в котором никакого входа не предполагается.
     */
    if (useMocks) return Promise.resolve(MUTE_ON_MOCKS);
    return apiFetch<MutedState>('/api/threads/muted');
  },

  /** Заглушить переписки, которым принадлежат эти письма. */
  async mute(ids: string[]): Promise<{ muted: number; moved: number; deliveryError: string }> {
    return apiFetch('/api/threads/mute', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  },

  /** Вернуть переписки: дальнейшее снова пойдёт во «Входящие». */
  async unmute(keys: string[]): Promise<{ lifted: number }> {
    return apiFetch('/api/threads/mute', {
      method: 'DELETE',
      body: JSON.stringify({ keys }),
    });
  },
};
