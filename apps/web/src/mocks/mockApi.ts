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
import type { MessageFull, MessagesPage } from '../api/types';
import { blockRemoteImages } from '../lib/externalImages';
import { expandMessage, mockAccount, mockFolders, mockMessages } from './mockData';
import {
  mockAiClassify,
  mockAiContinue,
  mockAiExtract,
  mockAiForget,
  mockAiGiveConsent,
  mockAiOutbound,
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
    // Форма ответа сервера: { ok, sentMessageId }
    return { ok: true, sentMessageId: `sent:${Math.floor(Math.random() * 10_000)}` };
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

  async uploadAttachment(file) {
    await delay(300);
    return { id: `upload-${Date.now()}`, filename: file.name, size: file.size, mimeType: file.type };
  },

  // Настоящих байтов в заглушках нет — отдаём столько, сколько заявлено
  // в описании вложения, чтобы «Из Почты» можно было посмотреть без бэкенда.
  async getMessagePart(messageId, partId) {
    await delay(200);
    const message = messages.find((m) => m.id === messageId);
    if (!message) {
      throw new ApiError(404, `/api/messages/${messageId}/parts/${partId}`, 'Письмо не найдено', 'NOT_FOUND');
    }
    const part = expandMessage(message).attachments.find((a) => a.partId === partId);
    if (!part) {
      throw new ApiError(404, `/api/messages/${messageId}/parts/${partId}`, 'Часть письма не найдена', 'NOT_FOUND');
    }
    return new Blob([new Uint8Array(Math.min(part.size, 4096))], { type: part.mimeType });
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

  async aiOutbound(messageId) {
    await delay(200);
    return mockAiOutbound(messageId);
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
