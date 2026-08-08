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
  /**
   * Сколько секунд после нажатия «Отправить» письмо ещё можно вернуть.
   *
   * Ноль — отмена выключена, письмо уходит сразу. Ненулевое значение
   * означает, что эти секунды письмо лежит в очереди НА СЕРВЕРЕ, а не
   * у получателя, — и потому уйдёт даже с закрытой вкладкой.
   */
  undoSendSeconds: number;
  /**
   * Показывать список разговорами, а не письмами: ответ на письмо занимает
   * ту же строку, что и само письмо, и рядом с темой стоит число писем.
   *
   * По умолчанию ВКЛЮЧЕНО — как в привычных почтовых интерфейсах. Настройка живёт на сервере,
   * за ящиком: человек с двумя компьютерами должен видеть свою почту
   * одинаково.
   *
   * Действует не во всех папках. В черновиках, корзине, спаме и отложенных
   * сервер группировку не применяет — туда приходят за одним конкретным
   * письмом, и прятать его за счётчиком нельзя (apps/api/src/mail/threads.ts).
   */
  groupByThread: boolean;
}

/**
 * Что предлагается в настройках. Ноль — «выключено».
 *
 * Тот же список проверяет сервер (UNDO_SEND_CHOICES в API): произвольное
 * число секунд означало бы способ задержать собственную почту на час,
 * не понимая, что произошло.
 */
export const UNDO_SEND_CHOICES = [0, 5, 10, 30] as const;

/**
 * Значение по умолчанию — пять секунд, и отмена по умолчанию ВКЛЮЧЕНА.
 *
 * Возможность, которую надо сперва найти в настройках, не спасёт никого,
 * а спасает она от ошибки, которую иначе не исправить ничем, кроме второго
 * письма с извинениями. Пять, а не тридцать: задержка настоящая, эти
 * секунды письма у получателя нет.
 */
export const DEFAULT_UNDO_SEND_SECONDS = 5;

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
