/**
 * Типизированный клиент HTTP API (/api/*) и WebSocket (/ws).
 * Все функции следуют контракту packages/shared; бэкенд пишется параллельно.
 */

import type { Account, DraftContent, Folder, MessageListQuery } from '@mail-true/shared';
import { apiFetch, apiFetchBlob, buildQuery } from './http';
import { connectWithRetry } from '../lib/reconnectingSocket';
import { browserClientId } from '../notifications/api';
import type {
  AiClassification,
  AiConsentRevokeResult,
  AiContinuation,
  AiContinueRequest,
  AiEnvelope,
  AiExtraction,
  AiFeatureKey,
  AiOutboundDisclosure,
  AiParsedSearchQuery,
  AiRepliesRequest,
  AiReplyVariants,
  AiRewriteRequest,
  AiRewriteResult,
  AiState,
  AiSummarizeRequest,
  AiSummary,
  AiTranslateRequest,
  AiTranslation,
  AiUsageReport,
} from './aiTypes';
import type {
  DraftSaveResponse,
  FlagsRequest,
  FlagsResponse,
  MessageFull,
  MessagesPage,
  MoveRequest,
  MoveResponse,
  ReadReceiptResponse,
  SendRequest,
  SendResponse,
  SessionInfo,
  UploadResponse,
  UploadsResponse,
  WsEvent,
} from './types';
import { toFlagsWire } from './types';

/** Как читать письмо: с внешними картинками или без них. */
export interface GetMessageOptions {
  /** Попросить сервер отдать тело с настоящими адресами картинок. */
  images?: boolean;
}

/** Единый интерфейс клиента — его же реализуют моки. */
export interface MailApi {
  /** Кто вошёл. Отказ 401 значит «сессии нет». */
  getSession(): Promise<SessionInfo>;
  login(email: string, password: string): Promise<SessionInfo>;
  logout(): Promise<void>;

  getAccount(): Promise<Account>;
  getFolders(): Promise<Folder[]>;
  getMessages(query: MessageListQuery): Promise<MessagesPage>;
  getMessage(id: string, options?: GetMessageOptions): Promise<MessageFull>;
  setFlags(request: FlagsRequest): Promise<FlagsResponse>;
  moveMessages(request: MoveRequest): Promise<MoveResponse>;
  sendMessage(request: SendRequest): Promise<SendResponse>;
  saveDraft(request: SendRequest): Promise<DraftSaveResponse>;
  /**
   * Сохранённый черновик обратно в окно написания. Без этого дописать своё
   * же неотправленное письмо было нельзя: черновик сохранялся и на этом
   * заканчивался.
   */
  getDraft(draftUid: number): Promise<DraftContent>;
  /**
   * Исходник письма целиком (RFC822) — все заголовки и тело как есть.
   * Именно ТЕКСТ, а не разметка: письмо от кого угодно не должно
   * выполниться в интерфейсе.
   */
  getMessageSource(messageId: string): Promise<string>;
  uploadAttachment(file: File): Promise<UploadResponse>;
  /**
   * Байты части письма — вложения или встроенной картинки. Тот же маршрут,
   * по которому вложение скачивается со страницы письма. Нужен «Из Почты»
   * в окне написания: выбранное вложение сначала скачивается отсюда,
   * а потом загружается обратно обычным `POST /api/uploads`.
   */
  getMessagePart(messageId: string, partId: string): Promise<Blob>;
  /**
   * Ответ на просьбу отправителя уведомить о прочтении. `send: false` —
   * человек отказался; уведомление не уходит, но спрашивать второй раз
   * сервер больше не будет.
   */
  sendReadReceipt(messageId: string, send: boolean): Promise<ReadReceiptResponse>;
  /** Подписка на серверные события; возвращает функцию отписки. */
  subscribe(onEvent: (event: WsEvent) => void): () => void;

  /* --- Помощник на основе ИИ (/api/ai/*) -------------------------------
   * Всё начинается с getAiState(): пока `enabled` false, остальные методы
   * интерфейсом не вызываются вовсе — кнопок помощника просто нет. */

  getAiState(): Promise<AiState>;
  /** Дать согласие; без списка возможностей включается набор по умолчанию. */
  giveAiConsent(features?: AiFeatureKey[]): Promise<AiState>;
  /** Отозвать согласие и удалить всё, что помощник насчитал. */
  revokeAiConsent(): Promise<AiConsentRevokeResult>;
  setAiFeatures(features: AiFeatureKey[]): Promise<AiState>;

