/**
 * Доменная модель почты. Общий контракт между API и веб-интерфейсом.
 */

/** Служебное назначение папки. IMAP-имя папки может быть любым. */
export type FolderRole =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'spam'
  | 'trash'
  | 'archive'
  | 'custom';

export interface Folder {
  /** Стабильный идентификатор для URL: 'inbox', 'sent', 'custom-1'. */
  id: string;
  /** Полное IMAP-имя, например 'INBOX' или 'Личное/Счета'. */
  path: string;
  /** Отображаемое имя последнего сегмента пути. */
  name: string;
  role: FolderRole;
  /** Идентификатор родительской папки для вложенных папок. */
  parentId: string | null;
  /** Глубина вложенности: 0 для папок верхнего уровня. */
  depth: number;
  unreadCount: number;
  totalCount: number;
  /** Папка не может быть переименована или удалена (системная). */
  system: boolean;
  /** Значение IMAP UIDVALIDITY — при изменении локальный кэш недействителен. */
  uidValidity: number;
}

export interface MailAddress {
  /** Отображаемое имя из заголовка, если оно есть. */
  name: string | null;
  address: string;
}

export interface AttachmentInfo {
  /** IMAP-номер части тела, например '2' или '1.2'. */
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Встроенное изображение (Content-Disposition: inline) с этим Content-ID. */
  contentId: string | null;
  inline: boolean;
}

export interface MessageFlags {
  seen: boolean;
  /** Флаг «важное» — в интерфейсе это восклицательный знак. */
  flagged: boolean;
  answered: boolean;
  forwarded: boolean;
  draft: boolean;
  deleted: boolean;
}

/** Строка в списке писем. Тело не загружается. */
export interface MessageSummary {
  /** Составной идентификатор `${folderId}:${uid}` — уникален в пределах аккаунта. */
  id: string;
  folderId: string;
  uid: number;
  /** Идентификатор цепочки: письма одной переписки имеют общее значение. */
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  /** Первые ~200 символов текста для серой подписи в строке списка. */
  snippet: string;
  /** Дата в формате ISO 8601 (UTC). */
  date: string;
  flags: MessageFlags;
  hasAttachments: boolean;
  /** Названия вложений для показа плашками прямо в списке. */
  attachmentNames: string[];
  /** Пользовательские метки (IMAP keywords), кроме системных флагов. */
  labels: string[];
  /** Письмо закреплено вверху списка. */
  pinned: boolean;
  sizeBytes: number;
}

/** Полное письмо с телом. */
export interface Message extends MessageSummary {
  /** Значение заголовка Message-ID. */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  replyTo: MailAddress[];
  bcc: MailAddress[];
  /** Продезинфицированный HTML; ссылки на встроенные картинки уже переписаны. */
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: AttachmentInfo[];
  /** Заголовки, которые могут понадобиться интерфейсу (Return-Path, List-Unsubscribe и т. п.). */
  headers: Record<string, string>;
  /** Результаты проверки подлинности отправителя. */
  authentication: {
    spf: AuthResult;
    dkim: AuthResult;
    dmarc: AuthResult;
  };
  /**
   * Сколько внешних картинок сервер заблокировал в теле письма.
   *
   * `GET /api/messages/:id` возвращает это поле всегда — по нему интерфейс
   * рисует плашку «Показать картинки». Поле необязательное только потому,
   * что письмо в таком же виде собирают заглушки интерфейса, где блокировать
   * нечего; сам сервер его не пропускает никогда.
   */
  blockedRemote?: number;
  /**
   * Разбор письма не дал ни одной текстовой части, и текст взят из исходника
   * как есть.
   *
   * Нужно, чтобы интерфейс отличал «в письме нет текста» от «текст есть, но
   * разобрать его не вышло». Раньше на проводе оба случая выглядели
   * одинаково — пустое тело, — и человек, получив письмо с испорченным
   * разделителем частей, видел совершенно пустую страницу и не мог узнать,
   * что письмо на самом деле не пустое.
   *
   * Такие письма встречаются: разделитель портят самописные рассылки и
   * пересылка через старые шлюзы. Почтовые программы в этом случае
   * показывают письмо как есть — так же поступаем и мы.
   */
  bodyRecovered?: boolean;
}

export type AuthResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';

/** Цепочка писем в режиме группировки по переписке. */
export interface Thread {
  id: string;
  messageIds: string[];
  /** Сводка последнего письма в цепочке — она рисуется в списке. */
  latest: MessageSummary;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  /** Уникальные участники переписки в порядке появления. */
  participants: MailAddress[];
}

export interface MessageListQuery {
  folderId: string;
  /** Смещение от начала списка (новые письма первыми). */
  offset: number;
  limit: number;
  /** Группировать письма в цепочки. */
  threaded: boolean;
  filter: MessageFilter;
  search?: string;
  /**
   * Загружать ли сниппеты писем. Они дороже остального списка на порядок
   * (каждый — отдельная докачка куска текстовой части), поэтому список
   * умеет обходиться без них. По умолчанию — загружать.
   * В строке запроса передаётся как `snippets=0|1`.
   */
  snippets?: boolean;
}

export type MessageFilter = 'all' | 'unread' | 'flagged' | 'with-attachments';

export interface MessageListPage {
  items: MessageSummary[];
  /** Общее число писем, подходящих под запрос. */
  total: number;
  offset: number;
  limit: number;
}

/** Черновик письма, отправляемый на сервер. */
export interface DraftPayload {
  /** UID существующего черновика; отсутствует для нового письма. */
  draftUid?: number;
  /**
   * Идентификатор окна написания, постоянный на всё время его жизни.
   *
   * Нужен автосохранению: пока у черновика ещё нет UID, только по этому
   * ключу сервер и может понять, что несколько одновременных сохранений
   * относятся к одному письму. Без него таймер автосохранения вместе с
   * явным «сохранить» плодят копии черновика.
   */
  draftKey?: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyHtml: string;
  /** Идентификаторы загруженных вложений, полученные от POST /api/uploads. */
  attachmentIds: string[];
  /** Message-ID письма, на которое отвечаем. */
  inReplyTo?: string;
  references?: string[];
  /** Отложенная отправка: ISO-дата, когда письмо должно уйти. */
  sendAt?: string;
}

export interface Account {
  id: string;
  email: string;
  displayName: string;
  /** Инициалы или URL аватара для кружка в шапке. */
  avatarUrl: string | null;
  quotaUsedBytes: number;
  quotaLimitBytes: number;
  signature: string;
  /**
   * Дата заведения ящика (ISO). `null`, когда узнать её неоткуда —
   * база почтового стека API не обязательна. Раньше в этом случае
   * подставлялась «01.01.1970», и профиль показывал заведомую неправду.
   */
  createdAt: string | null;
}
