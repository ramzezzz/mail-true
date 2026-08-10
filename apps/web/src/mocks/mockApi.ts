/**
 * Реализация MailApi на заглушечных данных — интерфейс можно смотреть
 * автономно, без бэкенда. Состояние живёт в памяти вкладки: флаги и
 * перемещения работают, но пропадают при перезагрузке.
 *
 * ВАЖНО: заглушка обязана отвечать ровно тем же, что настоящий API.
 * На расхождениях мы обожглись четырежды (папки-обёртка, размер страницы,
 * пустое имя отправителя, блокировка картинок), поэтому здесь повторяются
 * и форма ответа, и отказы сервера — вплоть до 404 на несуществующее письмо
 * и 400, когда в запросе флагов не указано ни одного флага.
 */

import type { MessageListQuery, MessageSummary } from '@mail-true/shared';
import type { GetMessageOptions, MailApi } from '../api/client';
import { ApiError } from '../api/http';
import type { MessageFull, MessagesPage, SendFailureNotice } from '../api/types';
import { DEFAULT_UNDO_SEND_SECONDS } from '../api/settingsTypes';
import { blockRemoteImages } from '../lib/externalImages';
import { mockPartBytes } from './mockAttachments';
import { expandMessage, mockAccount, mockFolders, mockMessages } from './mockData';
import {
  mockAiClassify,
  mockAiContinue,
  mockAiExtract,
  mockAiForget,
  mockAiGiveConsent,
  mockAiReplies,
  mockAiRevokeConsent,
  mockAiRewrite,
  mockAiSearchQuery,
  mockAiSetFeatures,
  mockAiState,
  mockAiSummarize,
  mockAiTranslate,
  mockAiUsage,
} from './mockAi';

/** Имитация сетевой задержки, чтобы были видны спиннеры. */
const delay = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// копии, чтобы мутации не портили исходники модулей
/**
 * Список папок общий с заглушками настроек (`mockSettings.ts`): папка,
 * созданная в разделе «Папки», обязана тут же появиться в левом меню —
 * иначе на заглушках нельзя проверить сценарий целиком.
 */
export const folders = mockFolders.map((f) => ({ ...f }));
let messages: MessageSummary[] = mockMessages.map((m) => ({ ...m, flags: { ...m.flags } }));

function recountFolders(): void {
  for (const f of folders) {
    const own = messages.filter((m) => m.folderId === f.id);
    f.totalCount = own.length;
    f.unreadCount = own.filter((m) => !m.flags.seen).length;
  }
}
recountFolders();

