/**
 * Договор с настоящим API — по проверенным ответам живого сервера.
 *
 * Все расхождения ниже воспроизведены curl-ом на работающем стенде
 * (127.0.0.1:3000, ящик test@mail.local):
 *
 *   POST /api/messages/flags {"ids":[…],"set":{"seen":true}}
 *     → 400 {"error":"BAD_REQUEST","message":"Не указано ни одного флага"}
 *   POST /api/messages/flags {"ids":[…],"seen":true}   → {"updated":1}
 *   POST /api/uploads (multipart)  → {"files":[{"id":…}]}
 *   POST /api/drafts               → {"ok":true,"draftId":"drafts:21","draftUid":21}
 *   GET  /api/messages/inbox:209   → blockedRemote: 3, src="data:image/gif…"
 *   GET  /api/messages/inbox:209?images=1 → blockedRemote: 0, настоящие адреса
 *
 * Заглушка обязана отвечать так же — на расхождениях мы обожглись четырежды.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpApi } from '../src/api/client';
import { ApiError, setUnauthorizedHandler, shouldRetryQuery } from '../src/api/http';
import { toFlagsWire } from '../src/api/types';
import { mockApi } from '../src/mocks/mockApi';
import { mockSettingsApi } from '../src/mocks/mockSettings';
import { blockedImageCount } from '../src/lib/externalImages';

/** Подменяет fetch и запоминает, что именно ушло на сервер. */
function stubFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'stub',
      json: async () => response,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('флаги писем', () => {
  it('уходят первым уровнем, а не вложенным set', () => {
    expect(toFlagsWire({ ids: ['inbox:1'], set: { seen: true } })).toEqual({
      ids: ['inbox:1'],
      seen: true,
    });
    expect(toFlagsWire({ ids: ['inbox:1'], set: { flagged: false, deleted: true } })).toEqual({
      ids: ['inbox:1'],
      flagged: false,
      deleted: true,
    });
  });

  it('клиент шлёт серверную форму запроса', async () => {
    const calls = stubFetch({ updated: 1 });
    await httpApi.setFlags({ ids: ['inbox:207'], set: { seen: true } });
    const body = JSON.parse(String(calls[0]?.init?.body));
    // Именно так сервер и понимает запрос; на вложенный set он отвечает 400
    expect(body).toEqual({ ids: ['inbox:207'], seen: true });
    expect(body.set).toBeUndefined();
  });

  it('заглушка отказывает так же, как сервер, если флаги не указаны', async () => {
    await expect(mockApi.setFlags({ ids: ['inbox:1'], set: {} })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('чтение письма', () => {
  it('без картинок параметр images не отправляется', async () => {
    const calls = stubFetch({ id: 'inbox:209' });
    await httpApi.getMessage('inbox:209');
    expect(calls[0]?.url).toBe('/api/messages/inbox%3A209');
  });

  it('«Показать картинки» — это перезапрос с ?images=1', async () => {
    const calls = stubFetch({ id: 'inbox:209' });
    await httpApi.getMessage('inbox:209', { images: true });
    expect(calls[0]?.url).toBe('/api/messages/inbox%3A209?images=1');
  });

  it('заглушка блокирует картинки так же, как сервер', async () => {
    const page = await mockApi.getMessages({
      folderId: 'inbox',
      offset: 0,
      limit: 100,
      threaded: false,
      filter: 'all',
    });
    // В заглушке внешняя картинка есть у писем с метками travel/mailings
    const withImage = page.items.find((m) => m.labels.includes('travel'));
    expect(withImage).toBeDefined();

    const blocked = await mockApi.getMessage(withImage!.id);
    expect(blocked.blockedRemote).toBeGreaterThan(0);
    expect(blocked.bodyHtml).toContain('data-mt-src=');
    expect(blocked.bodyHtml).not.toMatch(/\ssrc="https?:/i);
    expect(blockedImageCount(blocked)).toBeGreaterThan(0);

    const shown = await mockApi.getMessage(withImage!.id, { images: true });
    expect(shown.blockedRemote).toBe(0);
    expect(shown.bodyHtml).toMatch(/\ssrc="https?:/i);
  });

  it('заглушка отвечает 404, как сервер, а не безымянной ошибкой', async () => {
    await expect(mockApi.getMessage('inbox:999999')).rejects.toMatchObject({ status: 404 });
  });
});

describe('загрузка вложения', () => {
  it('разворачивает ответ сервера { files: [...] }', async () => {
    stubFetch({ files: [{ id: 'u-1', filename: 'a.txt', mimeType: 'text/plain', size: 6 }] });
    const uploaded = await httpApi.uploadAttachment(new File(['hello'], 'a.txt'));
    expect(uploaded).toEqual({ id: 'u-1', filename: 'a.txt', mimeType: 'text/plain', size: 6 });
  });
});

describe('сохранение черновика', () => {
  it('время сохранения проставляет клиент: сервер его не присылает', async () => {
    stubFetch({ ok: true, draftId: 'drafts:21', draftUid: 21 });
    const saved = await httpApi.saveDraft({
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      bodyHtml: '',
      attachmentIds: [],
    });
    expect(saved.draftUid).toBe(21);
    // раньше сюда попадал undefined и в окне писалось «Сохранено в Invalid Date»
    expect(Number.isNaN(new Date(saved.savedAt).getTime())).toBe(false);
  });
});

describe('истёкшая сессия', () => {
  it('401 поднимает общий обработчик — интерфейс уводит на вход', async () => {
    const seen = vi.fn();
    setUnauthorizedHandler(seen);
    stubFetch({ error: 'UNAUTHORIZED', message: 'Требуется вход' }, 401);

    await expect(httpApi.getFolders()).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('сам вход обработчик не дёргает — иначе получилась бы петля', async () => {
    const seen = vi.fn();
    setUnauthorizedHandler(seen);
    stubFetch({ error: 'UNAUTHORIZED', message: 'Неверный пароль' }, 401);

    await expect(httpApi.login('a@mail.local', 'нет')).rejects.toBeInstanceOf(ApiError);
    expect(seen).not.toHaveBeenCalled();
  });

  it('401 и 403 не повторяются, остальное — до трёх раз', () => {
    const unauthorized = new ApiError(401, '/api/folders', 'Требуется вход');
    const forbidden = new ApiError(403, '/api/folders', 'Нет прав');
    const server = new ApiError(503, '/api/folders', 'Сервер недоступен');

    expect(shouldRetryQuery(0, unauthorized)).toBe(false);
    expect(shouldRetryQuery(0, forbidden)).toBe(false);
    expect(shouldRetryQuery(0, server)).toBe(true);
    expect(shouldRetryQuery(1, server)).toBe(true);
    expect(shouldRetryQuery(2, server)).toBe(false);
  });
});

describe('вход и выход', () => {
  it('вход отправляет email и пароль на /api/auth/login', async () => {
    const calls = stubFetch({ ok: true, email: 'test@mail.local' });
    const session = await httpApi.login('test@mail.local', 'test12345');
    expect(calls[0]?.url).toBe('/api/auth/login');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: 'test@mail.local',
      password: 'test12345',
    });
    expect(session).toEqual({ authenticated: true, email: 'test@mail.local' });
  });

  it('выход дёргает существующий маршрут POST /api/auth/logout', async () => {
    const calls = stubFetch({ ok: true });
    await httpApi.logout();
    expect(calls[0]?.url).toBe('/api/auth/logout');
    expect(calls[0]?.init?.method).toBe('POST');
  });
});

/**
 * Общие настройки. Ответы сняты с работающего стенда (127.0.0.1:8080,
 * ящик test@mail.local):
 *
 *   PUT /api/settings/general {"signatures":[{"id":"new-1",…}]}      → id "34"
 *   тот же запрос ещё раз                                            → id "35"
 *   PUT … {"signatures":[{"id":"38",…}]}                             → id "38"
 *   PUT … {"autoReply":{"from":"2026-08-01","to":"2026-08-20"}}
 *     → {"from":"2026-08-01T00:00:00.000Z","to":"2026-08-20T00:00:00.000Z"}
 */
describe('общие настройки', () => {
  const settings = {
    senderName: 'Test',
    signatures: [{ id: 'new-1', name: 'Рабочая', text: 'С уважением' }],
    defaultSignatureId: 'new-1',
    autoReply: { enabled: true, text: 'В отпуске', from: '2026-08-01', to: '2026-08-20' },
    notifications: { browser: true, tabCounter: true },
    quoteOriginalOnReply: false,
    afterDelete: 'next-message' as const,
    autoCollectContacts: true,
  };

  it('заглушка выдаёт новой подписи свой идентификатор, как сервер', async () => {
    const saved = await mockSettingsApi.saveGeneral(structuredClone(settings));
    const id = saved.signatures[0]?.id;
    expect(id).toMatch(/^\d+$/);
    // Подпись по умолчанию переезжает на новый идентификатор — иначе выбор
    // указывал бы на подпись, которой уже нет
    expect(saved.defaultSignatureId).toBe(id);

    // Уже настоящий идентификатор сервер сохраняет
    const again = await mockSettingsApi.saveGeneral(structuredClone(saved));
    expect(again.signatures[0]?.id).toBe(id);
  });

  it('заглушка возвращает срок автоответчика полной датой ISO, как сервер', async () => {
    const saved = await mockSettingsApi.saveGeneral(structuredClone(settings));
    // Именно на этом и спотыкался `<input type="date">`
    expect(saved.autoReply.from).toBe('2026-08-01T00:00:00.000Z');
    expect(saved.autoReply.to).toBe('2026-08-20T00:00:00.000Z');
  });
});
