/**
 * DTO уровня HTTP API. Доменные модели приходят из @mail-true/shared,
 * здесь — только формы запросов/ответов конкретных маршрутов.
 * Бэкенд пишется параллельно и следует тому же контракту.
 */

import type { DraftPayload, MailAddress, Message, MessageFlags, MessageListPage } from '@mail-true/shared';

/**
 * Полное письмо в том виде, в каком его отдаёт `GET /api/messages/:id`:
 * доменная модель плюс счётчик заблокированных внешних картинок.
 *
 * Имя отдельное, потому что читается это письмо иначе, чем сводка в списке:
 * с параметром `?images=1` или без него (см. `MailApi.getMessage`).
 */
export interface MessageFull extends Message {
  /** Сколько внешних картинок сервер заблокировал в теле письма. */
  blockedRemote?: number;
}

/** POST /api/messages/flags — изменить флаги у набора писем. */
export interface FlagsRequest {
  /** Составные идентификаторы `${folderId}:${uid}`. */
  ids: string[];
  /** Какие флаги выставить/снять. Отсутствующие — не трогать. */
  set: Partial<MessageFlags>;
}

/**
 * Тело запроса флагов НА ПРОВОДЕ.
 *
 * Сервер (`apps/api/src/routes/messages.ts`) ждёт флаги первым уровнем:
 * `{ ids, seen?, flagged?, deleted? }`. Интерфейс же удобнее описывает их
 * объектом `set`. Расхождение стоило дорого: настоящий API на вложенный
 * `set` отвечал 400 «Не указано ни одного флага», а отказ мутации никто
 * не показывал — пометка прочитанным просто молча не работала.
 */
export interface FlagsWireRequest {
  ids: string[];
  seen?: boolean;
  flagged?: boolean;
  deleted?: boolean;
}

/** Переводит внутреннюю форму запроса флагов в серверную. */
export function toFlagsWire(request: FlagsRequest): FlagsWireRequest {
  const wire: FlagsWireRequest = { ids: request.ids };
  if (request.set.seen !== undefined) wire.seen = request.set.seen;
  if (request.set.flagged !== undefined) wire.flagged = request.set.flagged;
  if (request.set.deleted !== undefined) wire.deleted = request.set.deleted;
  return wire;
}

export interface FlagsResponse {
  updated: number;
}

/** POST /api/messages/move — переместить письма в папку. */
export interface MoveRequest {
  ids: string[];
  targetFolderId: string;
}

export interface MoveResponse {
  moved: number;
}

/** POST /api/messages/send */
export interface SendRequest extends DraftPayload {}

/** Ответ сервера на отправку: `{ ok, sentMessageId }`. */
export interface SendResponse {
  ok: boolean;
  /** Составной идентификатор копии в «Отправленных» или null. */
  sentMessageId: string | null;
}

/**
 * POST /api/drafts — сохранить черновик.
 *
 * Сервер отвечает `{ ok, draftId, draftUid }` и времени сохранения не
 * присылает — раньше интерфейс показывал «Сохранено в Invalid Date».
 * Время проставляет клиент, поэтому поле необязательное.
 */
export interface DraftSaveResponse {
  ok?: boolean;
  draftId?: string | null;
  draftUid: number | null;
  savedAt: string;
}

/** POST /api/uploads — загрузка вложения (multipart/form-data, поле `file`). */
export interface UploadResponse {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
}

/** Сервер отвечает на загрузку списком файлов, а не одним файлом. */
export interface UploadsResponse {
  files: UploadResponse[];
}

/** GET /api/auth/session — кто вошёл. */
export interface SessionInfo {
  authenticated: boolean;
  email: string;
}

/**
 * События, прилетающие по WebSocket /ws.
 *
 * Форма — та, что сервер шлёт на самом деле (`apps/api/src/ws.ts`, таблица
 * в docs/api.md). Раньше здесь были придуманные имена `message.new`,
 * `message.flags`, `message.moved`, `folder.counters`, каких сервер не
 * отправляет никогда. Разницы никто не замечал только потому, что подписка
 * на любое событие просто перечитывает списки.
 */
export type WsEvent =
  /** Соединение установлено. */
  | { type: 'ready' }
  /** Пришло новое письмо (IMAP IDLE). */
  | {
      type: 'new-message';
      folderId: string;
      id: string;
      uid: number;
      from: MailAddress | null;
      subject: string;
      date: string;
    }
  /** IDLE-соединение потеряно — сервер переустанавливает наблюдение. */
  | { type: 'idle-lost' }
  | { type: 'error'; error: string };

/** Параметры GET /api/messages (сериализуются в query string). */
export type { MessageListQuery, MessageListPage } from '@mail-true/shared';
export type MessagesPage = MessageListPage;
