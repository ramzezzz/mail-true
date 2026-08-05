// @vitest-environment jsdom
/**
 * Входящая просьба уведомить о прочтении (RFC 8098).
 *
 * Уведомление рассказывает отправителю, что письмо открыто и когда именно,
 * а заодно подтверждает рассылке, что адрес живой. Поэтому оно НЕ уходит
 * само: интерфейс показывает вопрос и ждёт ответа. Отказ — такое же
 * решение, как согласие, и запоминается он так же: сервер ставит на
 * письме ключевое слово `$MDNSent` (RFC 3503), и вопрос не возвращается.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../src/api';
import type { MessageFull } from '../src/api/types';
import { readReceiptAsk, readReceiptWho } from '../src/lib/readReceipt';
import { MessagePage } from '../src/pages/MessagePage';

let host: HTMLDivElement;
let root: Root;

function serverMessage(patch: Partial<MessageFull> = {}): MessageFull {
  return {
    id: 'inbox:209',
    folderId: 'inbox',
    uid: 209,
    threadId: 't-209',
    from: { name: 'Иван', address: 'ivan@mail.local' },
    to: [{ name: null, address: 'test@mail.local' }],
    cc: [],
    subject: 'Договор на подпись',
    snippet: 'Договор',
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
    messageId: '<orig-209@mail.local>',
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml: '<p>Договор во вложении</p>',
    bodyText: 'Договор во вложении',
    attachments: [],
    // Имена заголовков — в нижнем регистре, как их отдаёт сервер
    headers: { 'disposition-notification-to': 'Иван <ivan@mail.local>' },
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    blockedRemote: 0,
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

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 1 });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('плашка «уведомить о прочтении»', () => {
  it('появляется, когда отправитель об этом просит, и называет адрес', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage());
    render();

    await waitFor(
      () => (host.textContent ?? '').includes('просит уведомить о прочтении'),
      'плашку с вопросом',
    );
    // Кому уйдёт уведомление, должно быть видно ДО нажатия
    expect(host.textContent).toContain('ivan@mail.local');
  });

  it('«Уведомить» отправляет уведомление, «Не уведомлять» — нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage());
    const receipt = vi
      .spyOn(api, 'sendReadReceipt')
      .mockResolvedValue({ ok: true, sent: true, alreadyAnswered: false });
    render();

    await waitFor(() => Boolean(buttonByText('Уведомить')), 'кнопки ответа');
    act(() => buttonByText('Уведомить')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => receipt.mock.calls.length > 0, 'запрос на отправку уведомления');
    expect(receipt.mock.calls[0]).toEqual(['inbox:209', true]);
  });

  it('отказ уходит на сервер отдельным решением, а не молчанием', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage());
    const receipt = vi
      .spyOn(api, 'sendReadReceipt')
      .mockResolvedValue({ ok: true, sent: false, alreadyAnswered: false });
    render();

    await waitFor(() => Boolean(buttonByText('Не уведомлять')), 'кнопки ответа');
    act(() =>
      buttonByText('Не уведомлять')?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await waitFor(() => receipt.mock.calls.length > 0, 'запрос с отказом');
    // Отказ обязан дойти до сервера: иначе вопрос вернётся при следующем
    // открытии письма — и на другом устройстве тоже
    expect(receipt.mock.calls[0]).toEqual(['inbox:209', false]);
  });

  it('на письме, по которому уже ответили, вопроса нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      serverMessage({
        flags: {
          seen: true,
          flagged: false,
          answered: false,
          forwarded: false,
          draft: false,
          deleted: false,
          mdnSent: true,
        },
      }),
    );
    render();

    await waitFor(() => (host.textContent ?? '').includes('Договор на подпись'), 'письмо');
    expect(host.textContent).not.toContain('просит уведомить о прочтении');
  });

  it('на обычном письме плашки нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage({ headers: {} }));
    render();

    await waitFor(() => (host.textContent ?? '').includes('Договор на подпись'), 'письмо');
    expect(host.textContent).not.toContain('просит уведомить о прочтении');
  });
});

describe('разбор заголовка', () => {
  it('понимает и «Имя <адрес>», и голый адрес', () => {
    expect(readReceiptAsk({ 'disposition-notification-to': 'Иван <ivan@mail.local>' })).toEqual({
      address: 'ivan@mail.local',
      name: 'Иван',
    });
    expect(readReceiptAsk({ 'disposition-notification-to': 'ivan@mail.local' })).toEqual({
      address: 'ivan@mail.local',
      name: null,
    });
  });

  it('мусор адресом не считается — обещать отправку туда нельзя', () => {
    expect(readReceiptAsk({})).toBeNull();
    expect(readReceiptAsk({ 'disposition-notification-to': '' })).toBeNull();
    expect(readReceiptAsk({ 'disposition-notification-to': 'не адрес' })).toBeNull();
    expect(readReceiptAsk({ 'disposition-notification-to': 'ivan@local' })).toBeNull();
  });

  it('в плашке видно и имя, и адрес: по адресу и узнают, кому уйдёт письмо', () => {
    expect(readReceiptWho({ address: 'ivan@mail.local', name: 'Иван' })).toBe(
      'Иван (ivan@mail.local)',
    );
    expect(readReceiptWho({ address: 'ivan@mail.local', name: null })).toBe('ivan@mail.local');
  });
});