function applyQuery(query: MessageListQuery): MessageSummary[] {
  let result = messages.filter((m) => m.folderId === query.folderId);
  if (query.filter === 'unread') result = result.filter((m) => !m.flags.seen);
  if (query.filter === 'flagged') result = result.filter((m) => m.flags.flagged);
  if (query.filter === 'with-attachments') result = result.filter((m) => m.hasAttachments);
  /*
   * Отбор по метке — как у настоящего сервера, условием поиска, а не
   * просеиванием готовой страницы. Иначе заглушка вела бы себя иначе, чем
   * ящик, ровно в том месте, ради которого отбор и переезжал на сервер.
   *
   * Правило объединения то же: метка стоит на переписке, если стоит хоть
   * на одном её письме.
   */
  if (query.label) {
    const label = query.label.toLowerCase();
    result = result.filter((m) =>
      (m.thread ? m.thread.labels : m.labels).some((l) => l.toLowerCase() === label),
    );
  }
  if (query.search) {
    const needle = query.search.toLowerCase();
    result = result.filter(
      (m) =>
        m.subject.toLowerCase().includes(needle) ||
        m.snippet.toLowerCase().includes(needle) ||
        (m.from.name ?? '').toLowerCase().includes(needle) ||
        m.from.address.toLowerCase().includes(needle),
    );
  }
  return result.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Удалить все письма папки — «Очистить» в настройках папок.
 * Живёт здесь, а не в mockSettings, потому что список писем приватный:
 * иначе счётчики разъехались бы с содержимым.
 */
export function clearFolderMessages(folderId: string): number {
  const before = messages.length;
  messages = messages.filter((m) => m.folderId !== folderId);
  recountFolders();
  return before - messages.length;
}

/* --- Отмена отправки -------------------------------------------------
 * Письмо, отданное «на отправку», несколько секунд лежит НА СЕРВЕРЕ.
 * Заглушке приходится это повторять: без очереди на её стороне плашка
 * «Письмо отправлено · Отменить» либо не появлялась бы вовсе, либо врала бы
 * (браузерный таймер отменяет не то же самое, что серверная очередь). */

/** Идентификаторы писем, которые «лежат в очереди» прямо сейчас. */
const pending = new Set<string>();
let pendingSeq = 0;

/**
 * Срок отмены из настроек. Живёт здесь, а не в mockSettings, чтобы не
 * заводить круговую зависимость между заглушками: настройки и так берут
 * у этого модуля список папок.
 */
let undoSeconds = DEFAULT_UNDO_SEND_SECONDS;

/** Настройки сохранили — заглушка отправки обязана об этом узнать. */
export function setMockUndoSeconds(value: number): void {
  undoSeconds = value;
}

/** Извещения о неудавшейся отправке (см. getSendFailures). */
let sendFailures: SendFailureNotice[] = [];

/** Позволяет проверкам и ручному осмотру завести такое извещение. */
export function addMockSendFailure(notice: SendFailureNotice): void {
  sendFailures = [...sendFailures, notice];
}

export const mockApi: MailApi = {
  async getSession() {
    await delay(80);
    return { authenticated: true, email: mockAccount.email };
  },

  async login(email) {
    await delay(300);
    return { authenticated: true, email };
  },

  async logout() {
    await delay(120);
  },

  async getAccount() {
    await delay();
    return mockAccount;
  },

  async getFolders() {
    await delay();
    return folders.map((f) => ({ ...f }));
  },

  async getMessages(query): Promise<MessagesPage> {
    await delay();
    const all = applyQuery(query);
    return {
      items: all.slice(query.offset, query.offset + query.limit),
      total: all.length,
      offset: query.offset,
      limit: query.limit,
    };
  },

  /**
   * Как настоящий сервер: без `images` тело приходит с прозрачными
   * пикселями и адресами в `data-mt-src`, а рядом — счётчик `blockedRemote`.
   * Раньше заглушка отдавала тело с живыми `src="http…"`, и блокировку
   * картинок проверяли на данных, которых в жизни не бывает.
   */
  async getMessage(id, options: GetMessageOptions = {}): Promise<MessageFull> {
    await delay();
    const summary = messages.find((m) => m.id === id);
    if (!summary) throw new ApiError(404, `/api/messages/${id}`, 'Письмо не найдено', 'NOT_FOUND');
    const message = expandMessage(summary);
    if (options.images) return { ...message, blockedRemote: 0 };
    const blocked = blockRemoteImages(message.bodyHtml ?? '');
    return { ...message, bodyHtml: blocked.html, blockedRemote: blocked.blockedRemote };
  },

  async setFlags({ ids, set }) {
    await delay(120);
    // Сервер отвечает 400, если не указан ни один флаг
    if (set.seen === undefined && set.flagged === undefined && set.deleted === undefined) {
      throw new ApiError(400, '/api/messages/flags', 'Не указано ни одного флага', 'BAD_REQUEST');
    }
    let updated = 0;
    for (const m of messages) {
      if (ids.includes(m.id)) {
        Object.assign(m.flags, set);
        updated += 1;
      }
    }
    recountFolders();
    return { updated };
  },

  async moveMessages({ ids, targetFolderId }) {
    await delay(120);
    let moved = 0;
    messages = messages.map((m) => {
      if (!ids.includes(m.id)) return m;
      moved += 1;
      return { ...m, folderId: targetFolderId, id: `${targetFolderId}:${m.uid}` };
    });
    recountFolders();
    return { moved };
  },

  async sendMessage(request) {
    await delay(400);
    if (request.to.length === 0 && request.cc.length === 0 && request.bcc.length === 0) {
      throw new ApiError(400, '/api/messages/send', 'Не указан ни один получатель', 'BAD_REQUEST');
    }
    console.info('[mock] отправка письма', request);
    // Отложенное письмо сервер не отправляет, а кладёт в очередь и отвечает
    // иначе. Заглушка обязана отличать эти два ответа: иначе окно написания
    // скажет «отправлено» о письме, которого у получателя ещё нет.
    if (request.sendAt && Date.parse(request.sendAt) > Date.now() + 60_000) {
      return { ok: true, scheduled: true, sendAt: request.sendAt, sentMessageId: null };
    }
    // Отмена отправки: письмо принято, но несколько секунд ещё лежит
    // в очереди НА СЕРВЕРЕ. Заглушка отвечает так же, как настоящий API,
    // иначе плашку «Письмо отправлено · Отменить» негде было бы увидеть.
    if (undoSeconds > 0) {
      const pendingId = `pending-${String(++pendingSeq)}`;
      pending.add(pendingId);
      return {
        ok: true,
        pendingId,
        undoUntil: new Date(Date.now() + undoSeconds * 1000).toISOString(),
        sentMessageId: null,
      };
    }
    // Форма ответа сервера: { ok, sentMessageId }
    return { ok: true, sentMessageId: `sent:${Math.floor(Math.random() * 10_000)}` };
  },

  /**
   * Отзыв письма из очереди отмены.
   *
   * `cancelled: false` — не поломка, а обычный исход гонки: письмо успело
   * уйти. Заглушка обязана уметь отвечать и так, иначе этот случай
   * (самый неприятный из всех) в интерфейсе не увидит никто.
   */
  async undoSend({ pendingId }) {
    await delay(120);
    return { ok: true, cancelled: pending.delete(pendingId) };
  },

  /*
   * Извещения о письмах, которые отправить не удалось. Заглушка держит
   * свой список, чтобы плашку «письмо не отправлено» можно было увидеть
   * и без сломанного SMTP: до этого её нельзя было ни посмотреть, ни
   * проверить, не ломая стенд.
   */
  async getSendFailures() {
    await delay(80);
    return [...sendFailures];
  },

  async ackSendFailure(id) {
    await delay(80);
    sendFailures = sendFailures.filter((n) => n.id !== id);
  },

  /** Очередь отложенных писем: на стенде она всегда пуста. */
  async getScheduled() {
    await delay(60);
    return [];
  },

  async saveDraft(request) {
    await delay(200);
    const draftUid = request.draftUid ?? Math.floor(Math.random() * 10_000);
    // Сервер отвечает { ok, draftId, draftUid } — времени сохранения в
    // ответе нет, его проставляет клиент.
    return {
      ok: true,
      draftId: `drafts:${draftUid}`,
      draftUid,
      savedAt: new Date().toISOString(),
    };
  },

  /**
   * Чтение черновика обратно в окно написания. Заглушке взять настоящее
   * письмо неоткуда, поэтому она собирает поля из того, что знает о письме
   * в папке «Черновики», — форма ответа при этом та же, что у сервера.
   */
  async getDraft(draftUid) {
    await delay(200);
    const message = messages.find((m) => m.id === `drafts:${draftUid}`);
    if (!message) {
      throw new ApiError(404, `/api/drafts/${draftUid}`, 'Черновик не найден', 'NOT_FOUND');
    }
    const full = expandMessage(message);
    return {
      draftUid,
      to: message.to,
      cc: message.cc,
      bcc: [],
      subject: message.subject,
      bodyHtml: full.bodyHtml ?? `<div>${message.snippet}</div>`,
      attachments: full.attachments.map((a) => ({
        id: `draft-part-${a.partId}`,
        filename: a.filename,
        size: a.size,
      })),
      inReplyTo: null,
      references: [],
      requestReadReceipt: false,
    };
  },

  /**
   * Исходник письма. Настоящих байтов у заглушки нет — собираем правдоподобный
   * RFC822 из того, что известно: интерфейс должен быть проверяем и без
   * бэкенда, а форма ответа (обычный текст) та же.
   */
  async getMessageSource(messageId) {
    await delay(200);
    const message = messages.find((m) => m.id === messageId);
    if (!message) {
      throw new ApiError(
        404,
        `/api/messages/${messageId}/source`,
        'Письмо не найдено',
        'NOT_FOUND',
      );
    }
    const full = expandMessage(message);
    const headers = [
      `Return-Path: <${message.from.address}>`,
      `From: ${message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address}`,
      `To: ${message.to.map((a) => a.address).join(', ')}`,
      `Subject: ${message.subject}`,
      `Date: ${new Date(message.date).toUTCString()}`,
      `Message-ID: <${message.uid}@mail.local>`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
    ];
    return `${headers.join('\r\n')}\r\n\r\n${full.bodyHtml ?? full.bodyText ?? ''}\r\n`;
  },

  async uploadAttachment(file) {
    await delay(300);
    return {
      id: `upload-${Date.now()}`,
      filename: file.name,
      size: file.size,
      mimeType: file.type,
    };
  },

  /*
   * Байты вложения.
   *
   * Раньше отдавались нули — для «Из Почты» этого хватало (там файл только
   * пересылается дальше), но предпросмотр на нулях показывал бы пустой
   * квадрат и на заглушках выглядел бы сломанным. Поэтому картинка,
   * PDF и текст отдаются НАСТОЯЩИМИ — маленькими, но такими, какими их
   * видит браузер: только так «интерфейс работает без сервера» остаётся
   * правдой и для предпросмотра.
   *
   * Всё остальное (таблицы, архивы) по-прежнему нули: их предпросмотра нет
   * ни здесь, ни на сервере, и содержимое ни на что не влияет.
   */
  async getMessagePart(messageId, partId) {
    await delay(200);
    const message = messages.find((m) => m.id === messageId);
    if (!message) {
      throw new ApiError(
        404,
        `/api/messages/${messageId}/parts/${partId}`,
        'Письмо не найдено',
        'NOT_FOUND',
      );
    }
    const part = expandMessage(message).attachments.find((a) => a.partId === partId);
    if (!part) {
      throw new ApiError(
        404,
        `/api/messages/${messageId}/parts/${partId}`,
        'Часть письма не найдена',
        'NOT_FOUND',
      );
    }
    const sample = mockPartBytes(part.filename, part.mimeType);
    return new Blob([sample ?? new Uint8Array(Math.min(part.size, 4096))], { type: part.mimeType });
  },

  /**
   * Заглушке отправлять некуда, но форму ответа она обязана повторять:
   * интерфейс по ней решает, показывать ли плашку дальше.
   */
  async sendReadReceipt(messageId, send) {
    await delay(200);
    const message = messages.find((m) => m.id === messageId);
    if (!message) {
      throw new ApiError(
        404,
        `/api/messages/${messageId}/read-receipt`,
        'Письмо не найдено',
        'NOT_FOUND',
      );
    }
    // И отправка, и отказ помечают письмо: вопрос больше не возвращается
    message.flags.mdnSent = true;
    return { ok: true, sent: send, alreadyAnswered: false };
  },

  subscribe() {
    // событий в моках нет; возвращаем пустую отписку
    return () => {};
  },

  /* --- Помощник на основе ИИ ---------------------------------------- */

  async getAiState() {
    await delay(120);
    return mockAiState();
  },

  async giveAiConsent(features) {
    await delay(200);
    return mockAiGiveConsent(features);
  },

  async revokeAiConsent() {
    await delay(200);
    return mockAiRevokeConsent();
  },

  async setAiFeatures(features) {
    await delay(150);
    return mockAiSetFeatures(features);
  },

  async aiSummarize(request) {
    // Задержка ощутимая: сервис ИИ медленный, спиннеры должны быть видны
    await delay(900);
    return mockAiSummarize(request);
  },

  async aiClassify(messageId) {
    await delay(600);
    return mockAiClassify(messageId);
  },

  async aiReplies(request) {
    await delay(1100);
    return mockAiReplies(request);
  },

  async aiContinue(request) {
    await delay(700);
    return mockAiContinue(request);
  },

  async aiRewrite(request) {
    await delay(700);
    return mockAiRewrite(request);
  },

  async aiExtract(messageId) {
    await delay(900);
    return mockAiExtract(messageId);
  },

  async aiTranslate(request) {
    await delay(1000);
    return mockAiTranslate(request);
  },

  async aiSearchQuery(query) {
    await delay(600);
    return mockAiSearchQuery(query);
  },

  async aiUsage() {
    await delay(200);
    return mockAiUsage();
  },

  async aiForgetMessage(messageId) {
    await delay(200);
    return mockAiForget(messageId);
  },
};
