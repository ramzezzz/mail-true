// @vitest-environment jsdom
/**
 * Страница письма против ответа, устроенного как настоящий.
 *
 * Здесь сходятся три дефекта сразу:
 *   - плашка «Показать картинки» не появлялась никогда, потому что интерфейс
 *     искал `src="http…"`, а сервер уже подменил его прозрачным пикселем и
 *     положил счётчик в `blockedRemote`;
 *   - «Отписаться» была недостижима: проверялся ключ `List-Unsubscribe`,
 *     а сервер отдаёт имена заголовков в нижнем регистре;
 *   - на любую ошибку загрузки писалось «Письмо не найдено», и повторить
 *     попытку было нечем.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../src/api/http';
import type { MessageFull } from '../src/api/types';
import { BLOCKED_PIXEL } from '../src/lib/externalImages';
import { MessagePage } from '../src/pages/MessagePage';
import { api } from '../src/api';

let host: HTMLDivElement;
let root: Root;

/** Ответ сервера на письмо рассылки: картинки заблокированы, есть отписка. */
function serverMessage(patch: Partial<MessageFull> = {}): MessageFull {
  return {
    id: 'inbox:209',
    folderId: 'inbox',
    uid: 209,
    threadId: 't-209',
    from: { name: 'Рассылка', address: 'news@example.com' },
    to: [{ name: null, address: 'test@mail.local' }],
    cc: [],
    subject: 'Тест картинок и отписки',
    snippet: 'Test message with external images',
    date: new Date().toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 2048,
    messageId: '<mt-images-test@example.com>',
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml:
      `<p>Test message with external images:</p>` +
      `<img src="${BLOCKED_PIXEL}" data-mt-src="http://tracker.example.com/pixel.gif?u=1">`,
    bodyText: 'Test message with external images',
    attachments: [],
    // Имена заголовков — в нижнем регистре, как их отдаёт сервер
    headers: {
      'list-unsubscribe': '<mailto:unsub@example.com>, <http://example.com/unsub?u=1>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    },
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    blockedRemote: 3,
    ...patch,
  };
}

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox/inbox%3A209']}>
          <Routes>
            <Route path=":folderId/:messageId" element={<MessagePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Ждёт, пока на экране не появится ожидаемое (запросы заглушек — async). */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('внешние картинки', () => {
  it('плашка появляется по счётчику сервера, а «Показать» перезапрашивает письмо', async () => {
    const getMessage = vi
      .spyOn(api, 'getMessage')
      .mockImplementation(async (_id: string, options?: { images?: boolean }) =>
        options?.images
          ? serverMessage({
              blockedRemote: 0,
              bodyHtml: '<img src="http://tracker.example.com/pixel.gif?u=1">',
            })
          : serverMessage(),
      );

    render();
    await waitFor(() => host.textContent!.includes('заблокированы'), 'плашку о картинках');

    const show = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Показать');
    expect(show).toBeDefined();
    act(() => show!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Именно перезапрос с ?images=1: разблокировать картинки на клиенте нечем
    await waitFor(
      () => getMessage.mock.calls.some((call) => call[1]?.images === true),
      'запрос письма с картинками',
    );
    await waitFor(() => !host.textContent!.includes('заблокированы'), 'исчезновение плашки');
    expect(host.innerHTML).toContain('src="http://tracker.example.com/pixel.gif?u=1"');
  });

  it('в письме без внешних картинок плашки нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      serverMessage({ blockedRemote: 0, bodyHtml: '<p>простое письмо</p>', headers: {} }),
    );
    render();
    await waitFor(() => host.textContent!.includes('простое письмо'), 'тело письма');
    expect(host.textContent).not.toContain('заблокированы');
  });
});

describe('отписка от рассылки', () => {
  it('кнопка появляется на заголовке в нижнем регистре', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage());
    render();
    await waitFor(() => host.textContent!.includes('Отписаться'), 'кнопку отписки');
  });

  it('без заголовка отписки кнопки нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage({ headers: {} }));
    render();
    await waitFor(() => host.textContent!.includes('Тест картинок'), 'письмо');
    expect(host.textContent).not.toContain('Отписаться');
  });
});

describe('ошибки загрузки письма', () => {
  it('404 — «Письмо не найдено», без предложения повторить', async () => {
    vi.spyOn(api, 'getMessage').mockRejectedValue(
      new ApiError(404, '/api/messages/inbox:209', 'Письмо не найдено', 'NOT_FOUND'),
    );
    render();
    await waitFor(() => host.textContent!.includes('Письмо не найдено'), 'сообщение о ненайденном');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Повторить')).toBe(
      false,
    );
  });

  it('сбой сервера — другое сообщение и кнопка «Повторить»', async () => {
    const getMessage = vi
      .spyOn(api, 'getMessage')
      .mockRejectedValueOnce(new ApiError(503, '/api/messages/inbox:209', 'Сервер недоступен'))
      .mockResolvedValue(serverMessage());

    render();
    await waitFor(
      () => host.textContent!.includes('Не удалось загрузить письмо'),
      'сообщение о сбое',
    );
    // Раньше здесь было «Письмо не найдено» — и повторить попытку было нечем
    expect(host.textContent).not.toContain('Письмо не найдено');

    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Повторить');
    expect(retry).toBeDefined();
    act(() => retry!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => host.textContent!.includes('Тест картинок'), 'письмо после повтора');
    expect(getMessage.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('письмо на два десятка получателей', () => {
  /** 21 адресат: столько же, сколько у письма EDGE-20RCPT на стенде. */
  const many = Array.from({ length: 21 }, (_, i) => ({
    name: null,
    address: `user${String(i).padStart(2, '0')}@example.org`,
  }));

  it('кнопка «подробности» не уезжает за обрезанный список адресатов', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage({ to: many }));
    render();
    await waitFor(() => host.textContent!.includes('Кому:'), 'строку получателей');

    const toggle = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'подробности',
    );
    expect(toggle).toBeDefined();

    // Многоточие висит на перечне адресатов, а кнопка — снаружи него.
    // Раньше обрезалась строка целиком, и кнопка оказывалась за краем
    // контейнера с overflow: hidden — невидимой и некликабельной.
    const clipped = host.querySelector('[class*="senderToText"]');
    expect(clipped).not.toBeNull();
    expect(clipped!.textContent).toContain('Кому:');
    expect(clipped!.contains(toggle!)).toBe(false);
  });

  it('по нажатию показывает всех адресатов', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage({ to: many }));
    render();
    await waitFor(() => host.textContent!.includes('Кому:'), 'строку получателей');

    const toggle = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'подробности',
    )!;
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => host.textContent!.includes('user20@example.org'), 'полный список');
    expect(host.textContent).toContain('user00@example.org');
  });
});
