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
import { BadRequestError } from '../errors.js';
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
  /**
   * Список подписей. НЕОБЯЗАТЕЛЕН: форма, которая о подписях не знает,
   * не должна их молча стирать — тексты человек пишет руками.
   */
  signatures?: WebSignature[];
  /**
   * Идентификаторы подписей, которые клиент видел на экране.
   *
   * Нужны, чтобы правило «чего нет в присланном списке — удаляем» не
   * сносило подписи, заведённые уже после загрузки формы: вкладка,
   * открытая час назад, иначе уносит чужую работу.
   */
  knownSignatureIds?: string[];
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
  /**
   * Группировать письма в переписки. Необязательное по той же причине, что
   * и два поля выше: этот контракт правит и админка, а форма, которая о
   * поле не знает, не должна молча разворачивать человеку список обратно
   * в письма.
   */
  groupByThread?: boolean;
}

/** Внутренние настройки + подписи -> DTO интерфейса. */
export function toWebGeneral(settings: MailSettings, signatures: Signature[]): WebGeneralSettings {
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
    groupByThread: settings.threadedList,
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
    ...(dto.groupByThread === undefined ? {} : { threadedList: dto.groupByThread }),
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
export type WebFilterField =
  'from' | 'to' | 'subject' | 'cc' | 'size' | 'body' | 'attachment' | 'resent-from' | 'resent-to';

export type WebFilterOperator =
  'contains' | 'not-contains' | 'equals' | 'greater' | 'less' | 'has' | 'has-not';

export interface WebFilterCondition {
  field: WebFilterField;
  operator: WebFilterOperator;
  value: string;
}

export interface WebFilterActions {
  moveToFolderId: string | null;
  markRead: boolean;
  markFlagged: boolean;
  /**
   * Ключевые слова своих меток (`mt-…`), которые ставит правило.
   *
   * Необязательное намеренно — по той же причине, что showSenderLogos
   * в общих настройках: этот контракт правит и админка, а её форма правил
   * о метках не знает. Отсутствие поля означает «не трогать», а не «снять».
   */
  labelKeys?: string[] | undefined;
  /** Удалить письмо: 'trash' — в корзину, 'purge' — безвозвратно.
   * Необязательное по той же причине, что и labelKeys выше. */
  deleteMode?: 'trash' | 'purge' | null | undefined;
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
  has: 'has',
  'has-not': 'has-not',
};

const OP_FROM_WEB: Record<WebFilterOperator, FilterOperator> = {
  contains: 'contains',
  'not-contains': 'not-contains',
  equals: 'is',
  greater: 'greater',
  less: 'less',
  has: 'has',
  'has-not': 'has-not',
};

/**
 * Оператор, совместимый с полем.
 *
 * Форма и API — разные стороны, и поле в форме можно переключить, не тронув
 * оператор. «Вложение содержит» перевести в Sieve нечем, а молча собрать
 * из этого какое-нибудь условие — значит завести правило, которое ловит
 * не то, что написано. Поэтому оператор чинится здесь, в одном месте.
 */
function operatorForField(field: FilterField, op: FilterOperator): FilterOperator {
  if (field === 'attachment') return op === 'has-not' ? 'has-not' : 'has';
  if (op === 'has' || op === 'has-not') {
    // Обратный случай: поле сменили с «Вложения» на обычное.
    return op === 'has-not' ? 'not-contains' : 'contains';
  }
  if (field === 'size') {
    /*
     * У размера ровно два оператора, и «чиним» мы здесь только их.
     *
     * ПОЧЕМУ НЕЛЬЗЯ ДОЧИНИВАТЬ ОСТАЛЬНЫЕ. Раньше любой другой оператор
     * молча превращался в «больше чем»: правило «Размер СОВПАДАЕТ С 1000
     * Кб → удалить безвозвратно» становилось «всё тяжелее 1000 Кб →
     * удалить безвозвратно» и стирало почту, которую человек не выбирал.
     * Форма такое правило предлагала сама (оператор «совпадает с» стоял
     * в списке у размера), и узнать о подмене было неоткуда: список
     * правил показывал то, что записалось, а записывалось не то, что
     * человек выбрал.
     *
     * Честно выполнить «совпадает с» нечем: Sieve умеет `:over`/`:under`,
     * а точного равенства размера у него нет — и просить его у человека
     * бессмысленно, письмо ровно в 1000 Кб не встречается. Поэтому
     * оператор убран из формы (apps/web/src/lib/filterRules.ts), а здесь
     * отказ: правило, которое нельзя выполнить, лучше не сохранять, чем
     * сохранить другим.
     */
    if (op !== 'greater' && op !== 'less') {
      throw new BadRequestError(
        'У условия по размеру письма бывает только «больше чем» и «меньше чем»: ' +
          'точное совпадение размера проверить нечем.',
      );
    }
    return op;
  }
  return op === 'greater' || op === 'less' ? 'contains' : op;
}

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
      labelKeys: [...rule.actions.labels],
      deleteMode: rule.actions.deleteMessage,
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
    body: 'Текст письма',
    attachment: 'Вложение',
  };
  // У условия по вложению значения нет вовсе — называем его словами.
  if (first.field === 'attachment') {
    return first.op === 'has-not' ? 'Вложение: нет' : 'Вложение: есть';
  }
  const value = first.value.length > 40 ? `${first.value.slice(0, 40)}…` : first.value;
  return `${titles[first.field]}: ${value}`;
}

/**
 * DTO интерфейса -> внутреннее правило для сохранения.
 *
 * `previous` — правило, каким оно лежит сейчас. Нужен ради полей, которых
 * может не быть в запросе (метки и удаление): их присылает почтовая форма,
 * но не присылает админка. Без previous сохранение правила из админки
 * молча снимало бы с него метку и удаление — см. WebFilterActions.
 * При создании правила previous, разумеется, нет.
 */
export function fromWebRule(
  dto: WebFilterRule,
  folders: readonly Folder[],
  previous?: FilterRule | null,
): FilterRuleInput {
  const conditions: FilterCondition[] = dto.conditions.map((c) => {
    const field = c.field as FilterField;
    return {
      field,
      op: operatorForField(field, OP_FROM_WEB[c.operator]),
      // Значение условия по вложению не участвует ни в чём: в базе ему
      // место пустой строкой, а не мусором из формы.
      value: field === 'attachment' ? '' : c.value,
    };
  });
  const autoReplyText = dto.actions.autoReply?.trim() ?? '';
  // undefined — «поля в запросе нет», то есть оставить как было.
  const deleteMode =
    dto.actions.deleteMode === undefined
      ? (previous?.actions.deleteMessage ?? null)
      : dto.actions.deleteMode;
  const labelKeys = dto.actions.labelKeys ?? previous?.actions.labels ?? [];
  return {
    name: ruleNameFrom(conditions),
    enabled: dto.enabled,
    auto: dto.auto,
    matchMode: 'all',
    conditions,
    actions: {
      ...DEFAULT_ACTIONS,
      // Удаление и папка-приёмник взаимно исключают друг друга: письмо
      // нельзя одновременно положить в «Счета» и выбросить. Сохраняем то,
      // что человек выбрал последним осознанным действием, — удаление.
      folder: deleteMode ? null : pathOfFolderId(folders, dto.actions.moveToFolderId),
      markRead: dto.actions.markRead,
      flag: dto.actions.markFlagged,
      labels: [...new Set(labelKeys)],
      deleteMessage: deleteMode,
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
