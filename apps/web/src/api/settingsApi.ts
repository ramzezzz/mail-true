/**
 * Клиент раздела настроек.
 *
 * Все перечисленные ниже маршруты на сервере ЕСТЬ и проверены запросами
 * к работающему стенду (GET /api/settings/general, /api/settings/filters
 * и /api/settings/collectors отвечают 200). Раздел «Почта с других
 * ящиков» обслуживает apps/api/src/accounts/collectorRoutes.ts — та же
 * таблица и тот же сборщик, что и у /api/accounts/external.
 *
 * По умолчанию (как и остальной интерфейс, см. `api/index.ts`) в режиме
 * разработки работают заглушки, а `VITE_API_MOCK=0` переключает на
 * настоящий сервер. В собранном приложении заглушек нет вовсе.
 *
 * Договор с сервером:
 *
 *   GET    /api/settings/general           → GeneralSettings
 *   PUT    /api/settings/general           ← GeneralSettings
 *   GET    /api/settings/filters           → FilterRule[]
 *   PUT    /api/settings/filters/:id       ← FilterRule (создание при пустом id — POST)
 *   POST   /api/settings/filters           ← FilterRule
 *   DELETE /api/settings/filters/:id
 *   PUT    /api/settings/filters/order     ← { ids: string[] }
 *   POST   /api/folders                    ← FolderDraft            → Folder
 *   PATCH  /api/folders/:id                ← { name }               → Folder
 *   DELETE /api/folders/:id
 *   POST   /api/folders/:id/clear                                   → { removed }
 *   GET    /api/settings/collectors        → CollectorAccount[]
 *   POST   /api/settings/collectors        ← CollectorDraft         → CollectorAccount
 *   PATCH  /api/settings/collectors/:id    ← Partial<CollectorAccount>
 *   DELETE /api/settings/collectors/:id
 *   POST   /api/settings/collectors/:id/sync                        → CollectorAccount
 */

import type { Folder } from '@mail-true/shared';
import { apiFetch } from './http';
import type { FilterRule } from '../lib/filterRules';
import type {
  CollectorAccount,
  CollectorDraft,
  FolderDraft,
  GeneralSettings,
} from './settingsTypes';

export interface SettingsApi {
  getGeneral(): Promise<GeneralSettings>;
  saveGeneral(settings: GeneralSettings): Promise<GeneralSettings>;

  getFilterRules(): Promise<FilterRule[]>;
  /** Создаёт правило при пустом `id`, иначе перезаписывает существующее. */
  saveFilterRule(rule: FilterRule): Promise<FilterRule>;
  deleteFilterRule(id: string): Promise<void>;
  /** Полный порядок правил: фильтры выполняются сверху вниз. */
  reorderFilterRules(ids: string[]): Promise<FilterRule[]>;

  createFolder(draft: FolderDraft): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  /** Удалить все письма папки, саму папку оставить. */
  clearFolder(id: string): Promise<{ removed: number }>;

  getCollectors(): Promise<CollectorAccount[]>;
  addCollector(draft: CollectorDraft): Promise<CollectorAccount>;
  updateCollector(id: string, patch: Partial<CollectorAccount>): Promise<CollectorAccount>;
  deleteCollector(id: string): Promise<void>;
  syncCollector(id: string): Promise<CollectorAccount>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const httpSettingsApi: SettingsApi = {
  getGeneral: () => apiFetch('/api/settings/general'),
  saveGeneral: (settings) => apiFetch('/api/settings/general', json('PUT', settings)),

  getFilterRules: () => apiFetch('/api/settings/filters'),
  saveFilterRule: (rule) =>
    rule.id
      ? apiFetch(`/api/settings/filters/${encodeURIComponent(rule.id)}`, json('PUT', rule))
      : apiFetch('/api/settings/filters', json('POST', rule)),
  deleteFilterRule: (id) =>
    apiFetch(`/api/settings/filters/${encodeURIComponent(id)}`, json('DELETE')),
  reorderFilterRules: (ids) => apiFetch('/api/settings/filters/order', json('PUT', { ids })),

  createFolder: (draft) => apiFetch('/api/folders', json('POST', draft)),
  renameFolder: (id, name) =>
    apiFetch(`/api/folders/${encodeURIComponent(id)}`, json('PATCH', { name })),
  deleteFolder: (id) => apiFetch(`/api/folders/${encodeURIComponent(id)}`, json('DELETE')),
  clearFolder: (id) => apiFetch(`/api/folders/${encodeURIComponent(id)}/clear`, json('POST')),

  getCollectors: () => apiFetch('/api/settings/collectors'),
  addCollector: (draft) => apiFetch('/api/settings/collectors', json('POST', draft)),
  updateCollector: (id, patch) =>
    apiFetch(`/api/settings/collectors/${encodeURIComponent(id)}`, json('PATCH', patch)),
  deleteCollector: (id) =>
    apiFetch(`/api/settings/collectors/${encodeURIComponent(id)}`, json('DELETE')),
  syncCollector: (id) =>
    apiFetch(`/api/settings/collectors/${encodeURIComponent(id)}/sync`, json('POST')),
};
