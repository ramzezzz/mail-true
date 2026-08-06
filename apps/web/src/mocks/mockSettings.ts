/**
 * Заглушки раздела настроек. Состояние живёт в памяти вкладки: правила,
 * папки и собираемые ящики реально добавляются и удаляются, но пропадают
 * при перезагрузке. Этого достаточно, чтобы весь интерфейс — включая
 * состояния ошибок и пустых списков — работал до появления маршрутов API.
 */

import type { Folder } from '@mail-true/shared';
import type { FilterRule } from '../lib/filterRules';
import type {
  CollectorAccount,
  CollectorDraft,
  FolderDraft,
  GeneralSettings,
} from '../api/settingsTypes';
import { DEFAULT_UNDO_SEND_SECONDS } from '../api/settingsTypes';
import type { SettingsApi } from '../api/settingsApi';
import { clearFolderMessages, folders, setMockUndoSeconds } from './mockApi';

const delay = (ms = 200) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let general: GeneralSettings = {
  senderName: 'Демо Пользователь',
  // Идентификаторы подписей сервер отдаёт числами-строками
  signatures: [
    { id: '1', name: 'Основная', text: '—\nС уважением, Демо Пользователь' },
    { id: '2', name: 'Короткая', text: '—\nОтправлено из Mail.True' },
  ],
  defaultSignatureId: '1',
  autoReply: { enabled: false, text: '', from: null, to: null },
  notifications: { browser: true, tabCounter: true },
  quoteOriginalOnReply: true,
  afterDelete: 'list',
  autoCollectContacts: true,
  showSenderLogos: false,
  // Как и на сервере: отмена отправки включена, пять секунд
  undoSendSeconds: DEFAULT_UNDO_SEND_SECONDS,
};

let signatureSeq = 30;

/**
 * Приводит сохраняемые настройки к тому виду, в каком их возвращает сервер.
 *
 * Проверено на живом стенде (PUT /api/settings/general):
 *   — подписи с придуманным клиентом id («new-…») заводятся заново и
 *     получают числовой идентификатор, ссылка на подпись по умолчанию
 *     переезжает вместе с ними;
 *   — срок автоответчика возвращается полной датой ISO, а не «гггг-мм-дд».
 * Заглушка возвращала присланное как есть — и оба расхождения проходили
 * все проверки, ломаясь только у живого человека.
 */
function asServerWould(next: GeneralSettings): GeneralSettings {
  const saved = structuredClone(next);
  const remap = new Map<string, string>();
  saved.signatures = saved.signatures.map((s) => {
    if (/^\d+$/u.test(s.id)) return s;
    const id = String((signatureSeq += 1));
    remap.set(s.id, id);
    return { ...s, id };
  });
  const mapped = saved.defaultSignatureId && remap.get(saved.defaultSignatureId);
  if (mapped) saved.defaultSignatureId = mapped;

  const asIso = (value: string | null): string | null => {
    if (value === null || value === '') return null;
    const time = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value).getTime();
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  };
  saved.autoReply.from = asIso(saved.autoReply.from);
  saved.autoReply.to = asIso(saved.autoReply.to);
  return saved;
}

let rules: FilterRule[] = [
  {
    id: 'f1',
    enabled: true,
    auto: false,
    conditions: [{ field: 'from', operator: 'contains', value: 'noreply@bank.example' }],
    actions: {
      moveToFolderId: 'receipts',
      markRead: true,
      markFlagged: false,
      applyToExistingFolderIds: ['inbox'],
      forwardTo: null,
      autoReply: null,
      continueOtherFilters: true,
      applyToSpam: false,
    },
  },
  {
    id: 'f2',
    enabled: false,
    auto: false,
    conditions: [{ field: 'subject', operator: 'contains', value: 'счёт' }],
    actions: {
      moveToFolderId: null,
      markRead: false,
      markFlagged: true,
      applyToExistingFolderIds: [],
      forwardTo: 'admin@mail.true',
      autoReply: null,
      continueOtherFilters: false,
      applyToSpam: true,
    },
  },
  {
    id: 'auto-1',
    enabled: true,
    auto: true,
    conditions: [{ field: 'from', operator: 'contains', value: 'notify@social.example' }],
    actions: {
      moveToFolderId: 'social',
      markRead: false,
      markFlagged: false,
      applyToExistingFolderIds: [],
      forwardTo: null,
      autoReply: null,
      continueOtherFilters: true,
      applyToSpam: false,
    },
  },
];

let collectors: CollectorAccount[] = [
  {
    id: 'c1',
    email: 'old.mailbox@yandex.ru',
    protocol: 'imap',
    host: 'imap.yandex.ru',
    port: 993,
    secure: true,
    login: 'old.mailbox@yandex.ru',
    targetFolderId: 'inbox',
    leaveOnServer: true,
    applyFilters: true,
    enabled: true,
    status: 'ok',
    lastSyncAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    error: null,
  },
  {
    id: 'c2',
    email: 'work@example.com',
    protocol: 'pop3',
    host: 'pop.example.com',
    port: 995,
    secure: true,
    login: 'work@example.com',
    targetFolderId: '1',
    leaveOnServer: false,
    applyFilters: false,
    enabled: true,
    status: 'error',
    lastSyncAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    error: 'Сервер отклонил пароль. Проверьте логин и пароль ящика.',
  },
];

