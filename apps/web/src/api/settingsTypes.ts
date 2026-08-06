/**
 * DTO раздела настроек: общие параметры, правила фильтрации, папки и сбор
 * почты с других ящиков.
 *
 * Соответствующих маршрутов в API пока нет (см. `settingsApi.ts` —
 * там перечислено, что нужно поднять на сервере). До их появления интерфейс
 * работает на заглушках `mocks/mockSettings.ts`, но контракт уже здесь,
 * чтобы стороны не разошлись.
 */

import type { FilterRule } from '../lib/filterRules';

/* --- Общие настройки -------------------------------------------------- */

export interface Signature {
  id: string;
  /** Имя подписи в выпадающем списке окна написания. */
  name: string;
  text: string;
}

/** Куда переходить после удаления письма. */
export type AfterDeleteBehaviour = 'next-message' | 'list';

export interface GeneralSettings {
  /** Имя, которое видит получатель в поле «От кого». */
  senderName: string;
  signatures: Signature[];
  /** id подписи по умолчанию или null — без подписи. */
  defaultSignatureId: string | null;
  autoReply: {
    enabled: boolean;
    text: string;
    /** Срок действия автоответчика (ISO-даты) или null — бессрочно. */
    from: string | null;
    to: string | null;
  };
  notifications: {
    /** Уведомления браузера. */
    browser: boolean;
    /** Счётчик непрочитанных в заголовке вкладки. */
    tabCounter: boolean;
  };
  /** Включать содержимое исходного письма в ответ. */
  quoteOriginalOnReply: boolean;
  afterDelete: AfterDeleteBehaviour;
  /** Автоматически пополнять адресную книгу. */
  autoCollectContacts: boolean;
  /**
   * Показывать в кружках списка писем логотипы доменов вместо букв.
   *
   * По умолчанию выключено: возможность означает, что СЕРВЕР начнёт ходить
   * в интернет за картинками доменов, с которых человеку пришли письма.
   * Браузер к чужим сайтам не обращается ни при каком значении.
   */
  showSenderLogos: boolean;
}

/* --- Сбор почты с других ящиков --------------------------------------- */

export type CollectorProtocol = 'imap' | 'pop3';

export type CollectorStatus = 'ok' | 'syncing' | 'error';

export interface CollectorAccount {
  id: string;
  email: string;
  protocol: CollectorProtocol;
  host: string;
  port: number;
  /** Шифрование соединения (SSL/TLS). */
  secure: boolean;
  /** Логин, если он отличается от адреса. */
  login: string;
  /** Папка-приёмник в нашем ящике. */
  targetFolderId: string;
  /** Оставлять письма на сервере-источнике (актуально для POP3). */
  leaveOnServer: boolean;
  /** Применять к собранным письмам правила фильтрации. */
  applyFilters: boolean;
  enabled: boolean;
  status: CollectorStatus;
  /** Время последней синхронизации (ISO) или null, если её ещё не было. */
  lastSyncAt: string | null;
  /** Текст последней ошибки, если status === 'error'. */
  error: string | null;
}

/** Запрос на добавление ящика; пароль на сервере не хранится в открытом виде. */
export interface CollectorDraft {
  email: string;
  password: string;
  protocol: CollectorProtocol;
  host: string;
  port: number;
  secure: boolean;
  login: string;
  targetFolderId: string;
  leaveOnServer: boolean;
  applyFilters: boolean;
}

/* --- Папки ------------------------------------------------------------- */

export interface FolderDraft {
  name: string;
  /** id родительской папки или null — папка верхнего уровня. */
  parentId: string | null;
}

/* --- Фильтры ----------------------------------------------------------- */

export type { FilterRule } from '../lib/filterRules';

export interface FilterRulesPage {
  rules: FilterRule[];
}
