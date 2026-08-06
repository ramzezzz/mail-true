/**
 * Типы раздела настроек: общие параметры ящика, подписи, правила фильтрации.
 *
 * Набор полей взят один в один с интерфейса настроек mail.ru
 * (docs/features-mailru.md, разделы «Общие настройки» и «Правила
 * фильтрации»), потому что интерфейс должен повторяться до мелочей.
 */
import {
  DEFAULT_THEME_SETTING,
  DEFAULT_WALLPAPER_CHOICE,
  type ThemeSetting,
} from '@mail-true/shared';
import { DEFAULT_UNDO_SEND_SECONDS } from '../mail/deferred-send.js';

export type { ThemeSetting };

/* ------------------------------------------------------------------ */
/* Общие настройки                                                      */
/* ------------------------------------------------------------------ */

/** Что показывать после удаления письма. */
export type AfterDelete = 'list' | 'next';

/** Автоответчик: текст и срок действия. */
export interface AutoReplySettings {
  enabled: boolean;
  subject: string | null;
  text: string;
  /** ISO-даты начала и конца действия; null — без границы. */
  from: string | null;
  until: string | null;
  /** Не отвечать одному адресату чаще, чем раз в столько дней. */
  days: number;
}

/** Общие настройки ящика. Отсутствие строки в базе = эти значения. */
export interface MailSettings {
  accountEmail: string;
  /** Имя отправителя в заголовке From. null — берётся из адреса. */
  senderName: string | null;
  /**
   * Оформление: выбранная тема и фон «обойной» темы.
   *
   * Лежит здесь, а не в отдельной таблице, потому что это такая же
   * настройка ящика, как всё остальное в этом типе: требование заказчика
   * — «тема оформления должна запоминаться для каждого юзера», то есть
   * за учётной записью, а не за браузером (см. миграцию 0009).
   */
  theme: ThemeSetting;
  /** Выбор фона: 'preset:<id>' | 'custom' | '' (не выбирали). */
  wallpaper: string;
  /** Включать содержимое исходного письма в ответ. */
  replyQuote: boolean;
  afterDelete: AfterDelete;
  notifyBrowser: boolean;
  notifyTab: boolean;
  /** Автоматически пополнять адресную книгу. */
  collectContacts: boolean;
  /**
   * Показывать логотипы доменов вместо букв в кружках списка писем.
   *
   * По умолчанию ВЫКЛЮЧЕНО, и это не осторожность ради осторожности:
   * включение означает, что сервер начнёт ходить в интернет за картинками
   * доменов, с которых пришли письма ЭТОМУ человеку. Пусть решение
   * принимает он, а не мы за него. Сами письма при этом наружу не уходят
   * никуда — см. apps/api/src/logos/.
   */
  senderLogos: boolean;
  /**
   * Сколько секунд после нажатия «Отправить» письмо ещё можно вернуть.
   *
   * Ноль — возможность выключена, письмо уходит сразу. Ненулевое значение
   * означает, что письмо эти секунды лежит в серверной очереди
   * (apps/api/src/mail/deferred-send.ts), а не у получателя. Разрешённые
   * значения перечислены в UNDO_SEND_CHOICES.
   */
  undoSendSeconds: number;
  /**
   * Показывать список разговорами, а не письмами: ответ на письмо занимает
   * ту же строку, что и само письмо, а не заводит вторую с той же темой.
   *
   * По умолчанию ВКЛЮЧЕНО — так же, как у mail.ru, который мы повторяем.
   * Настройка относится к списку целиком, но действует не везде: в
   * черновиках, корзине, спаме и отложенных сервер её не применяет,
   * и почему — объяснено в mail/threads.ts (threadingAllowed).
   */
  threadedList: boolean;
  autoReply: AutoReplySettings;
  updatedAt: string | null;
}

/** Заплатка автоответчика: передаются только изменяемые поля. */
export type AutoReplyPatch = {
  [K in keyof AutoReplySettings]?: AutoReplySettings[K] | undefined;
};

/** Заплатка общих настроек: передаются только изменяемые поля. */
export interface MailSettingsPatch {
  senderName?: string | null | undefined;
  theme?: ThemeSetting | undefined;
  wallpaper?: string | undefined;
  replyQuote?: boolean | undefined;
  afterDelete?: AfterDelete | undefined;
  notifyBrowser?: boolean | undefined;
  notifyTab?: boolean | undefined;
  collectContacts?: boolean | undefined;
  senderLogos?: boolean | undefined;
  undoSendSeconds?: number | undefined;
  threadedList?: boolean | undefined;
  autoReply?: AutoReplyPatch | undefined;
}

/** Подпись. Подписей несколько, одна — по умолчанию. */
export interface Signature {
  id: number;
  name: string;
  bodyHtml: string;
  isDefault: boolean;
  position: number;
}

/* ------------------------------------------------------------------ */
/* Правила фильтрации                                                   */
/* ------------------------------------------------------------------ */

