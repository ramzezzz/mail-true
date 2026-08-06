/**
 * Раздел «Одноразовые адреса»: контракт с сервером.
 *
 *   GET    /api/settings/aliases       → DisposableState
 *   POST   /api/settings/aliases       → DisposableAlias
 *   PATCH  /api/settings/aliases/:id   → DisposableAlias
 *   DELETE /api/settings/aliases/:id   → { ok: true }
 *
 * Форма ответа та же, что у разделов владельца ящика: сперва `available`
 * и `reason`, потом данные. До ответа сервера раздела в меню нет вовсе —
 * общее правило продукта: кнопка появляется вместе с поведением.
 */
import { apiFetch } from '../api/http';
import { useMocks } from '../api/mockFlag';

export interface DisposableSender {
  address: string;
  count: number;
  lastAt: string;
}

/**
 * Что известно про почту на адрес.
 *
 * Числа — за окно журнала, а не за всё время: `windowDays` обязателен к
 * показу рядом с ними. Ноль без окна человек прочитает как «на адрес
 * никто не писал» и спокойно оставит работать проданный адрес.
 */
export interface DisposableTraffic {
  received: number;
  rejected: number;
  lastAt: string | null;
  senders: DisposableSender[];
  windowDays: number;
}

export interface DisposableAlias {
  id: number;
  address: string;
  destination: string;
  active: boolean;
  note: string;
  createdAt: string;
  disabledAt: string | null;
  /** null — журнала нет, чисел не показываем вовсе. */
  traffic: DisposableTraffic | null;
}

export interface DisposableState {
  available: boolean;
  reason: string | null;
  items: DisposableAlias[];
  domain: string;
  limit: number;
  used: number;
}

export const DISPOSABLE_UNAVAILABLE: DisposableState = {
  available: false,
  reason: null,
  items: [],
  domain: '',
  limit: 0,
  used: 0,
};

/*
 * На заглушечных данных запрос НЕ отправляется вовсе. Настоящий маршрут
 * без сессии отвечает 401, а общий разбор 401 уводит на страницу входа —
 * из режима, где входить и не предполагается.
 */
const DISPOSABLE_ON_MOCKS: DisposableState = {
  ...DISPOSABLE_UNAVAILABLE,
  reason: 'На заглушечных данных одноразовые адреса не заводятся: настоящего домена здесь нет',
};

export interface DisposableDraft {
  /** Имя без домена. Пусто — сервер придумает сам. */
  name: string;
  note: string;
}

export const disposableApi = {
  getAliases: (): Promise<DisposableState> => {
    if (useMocks) return Promise.resolve(DISPOSABLE_ON_MOCKS);
    return apiFetch('/api/settings/aliases');
  },

  createAlias: (draft: DisposableDraft): Promise<DisposableAlias> =>
    apiFetch('/api/settings/aliases', { method: 'POST', body: JSON.stringify(draft) }),

  setActive: (id: number, active: boolean): Promise<DisposableAlias> =>
    apiFetch(`/api/settings/aliases/${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      body: JSON.stringify({ active }),
    }),

  setNote: (id: number, note: string): Promise<DisposableAlias> =>
    apiFetch(`/api/settings/aliases/${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    }),

  deleteAlias: (id: number): Promise<{ ok: boolean }> =>
    apiFetch(`/api/settings/aliases/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ */
/* Показ                                                                */
/* ------------------------------------------------------------------ */

/** Склонение: 1 письмо, 2 письма, 5 писем. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** «6 августа 2026» — дата без времени: адрес заводят раз и надолго. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** «6 августа, 20:21» — для последнего письма время важно. */
export function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
