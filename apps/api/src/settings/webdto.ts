/**
 * Преобразование между внутренней моделью настроек и контрактом
 * веб-интерфейса (apps/web/src/api/settingsApi.ts, settingsTypes.ts,
 * lib/filterRules.ts).
 *
 * Слой существует по одной причине: интерфейс уже написан и покрыт
 * тестами, его контракт — данность. Внутренняя модель шире (правило
 * умеет «Переадресовано от/для», режим «любое условие», несколько
 * адресов пересылки, тему автоответа), и ломать её под ограничения
 * одной формы было бы неправильно. Поэтому обе модели живут рядом,
 * а преобразование собрано в одном месте и покрыто тестами — чтобы
 * расхождение вскрывалось здесь, а не на первом экране интерфейса.
 *
 * Отдельная тонкость — папки. Интерфейс оперирует ИДЕНТИФИКАТОРАМИ
 * папок ('inbox', 'f-<base64url>'), а Sieve — их полными путями IMAP.
 * Перевод требует списка папок ящика, поэтому функции принимают его
 * готовым: обращение к IMAP делает маршрут, а не преобразователь.
 */
import type { Folder } from '@mail-true/shared';
import {
  DEFAULT_ACTIONS,
  defaultMailSettings,
  type FilterCondition,
  type FilterField,
  type FilterOperator,
  type FilterRule,
  type FilterRuleInput,
  type MailSettings,
  type MailSettingsPatch,
  type Signature,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Общие настройки                                                      */
/* ------------------------------------------------------------------ */

/** Подпись в контракте интерфейса: текст, а не HTML. */
export interface WebSignature {
  id: string;
  name: string;
  text: string;
}

export type WebAfterDelete = 'next-message' | 'list';

export interface WebGeneralSettings {
  senderName: string;
  signatures: WebSignature[];
  defaultSignatureId: string | null;
  autoReply: {
    enabled: boolean;
    text: string;
    from: string | null;
    to: string | null;
  };
  notifications: { browser: boolean; tabCounter: boolean };
  quoteOriginalOnReply: boolean;
  afterDelete: WebAfterDelete;
  autoCollectContacts: boolean;
  /**
   * Логотипы доменов вместо букв в кружках списка писем.
   *
   * Необязательное поле намеренно: этот же контракт правит админка
   * (admin/user-settings.ts) и им же пользуются готовые проверки. Форма,
   * которая о поле не знает, не должна МОЛЧА ЕГО ГАСИТЬ — а именно это
   * и произошло бы с обязательным полем, приходящим как `undefined`.
   */
  showSenderLogos?: boolean;
  /**
   * Секунды на отмену отправки. Необязательное по той же причине, что и
   * поле выше: этот контракт правит и админка, а форма, которая о поле не
   * знает, не должна молча возвращать человеку отправку без отмены.
   */
  undoSendSeconds?: number;
}

/** Внутренние настройки + подписи -> DTO интерфейса. */
export function toWebGeneral(
  settings: MailSettings,
  signatures: Signature[],
): WebGeneralSettings {
  const def = signatures.find((s) => s.isDefault) ?? null;
  return {
    senderName: settings.senderName ?? '',
    signatures: signatures.map((s) => ({
      id: String(s.id),
      name: s.name,
      text: s.bodyHtml,
    })),
    defaultSignatureId: def ? String(def.id) : null,
    autoReply: {
      enabled: settings.autoReply.enabled,
      text: settings.autoReply.text,
      from: settings.autoReply.from,
      to: settings.autoReply.until,
    },
    notifications: {
      browser: settings.notifyBrowser,
      tabCounter: settings.notifyTab,
    },
    quoteOriginalOnReply: settings.replyQuote,
    afterDelete: settings.afterDelete === 'next' ? 'next-message' : 'list',
    autoCollectContacts: settings.collectContacts,
    showSenderLogos: settings.senderLogos,
    undoSendSeconds: settings.undoSendSeconds,
  };
}

/** DTO интерфейса -> заплатка внутренних настроек (без подписей). */
export function fromWebGeneral(dto: WebGeneralSettings): MailSettingsPatch {
  return {
    senderName: dto.senderName.trim() === '' ? null : dto.senderName,
    replyQuote: dto.quoteOriginalOnReply,
    afterDelete: dto.afterDelete === 'next-message' ? 'next' : 'list',
    notifyBrowser: dto.notifications.browser,
    notifyTab: dto.notifications.tabCounter,
    collectContacts: dto.autoCollectContacts,
    // Поля нет в запросе — значит его прислал тот, кто о нём не знает
    // (админка, старый интерфейс). Настройку человека это трогать не должно.
    ...(dto.showSenderLogos === undefined ? {} : { senderLogos: dto.showSenderLogos }),
    ...(dto.undoSendSeconds === undefined ? {} : { undoSendSeconds: dto.undoSendSeconds }),
    autoReply: {
      enabled: dto.autoReply.enabled,
      text: dto.autoReply.text,
      from: dto.autoReply.from,
      until: dto.autoReply.to,
      // Темы автоответа и периодичности в контракте интерфейса нет —
      // не трогаем то, что уже сохранено.
    },
  };
}

/** Пустые настройки в виде DTO — для ящика, который ещё ничего не менял. */
export function emptyWebGeneral(email: string): WebGeneralSettings {
  return toWebGeneral(defaultMailSettings(email), []);
}

/* ------------------------------------------------------------------ */
/* Папки: идентификатор <-> путь                                        */
/* ------------------------------------------------------------------ */

/** Путь папки по её идентификатору. null — папка не найдена. */
export function pathOfFolderId(folders: readonly Folder[], id: string | null): string | null {
  if (id === null || id === '') return null;
  return folders.find((f) => f.id === id)?.path ?? null;
}

/** Идентификатор папки по её пути. null — папка не найдена. */
export function folderIdOfPath(folders: readonly Folder[], path: string | null): string | null {
  if (path === null || path === '') return null;
  return folders.find((f) => f.path === path)?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Правила фильтрации                                                   */
/* ------------------------------------------------------------------ */

/**
 * Поле условия в контракте интерфейса.
 *
 * 'resent-from' и 'resent-to' интерфейс пока не показывает, но принимает
 * и возвращает: правило, заведённое расширенным API, не должно молча
 * терять условие при первом же открытии формы.
 */
export type WebFilterField = 'from' | 'to' | 'subject' | 'cc' | 'size' | 'resent-from' | 'resent-to';

export type WebFilterOperator = 'contains' | 'not-contains' | 'equals' | 'greater' | 'less';

export interface WebFilterCondition {
  field: WebFilterField;
  operator: WebFilterOperator;
  value: string;
}

export interface WebFilterActions {
  moveToFolderId: string | null;
  markRead: boolean;
  markFlagged: boolean;
  applyToExistingFolderIds: string[];
  forwardTo: string | null;
  autoReply: string | null;
  continueOtherFilters: boolean;
  applyToSpam: boolean;
}

export interface WebFilterRule {
  id: string;
  enabled: boolean;
  conditions: WebFilterCondition[];
  actions: WebFilterActions;
  auto: boolean;
}

const OP_TO_WEB: Record<FilterOperator, WebFilterOperator> = {
  contains: 'contains',
  'not-contains': 'not-contains',
  is: 'equals',
  'not-is': 'not-contains',
  matches: 'contains',
  'not-matches': 'not-contains',
  greater: 'greater',
  less: 'less',
};

const OP_FROM_WEB: Record<WebFilterOperator, FilterOperator> = {
  contains: 'contains',
  'not-contains': 'not-contains',
  equals: 'is',
  greater: 'greater',
  less: 'less',
};

/** Внутреннее правило -> DTO интерфейса. */
export function toWebRule(rule: FilterRule, folders: readonly Folder[]): WebFilterRule {
  return {
    id: String(rule.id),
    enabled: rule.enabled,
    auto: rule.auto,
    conditions: rule.conditions.map((c) => ({
      field: c.field as WebFilterField,
      operator: OP_TO_WEB[c.op],
      value: c.value,
    })),
    actions: {
      moveToFolderId: folderIdOfPath(folders, rule.actions.folder),
      markRead: rule.actions.markRead,
      markFlagged: rule.actions.flag,
      // Список папок «применить к уже полученным» — это разовое действие,
      // а не состояние правила: после применения он пуст.
      applyToExistingFolderIds: [],
      forwardTo: rule.actions.forwardTo[0] ?? null,
      autoReply: rule.actions.autoReply?.text ?? null,
      continueOtherFilters: rule.actions.continueFiltering,
      applyToSpam: rule.actions.applyToSpam,
    },
  };
}

/**
 * Имя правила для списка и для комментария в файле Sieve.
 * Интерфейс имя не задаёт, а в файле правил без него разбираться нельзя.
 */
export function ruleNameFrom(conditions: FilterCondition[]): string {
  const first = conditions[0];
  if (!first) return 'Все письма';
  const titles: Record<FilterField, string> = {
    from: 'От',
    to: 'Кому',
    subject: 'Тема',
    cc: 'Копия',
    'resent-from': 'Переадресовано от',
    'resent-to': 'Переадресовано для',
    size: 'Размер',
  };
  const value = first.value.length > 40 ? `${first.value.slice(0, 40)}…` : first.value;
  return `${titles[first.field]}: ${value}`;
}

/** DTO интерфейса -> внутреннее правило для сохранения. */
export function fromWebRule(dto: WebFilterRule, folders: readonly Folder[]): FilterRuleInput {
  const conditions: FilterCondition[] = dto.conditions.map((c) => ({
    field: c.field as FilterField,
    op: OP_FROM_WEB[c.operator],
    value: c.value,
  }));
  const autoReplyText = dto.actions.autoReply?.trim() ?? '';
  return {
    name: ruleNameFrom(conditions),
    enabled: dto.enabled,
    auto: dto.auto,
    matchMode: 'all',
    conditions,
    actions: {
      ...DEFAULT_ACTIONS,
      folder: pathOfFolderId(folders, dto.actions.moveToFolderId),
      markRead: dto.actions.markRead,
      flag: dto.actions.markFlagged,
      forwardTo: dto.actions.forwardTo ? [dto.actions.forwardTo] : [],
      autoReply: autoReplyText === '' ? null : { subject: null, text: autoReplyText, days: 7 },
      applyToSpam: dto.actions.applyToSpam,
      continueFiltering: dto.actions.continueOtherFilters,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Сбор почты с других ящиков                                           */
/* ------------------------------------------------------------------ */

export type WebCollectorStatus = 'ok' | 'syncing' | 'error';

export interface WebCollector {
  id: string;
  email: string;
  protocol: 'imap' | 'pop3';
  host: string;
  port: number;
  secure: boolean;
  login: string;
  targetFolderId: string;
  leaveOnServer: boolean;
  applyFilters: boolean;
  enabled: boolean;
  status: WebCollectorStatus;
  lastSyncAt: string | null;
  error: string | null;
}

/**
 * Состояние сборщика -> состояние в контракте интерфейса.
 *
 * Внутренних состояний пять, в контракте три. 'partial' (часть писем
 * не перенеслась) показываем как ошибку: молчать о потерянных письмах
 * нельзя. 'never' (ни разу не запускался) — это не ошибка, а пустой
 * lastSyncAt, по нему интерфейс и отличает «ещё не собирали».
 */
export function toWebStatus(status: string): WebCollectorStatus {
  switch (status) {
    case 'running':
      return 'syncing';
    case 'error':
    case 'partial':
      return 'error';
    default:
      return 'ok';
  }
}
