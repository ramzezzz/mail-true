/**
 * «Напомнить, если не ответили» — обращения к серверу.
 *
 * Отдельным файлом по той же причине, что и отложенные письма: возможность
 * принадлежит работе со списком писем и не должна появляться в интерфейсе,
 * пока сервер не сказал, что она у него есть.
 *
 * СРОК СЧИТАЕТ СЕРВЕР — теми же правилами, что и у откладывания
 * (apps/api/src/mail/snooze-schedule.ts). Отсюда уходит название готового
 * срока и часовой пояс браузера; момент времени приходит посчитанным.
 * Два расчёта одного и того же разъехались бы при первой правке.
 */

import { useMocks } from '../api/mockFlag';
import { apiFetch } from '../api/http';
import { browserTimeZone, type SnoozePreset } from './snoozeApi';

/** Строка подборки «Ждут ответа». */
export interface AwaitingItem {
  /** Составной идентификатор отправленного письма. */
  id: string;
  messageId: string;
  subject: string;
  /** Кому писали. */
  to: string;
  /** Когда напомним, если ответа не будет (ISO). */
  dueAt: string;
  preset: string;
}

export interface AwaitingState {
  /** Возможность есть. Ложь — кнопки в интерфейсе НЕ ПОЯВЛЯЕТСЯ вовсе. */
  available: boolean;
  /**
   * Сервер проверит срок САМ (настроен служебный доступ Dovecot).
   *
   * Отдельно от `available`: без этого срок поставится, но проверять его
   * будет некому — то есть напоминания не будет. Обещать такое нельзя.
   */
  scheduledCheck: boolean;
  reason: string | null;
  items: AwaitingItem[];
}

export interface AwaitReplyRequest {
  ids: string[];
  preset?: SnoozePreset;
  /** Произвольный срок (ISO) — при preset === 'custom'. */
  until?: string;
}

/** Возможности нет, пока сервер не сказал обратного. */
export const AWAIT_UNAVAILABLE: AwaitingState = {
  available: false,
  scheduledCheck: false,
  reason: null,
  items: [],
};

/** На заглушках интерфейса — с объяснением, а не молча. */
export const AWAIT_ON_MOCKS: AwaitingState = {
  available: false,
  scheduledCheck: false,
  reason: 'На заглушечных данных ждать ответа нельзя: проверяет ответ сервер',
  items: [],
};

export const awaitReplyApi = {
  async fetchAwaiting(): Promise<AwaitingState> {
    if (useMocks) return Promise.resolve(AWAIT_ON_MOCKS);
    return apiFetch<AwaitingState>('/api/messages/awaiting');
  },

  async wait(request: AwaitReplyRequest): Promise<{ waiting: number; dueAt: string }> {
    return apiFetch('/api/messages/await-reply', {
      method: 'POST',
      body: JSON.stringify({ ...request, timeZone: browserTimeZone() }),
    });
  },

  /** «Больше не ждать». */
  async cancel(ids: string[]): Promise<{ cancelled: number }> {
    return apiFetch('/api/messages/await-reply', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    });
  },
};
