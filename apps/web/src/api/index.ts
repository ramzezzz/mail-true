/**
 * Выбор реализации API.
 *
 * По умолчанию в dev-режиме работают моки (бэкенд пишется параллельно),
 * управление — переменной окружения:
 *   VITE_API_MOCK=0  — ходить в настоящий /api/* даже в dev;
 *   VITE_API_MOCK=1  — моки принудительно (в том числе в prod-сборке).
 */

import { httpAccountsApi, type AccountsApi } from './accountsApi';
import { httpApi, type MailApi } from './client';
import { httpSettingsApi, type SettingsApi } from './settingsApi';
import { mockAccountsApi } from '../mocks/mockAccounts';
import { mockApi } from '../mocks/mockApi';
import { mockSettingsApi } from '../mocks/mockSettings';

export { useMocks } from './mockFlag';
import { useMocks } from './mockFlag';

export const api: MailApi = useMocks ? mockApi : httpApi;

/**
 * Раздел настроек вынесен в отдельный клиент: маршрутов под него в API ещё
 * нет (перечень — в `settingsApi.ts`), и держать их в общем `MailApi` значило
 * бы притворяться, что они есть.
 */
export const settingsApi: SettingsApi = useMocks ? mockSettingsApi : httpSettingsApi;

/**
 * Работа с ящиками целиком: связать второй свой ящик, переключиться,
 * посчитать непрочитанные во всех. Маршруты `/api/accounts/*` на сервере
 * есть давно — в интерфейсе их не было вовсе.
 */
export const accountsApi: AccountsApi = useMocks ? mockAccountsApi : httpAccountsApi;

if (useMocks) {
  console.info('[Mail.True] API работает на заглушечных данных (VITE_API_MOCK=0 — переключить).');
}

export type { MailApi } from './client';
export type { SettingsApi } from './settingsApi';
export type { AccountsApi } from './accountsApi';
export * from './accountsTypes';
export * from './types';
export * from './aiTypes';
export * from './settingsTypes';