  aiSummarize(request: AiSummarizeRequest): Promise<AiEnvelope<AiSummary>>;
  aiClassify(messageId: string): Promise<AiEnvelope<AiClassification>>;
  aiReplies(request: AiRepliesRequest): Promise<AiEnvelope<AiReplyVariants>>;
  aiContinue(request: AiContinueRequest): Promise<AiEnvelope<AiContinuation>>;
  aiRewrite(request: AiRewriteRequest): Promise<AiEnvelope<AiRewriteResult>>;
  aiExtract(messageId: string): Promise<AiEnvelope<AiExtraction>>;
  aiTranslate(request: AiTranslateRequest): Promise<AiEnvelope<AiTranslation>>;
  aiSearchQuery(query: string): Promise<AiEnvelope<AiParsedSearchQuery>>;

  /** Что уйдёт наружу по этому письму — БЕЗ отправки (для экрана согласия). */
  aiOutbound(messageId: string): Promise<AiOutboundDisclosure>;
  aiUsage(): Promise<AiUsageReport>;
  /** Забыть всё, что помощник насчитал по одному письму. */
  aiForgetMessage(messageId: string): Promise<{ removed: number }>;
}

export const httpApi: MailApi = {
  getSession: () => apiFetch('/api/auth/session'),

  login: async (email, password) => {
    const result = await apiFetch<{ ok: boolean; email: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return { authenticated: result.ok, email: result.email };
  },

  logout: async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  },

  getAccount: () => apiFetch('/api/account'),

  // Сервер отвечает объектом-обёрткой { folders: [...] }, а интерфейсу нужен
  // сам список. Заглушки отдавали список напрямую, поэтому расхождение не было
  // видно до первого запуска против настоящего API — типы его не ловят, потому
  // что apiFetch приводит ответ к ожидаемому типу без проверки.
  getFolders: async () => {
    const data = await apiFetch<Folder[] | { folders: Folder[] }>('/api/folders');
    return Array.isArray(data) ? data : data.folders;
  },

  getMessages: (query) =>
    apiFetch(
      `/api/messages${buildQuery({
        folderId: query.folderId,
        offset: query.offset,
        limit: query.limit,
        threaded: query.threaded,
        filter: query.filter,
        search: query.search,
      })}`,
    ),

  // Внешние картинки показывает сервер и только по явной просьбе:
  // без `images=1` в теле стоят прозрачные пиксели, а адреса лежат
  // в data-mt-src. Своими силами интерфейс их не «разблокирует».
  getMessage: (id, options) =>
    apiFetch(
      `/api/messages/${encodeURIComponent(id)}${buildQuery({
        images: options?.images ? '1' : undefined,
      })}`,
    ),

  // Флаги уходят первым уровнем: сервер вложенный `set` не понимает
  // и отвечает 400 «Не указано ни одного флага».
  setFlags: (request) =>
    apiFetch('/api/messages/flags', {
      method: 'POST',
      body: JSON.stringify(toFlagsWire(request)),
    }),

  moveMessages: (request) =>
    apiFetch('/api/messages/move', { method: 'POST', body: JSON.stringify(request) }),

  sendMessage: (request) =>
    apiFetch('/api/messages/send', { method: 'POST', body: JSON.stringify(request) }),

  // Времени сохранения сервер не присылает — ставим своё, чтобы в окне
  // написания не появлялось «Сохранено в Invalid Date».
  saveDraft: async (request) => {
    const saved = await apiFetch<{ ok?: boolean; draftId?: string | null; draftUid?: number | null }>(
      '/api/drafts',
      { method: 'POST', body: JSON.stringify(request) },
    );
    return {
      ok: saved.ok ?? true,
      draftId: saved.draftId ?? null,
      draftUid: saved.draftUid ?? null,
      savedAt: new Date().toISOString(),
    };
  },

  getDraft: (draftUid) => apiFetch(`/api/drafts/${encodeURIComponent(String(draftUid))}`),

  // Исходник отдаётся как файл (message/rfc822), поэтому берём его байтами
  // и читаем текстом: apiFetch споткнулся бы о response.json().
  getMessageSource: async (messageId) => {
    const blob = await apiFetchBlob(`/api/messages/${encodeURIComponent(messageId)}/source`);
    return blob.text();
  },

  // Сервер отвечает списком `{ files: [...] }`, даже когда файл один.
  uploadAttachment: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const result = await apiFetch<UploadsResponse | UploadResponse>('/api/uploads', {
      method: 'POST',
      body: form,
    });
    const uploaded = 'files' in result ? result.files[0] : result;
    if (!uploaded) throw new Error('Сервер не вернул загруженный файл');
    return uploaded;
  },

  getMessagePart: (messageId, partId) =>
    apiFetchBlob(
      `/api/messages/${encodeURIComponent(messageId)}/parts/${encodeURIComponent(partId)}`,
    ),

  sendReadReceipt: (messageId, send) =>
    apiFetch(`/api/messages/${encodeURIComponent(messageId)}/read-receipt`, {
      method: 'POST',
      body: JSON.stringify({ send }),
    }),

  /* --- Помощник на основе ИИ ---------------------------------------- */

  getAiState: () => apiFetch('/api/ai/state'),

  giveAiConsent: (features) =>
    apiFetch('/api/ai/consent', {
      method: 'POST',
      body: JSON.stringify(features ? { accept: true, features } : { accept: true }),
    }),

  revokeAiConsent: () => apiFetch('/api/ai/consent', { method: 'DELETE' }),

  setAiFeatures: (features) =>
    apiFetch('/api/ai/features', { method: 'PUT', body: JSON.stringify({ features }) }),

  aiSummarize: (request) =>
    apiFetch('/api/ai/summarize', { method: 'POST', body: JSON.stringify(request) }),

  aiClassify: (messageId) =>
    apiFetch('/api/ai/classify', { method: 'POST', body: JSON.stringify({ messageId }) }),

  aiReplies: (request) =>
    apiFetch('/api/ai/replies', { method: 'POST', body: JSON.stringify(request) }),

  aiContinue: (request) =>
    apiFetch('/api/ai/continue', { method: 'POST', body: JSON.stringify(request) }),

  aiRewrite: (request) =>
    apiFetch('/api/ai/rewrite', { method: 'POST', body: JSON.stringify(request) }),

  aiExtract: (messageId) =>
    apiFetch('/api/ai/extract', { method: 'POST', body: JSON.stringify({ messageId }) }),

  aiTranslate: (request) =>
    apiFetch('/api/ai/translate', { method: 'POST', body: JSON.stringify(request) }),

  aiSearchQuery: (query) =>
    apiFetch('/api/ai/search-query', { method: 'POST', body: JSON.stringify({ query }) }),

  aiOutbound: (messageId) => apiFetch(`/api/ai/outbound/${encodeURIComponent(messageId)}`),

  aiUsage: () => apiFetch('/api/ai/usage'),

  aiForgetMessage: (messageId) =>
    apiFetch(`/api/ai/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' }),

  // Соединение переустанавливается само: без этого живые обновления
  // умирали после первого же обрыва и не возвращались до перезагрузки.
  subscribe: (onEvent) =>
    connectWithRetry({
      open: () => {
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        /*
         * Отпечаток браузера в адресе соединения.
         *
         * По нему сервер понимает, что в ЭТОМ браузере почта сейчас
         * открыта, и не шлёт сюда push-уведомление: окно покажет сама
         * вкладка, а второе такое же от фоновой службы было бы дублем.
         * Отпечаток — случайная строка, которую браузер придумал себе
         * сам (см. notifications/api.ts); опознать по ней человека
         * нельзя, и сравнивается она только с подписками этого же ящика.
         */
        const client = encodeURIComponent(browserClientId());
        return new WebSocket(`${protocol}://${location.host}/ws?client=${client}`);
      },
      onMessage: (data) => {
        try {
          onEvent(JSON.parse(data) as WsEvent);
        } catch {
          /* не-JSON кадры игнорируем */
        }
      },
    }),
};

/**
 * Сколько писем запрашиваем за раз.
 *
 * Ровно столько, сколько разрешает сервер (`limit` в /api/messages ограничен
 * сотней). Раньше интерфейс просил тысячу — на заглушках это проходило, а
 * против настоящего API весь список падал с ошибкой проверки параметров.
 * Держим значение в одном месте, чтобы стороны снова не разошлись.
 */
export const MESSAGES_PAGE_SIZE = 100;