/**
 * Поле письма, по которому идёт проверка.
 * «Переадресовано от/для» — это заголовки Resent-From / Resent-To
 * (RFC 5322 §3.6.6), их и проверяет Sieve.
 *
 * 'body' и 'attachment' — не заголовки, а само письмо: текст (Sieve `body`)
 * и наличие вложения (Sieve `header :mime`). Без них не выражается самое
 * частое правило — «письма со счетами» (docs/gaps.md, раздел «Мелочи»).
 */
export type FilterField =
  | 'from'
  | 'to'
  | 'subject'
  | 'cc'
  | 'resent-from'
  | 'resent-to'
  | 'size'
  /** Текст письма целиком — как `text:` у Яндекса. */
  | 'body'
  /** Наличие вложения: значение условия не используется. */
  | 'attachment';

/** Оператор сравнения. По умолчанию — «содержит». */
export type FilterOperator =
  | 'contains'
  | 'not-contains'
  | 'is'
  | 'not-is'
  | 'matches'
  | 'not-matches'
  /** Только для поля «Размер»: больше / меньше указанного числа килобайт. */
  | 'greater'
  | 'less'
  /** Только для поля «Вложение»: есть / нет. */
  | 'has'
  | 'has-not';

export interface FilterCondition {
  field: FilterField;
  op: FilterOperator;
  /** Для поля size — число килобайт в виде строки; для attachment — пусто. */
  value: string;
}

/** Автоответ конкретного правила (отдельно от общего автоответчика). */
export interface FilterAutoReply {
  subject: string | null;
  text: string;
  days: number;
}

/**
 * Как правило удаляет письмо.
 *
 * 'trash' — в корзину: письмо на месте, его видно и можно достать.
 * 'purge' — безвозвратно (`discard` в Sieve): письма не будет НИГДЕ, и
 * вернуть его нельзя ничем — ни корзиной, ни поддержкой, ни резервной
 * копией ящика, потому что оно в ящик и не попадало. Поэтому умолчанием
 * всегда должно быть 'trash', а 'purge' — только явным выбором человека,
 * с предупреждением в интерфейсе.
 */
export type FilterDeleteMode = 'trash' | 'purge';

/** Действия правила. Порядок исполнения задаёт генератор Sieve. */
export interface FilterActions {
  /** Полный IMAP-путь папки. null — не перекладывать. */
  folder: string | null;
  markRead: boolean;
  flag: boolean;
  /**
   * Ключевые слова IMAP своих меток (`mt-…`, см. mail/labels.ts), которые
   * правило ставит письму. Хранятся ключи, а не имена: имя метки человек
   * меняет когда захочет, а ключ в письме не меняется никогда.
   */
  labels: string[];
  /** Удалить письмо. null — не удалять. */
  deleteMessage: FilterDeleteMode | null;
  /** Переслать копию сообщения на эти адреса. */
  forwardTo: string[];
  autoReply: FilterAutoReply | null;
  /** Применять правило к письмам, помеченным как спам. */
  applyToSpam: boolean;
  /** После срабатывания применять другие фильтры (по умолчанию да). */
  continueFiltering: boolean;
}

export interface FilterRule {
  id: number;
  name: string;
  position: number;
  enabled: boolean;
  /** Автофильтр, заведённый сервисом; в интерфейсе скрыт под флажком. */
  auto: boolean;
  matchMode: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterActions;
}

/** Правило без служебных полей — то, что приходит от интерфейса. */
export type FilterRuleInput = Omit<FilterRule, 'id' | 'position'> & {
  position?: number;
};

/** Значения действий по умолчанию (совпадают с mail.ru). */
export const DEFAULT_ACTIONS: FilterActions = {
  folder: null,
  markRead: false,
  flag: false,
  labels: [],
  deleteMessage: null,
  forwardTo: [],
  autoReply: null,
  applyToSpam: false,
  continueFiltering: true,
};

/** Значения общих настроек по умолчанию. */
export function defaultMailSettings(email: string): MailSettings {
  return {
    accountEmail: email,
    senderName: null,
    theme: DEFAULT_THEME_SETTING,
    wallpaper: DEFAULT_WALLPAPER_CHOICE,
    replyQuote: true,
    afterDelete: 'list',
    notifyBrowser: false,
    notifyTab: true,
    collectContacts: true,
    // Выключено намеренно: см. пояснение у поля в MailSettings.
    senderLogos: false,
    // Включена намеренно: см. DEFAULT_UNDO_SEND_SECONDS в mail/deferred-send.ts
    undoSendSeconds: DEFAULT_UNDO_SEND_SECONDS,
    // Включена намеренно: у mail.ru группировка по переписке — поведение
    // по умолчанию, и в этом заметная часть привычности интерфейса.
    threadedList: true,
    autoReply: {
      enabled: false,
      subject: null,
      text: '',
      from: null,
      until: null,
      days: 7,
    },
    updatedAt: null,
  };
}
