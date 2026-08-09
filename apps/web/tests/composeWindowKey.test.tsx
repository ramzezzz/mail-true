// @vitest-environment jsdom
/**
 * Ключ окна написания уходит на сервер.
 *
 * Дефект: поле `draftKey` было в схеме запроса и на сервере, а клиент не
 * присылал его никогда. Сервер из-за этого не мог связать между собой
 * запросы одного письма, и получалось вот что.
 *
 *  - Неудачная отправка спасает набранный текст в «Черновики» — и делает
 *    это ЗАНОВО на каждую попытку. Перезапуск почтового сервера, три
 *    нажатия «Отправить» — три одинаковых письма в папке.
 *  - Удачная отправка черновик НЕ убирала: серверная уборка выходит первой
 *    же строкой, когда не знает ни UID черновика, ни ключа окна.
 *
 * То есть письмо уходило, а его копии оставались лежать в «Черновиках».
 * Человек, наткнувшись на них, отправлял письмо второй раз — у получателя
 * дубль.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { useUiStore } from '../src/app/store';
import { api } from '../src/api';
import type { SendRequest } from '../src/api/types';

let host: HTMLDivElement;
let root: Root;

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ComposeWindows />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const byLabel = (label: string): HTMLInputElement | null =>
  host.querySelector(`input[aria-label="${label}"]`);

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (element: Element | null | undefined) => {
  if (!element) throw new Error('нечего нажимать');
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent ?? ''}`);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ composeWindows: [], notice: null });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ composeWindows: [], notice: null });
  vi.restoreAllMocks();
});

describe('draftKey', () => {
  it('уходит вместе с письмом — иначе сервер не найдёт черновик этого окна', async () => {
    const send = vi.spyOn(api, 'sendMessage').mockResolvedValue({ ok: true, sentMessageId: 's:1' });
    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Кому')!, 'kolya@mail.local');
    click(buttonByText('Отправить'));

    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    const payload = send.mock.calls[0]?.[0] as SendRequest;
    expect(payload.draftKey, 'окно не назвалось серверу — черновик останется в папке').toBeTruthy();
  });

  it('у сохранения черновика и у отправки он ОДИН И ТОТ ЖЕ', async () => {
    const save = vi
      .spyOn(api, 'saveDraft')
      .mockResolvedValue({ ok: true, draftId: 'drafts:1', draftUid: 1, savedAt: '' });
    const send = vi.spyOn(api, 'sendMessage').mockResolvedValue({ ok: true, sentMessageId: 's:1' });

    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Кому')!, 'kolya@mail.local');
    click(buttonByText('Сохранить'));
    await waitFor(() => save.mock.calls.length > 0, 'сохранение черновика');

    click(buttonByText('Отправить'));
    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');

    const saved = save.mock.calls[0]?.[0] as SendRequest;
    const sent = send.mock.calls[0]?.[0] as SendRequest;
    // Разойдись эти два ключа — отправленное письмо осталось бы лежать
    // черновиком: сервер убирает черновик ровно по ключу окна.
    expect(saved.draftKey).toBeTruthy();
    expect(sent.draftKey).toBe(saved.draftKey);
  });

  it('у двух окон ключи разные — иначе одно письмо стирало бы черновик другого', async () => {
    const save = vi
      .spyOn(api, 'saveDraft')
      .mockResolvedValue({ ok: true, draftId: 'drafts:1', draftUid: 1, savedAt: '' });
    render();
    act(() => useUiStore.getState().openCompose({ subject: 'Первое' }));
    act(() => useUiStore.getState().openCompose({ subject: 'Второе' }));

    const saveButtons = [...host.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Сохранить',
    );
    expect(saveButtons.length).toBe(2);
    click(saveButtons[0]);
    await waitFor(() => save.mock.calls.length > 0, 'сохранение первого черновика');
    click(saveButtons[1]);
    await waitFor(() => save.mock.calls.length > 1, 'сохранение второго черновика');

    const first = save.mock.calls[0]?.[0] as SendRequest;
    const second = save.mock.calls[1]?.[0] as SendRequest;
    expect(first.draftKey).toBeTruthy();
    expect(second.draftKey).not.toBe(first.draftKey);
  });

  it('ключ окна переживает сворачивание — письмо то же самое', async () => {
    const save = vi
      .spyOn(api, 'saveDraft')
      .mockResolvedValue({ ok: true, draftId: 'drafts:1', draftUid: 1, savedAt: '' });
    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Кому')!, 'kolya@mail.local');
    click(buttonByText('Сохранить'));
    await waitFor(() => save.mock.calls.length > 0, 'первое сохранение');

    const id = useUiStore.getState().composeWindows[0]?.id ?? 0;
    act(() => useUiStore.getState().toggleComposeMinimized(id));
    act(() => useUiStore.getState().toggleComposeMinimized(id));

    click(buttonByText('Сохранить'));
    await waitFor(() => save.mock.calls.length > 1, 'второе сохранение');
    const first = save.mock.calls[0]?.[0] as SendRequest;
    const second = save.mock.calls[1]?.[0] as SendRequest;
    expect(first.draftKey).toBeTruthy();
    expect(second.draftKey).toBe(first.draftKey);
  });
});