let seq = 100;
const nextId = (prefix: string) => `${prefix}${(seq += 1)}`;

export const mockSettingsApi: SettingsApi = {
  async getGeneral() {
    await delay();
    return structuredClone(general);
  },

  async saveGeneral(next) {
    await delay();
    general = asServerWould(next);
    // Отправка на заглушках обязана слушаться этой настройки: иначе
    // «выключено» в форме ничего не выключало бы, и проверить поведение
    // было бы негде
    setMockUndoSeconds(general.undoSendSeconds);
    return structuredClone(general);
  },

  async getFilterRules() {
    await delay();
    return structuredClone(rules);
  },

  async saveFilterRule(rule) {
    await delay();
    const saved: FilterRule = structuredClone({ ...rule, id: rule.id || nextId('f') });
    const index = rules.findIndex((r) => r.id === saved.id);
    if (index >= 0) rules[index] = saved;
    else rules.push(saved);
    return structuredClone(saved);
  },

  async deleteFilterRule(id) {
    await delay();
    rules = rules.filter((r) => r.id !== id);
  },

  async reorderFilterRules(ids) {
    await delay();
    // Порядок задаётся полным списком id: правила, которых в нём нет
    // (например, автофильтры при скрытом флажке), остаются в хвосте.
    const byId = new Map(rules.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter((r): r is FilterRule => Boolean(r));
    const rest = rules.filter((r) => !ids.includes(r.id));
    rules = [...ordered, ...rest];
    return structuredClone(rules);
  },

  async createFolder(draft: FolderDraft) {
    await delay();
    const name = draft.name.trim();
    if (name.length === 0) throw new Error('Введите название папки');
    if (folders.some((f) => f.name === name && f.parentId === draft.parentId)) {
      throw new Error('Папка с таким названием уже есть');
    }
    const parent = draft.parentId ? folders.find((f) => f.id === draft.parentId) : undefined;
    const created: Folder = {
      id: nextId('folder-'),
      path: parent ? `${parent.path}/${name}` : name,
      name,
      role: 'custom',
      parentId: draft.parentId,
      depth: parent ? parent.depth + 1 : 0,
      unreadCount: 0,
      totalCount: 0,
      system: false,
      uidValidity: 1,
    };
    // Вставляем сразу за родителем, чтобы дерево в левом меню не разъехалось.
    const at = parent ? folders.findIndex((f) => f.id === parent.id) + 1 : folders.length;
    folders.splice(at, 0, created);
    return { ...created };
  },

  async renameFolder(id, name) {
    await delay();
    const folder = folders.find((f) => f.id === id);
    if (!folder) throw new Error('Папка не найдена');
    folder.name = name.trim();
    return { ...folder };
  },

  async deleteFolder(id) {
    await delay();
    for (let i = folders.length - 1; i >= 0; i -= 1) {
      const f = folders[i];
      if (f && (f.id === id || f.parentId === id)) folders.splice(i, 1);
    }
  },

  async clearFolder(id) {
    await delay();
    return { removed: clearFolderMessages(id) };
  },

  async getCollectors() {
    await delay();
    return structuredClone(collectors);
  },

  async addCollector(draft: CollectorDraft) {
    await delay(400);
    // Пустой пароль — единственная проверка, которую заглушка может сделать
    // честно: настоящая проверка учётных данных живёт на сервере.
    if (draft.password.trim().length === 0) {
      throw new Error('Введите пароль от ящика');
    }
    const created: CollectorAccount = {
      id: nextId('c'),
      email: draft.email,
      protocol: draft.protocol,
      host: draft.host,
      port: draft.port,
      secure: draft.secure,
      login: draft.login || draft.email,
      targetFolderId: draft.targetFolderId,
      leaveOnServer: draft.leaveOnServer,
      applyFilters: draft.applyFilters,
      enabled: true,
      status: 'syncing',
      lastSyncAt: null,
      error: null,
    };
    collectors = [...collectors, created];
    return created;
  },

  async updateCollector(id, patch) {
    await delay();
    const index = collectors.findIndex((c) => c.id === id);
    const current = collectors[index];
    if (index < 0 || !current) throw new Error('Ящик не найден');
    const updated: CollectorAccount = { ...current, ...patch };
    collectors[index] = updated;
    return structuredClone(updated);
  },

  async deleteCollector(id) {
    await delay();
    collectors = collectors.filter((c) => c.id !== id);
  },

  async syncCollector(id) {
    await delay(400);
    const collector = collectors.find((c) => c.id === id);
    if (!collector) throw new Error('Ящик не найден');
    collector.status = 'ok';
    collector.error = null;
    collector.lastSyncAt = new Date().toISOString();
    return structuredClone(collector);
  },
};
