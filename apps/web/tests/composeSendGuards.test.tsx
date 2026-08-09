// @vitest-environment jsdom
/**
 * Две проверки перед отправкой, которые врали человеку.
 *
 * ПЕРВАЯ — получатели. Письмо только со «Скрытой копией» (или только с
 * «Копией») отправить было нельзя: окно требовало непустое «Кому» и
 * отвечало «Укажите хотя бы одного получателя», хотя получатели в окне
 * были и человек их видел. А разослать одно письмо десятку людей так,
 * чтобы они не увидели адресов друг друга, — обычное дело. Сервер это
 * разрешает, путь через чужой SMTP тоже; не пускало ровно окно.
 *
 * ВТОРАЯ — отложенная отправка с чужого адреса. Ветка отправки через чужой
 * SMTP срабатывала раньше и просто выбрасывала назначенное время: кнопка
 * подписана «Отправить позже», в подвале висит «Уйдёт 10 августа в 09:00»,
 * а письмо уходит сию секунду. Обещание, которого никто не собирался
 * выполнять, — и заметить подмену человеку неоткуда.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { toLocalInputValue } from '../src/compose/ComposeWindow';
import { useUiStore } from '../src/app/store';
import { accountsApi, api } from '../src/api';
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

const buttonByLabel = (label: string): HTMLButtonElement | null =>
  host.querySelector(`button[aria-label="${label}"]`);

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

/** Подключённый чужой ящик со своим SMTP — с него и отправляют. */
function withExternalSender() {
  vi.spyOn(accountsApi, 'getAccounts').mockResolvedValue({
    current: 'demo@mail.local',
    linked: [],
    external: [
      {
        id: 7,
        address: 'staraya@yandex.ru',
        label: 'Старая почта',
        mode: 'collector',
        enabled: true,
        smtp: { host: 'smtp.yandex.ru', port: 465, secure: true, user: 'staraya@yandex.ru' },
        state: {
          lastRunAt: null,
          lastOkAt: null,
          status: 'ok',
          error: null,
          lastCopied: 0,
          totalCopied: 0,
        },
      },
    ],
    secrets: { available: true, reason: null },
    collector: { scheduler: true, masterConfigured: true },
  });
}

/** Кнопка выбора «От кого» появляется, когда список отправителей пришёл. */
const senderButton = (): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? '').startsWith('Отправить с адреса'),
  );

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

describe('получатели', () => {
  it('письмо только со «Скрытой» отправляется — это обычная рассылка', async () => {
    const send = vi.spyOn(api, 'sendMessage').mockResolvedValue({ ok: true, sentMessageId: 's:1' });
    render();
    act(() => useUiStore.getState().openCompose());

    click(buttonByText('Скрытая'));
    type(byLabel('Скрытая')!, 'anna@mail.local, kolya@mail.local');
    click(buttonByText('Отправить'));

    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    const payload = send.mock.calls[0]?.[0] as SendRequest;
    expect(payload.to).toEqual([]);
    expect(payload.bcc.map((a) => a.address)).toEqual(['anna@mail.local', 'kolya@mail.local']);
  });

  it('письмо только с «Копией» тоже отправляется', async () => {
    const send = vi.spyOn(api, 'sendMessage').mockResolvedValue({ ok: true, sentMessageId: 's:1' });
    render();
    act(() => useUiStore.getState().openCompose());

    click(buttonByText('Копия'));
    type(byLabel('Копия')!, 'anna@mail.local');
    click(buttonByText('Отправить'));

    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    expect((send.mock.calls[0]?.[0] as SendRequest).cc.map((a) => a.address)).toEqual([
      'anna@mail.local',
    ]);
  });

  it('письмо совсем без получателей по-прежнему не уходит', () => {
    const send = vi.spyOn(api, 'sendMessage').mockResolvedValue({ ok: true, sentMessageId: 's:1' });
    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Тема')!, 'без адресата');
    click(buttonByText('Отправить'));

    expect(send).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Укажите хотя бы одного получателя');
  });
});

describe('отложенная отправка с чужого адреса', () => {
  it('назначенное время снимается при выборе чужого адреса — и об этом говорят', async () => {
    withExternalSender();
    render();
    act(() => useUiStore.getState().openCompose({ to: 'kolya@mail.local' }));
    await waitFor(() => Boolean(senderButton()), 'кнопку выбора отправителя');

    // Сначала назначаем время своему адресу — так и делают: пишут письмо,
    // откладывают, а потом решают отправить его с другого ящика.
    const at = new Date(Date.now() + 3600_000);
    click(buttonByLabel('Отложенная отправка'));
    type(byLabel('Время отправки')!, toLocalInputValue(at));
    click(buttonByText('Назначить'));
    expect(useUiStore.getState().composeWindows[0]?.draft.sendAt).not.toBeNull();

    click(senderButton());
    click(buttonByText('Старая почта <staraya@yandex.ru>'));

    expect(
      useUiStore.getState().composeWindows[0]?.draft.sendAt,
      'время осталось в письме, которое уйдёт немедленно',
    ).toBeNull();
    expect(useUiStore.getState().notice ?? '').toContain('Отложенная отправка снята');
    // И подпись кнопки больше не обещает «позже»
    expect(buttonByText('Отправить')).toBeTruthy();
  });

  it('при чужом отправителе назначить время нечем — кнопка выключена и объясняет почему', async () => {
    withExternalSender();
    render();
    act(() => useUiStore.getState().openCompose({ to: 'kolya@mail.local' }));
    await waitFor(() => Boolean(senderButton()), 'кнопку выбора отправителя');

    const id = useUiStore.getState().composeWindows[0]?.id ?? 0;
    act(() => useUiStore.getState().updateComposeDraft(id, () => ({ fromExternalId: 7 })));

    const later = buttonByLabel('Отложенная отправка');
    expect(later?.disabled, 'меню отложенной отправки открывается там, где её нет').toBe(true);
    expect(later?.getAttribute('title') ?? '').toContain('staraya@yandex.ru');
    click(later);
    expect(byLabel('Время отправки'), 'меню всё-таки открылось').toBeNull();
  });

  it('время, попавшее в письмо иным путём, не превращается в отправку сейчас', async () => {
    withExternalSender();
    const external = vi
      .spyOn(accountsApi, 'sendAsExternal')
      .mockResolvedValue({ ok: true, from: 'staraya@yandex.ru' });
    render();
    act(() => useUiStore.getState().openCompose({ to: 'kolya@mail.local' }));
    await waitFor(() => Boolean(senderButton()), 'кнопку выбора отправителя');

    // Так письмо возвращается из отмены отправки: и чужой адрес, и время
    // уже лежат в черновике окна.
    const id = useUiStore.getState().composeWindows[0]?.id ?? 0;
    act(() =>
      useUiStore.getState().updateComposeDraft(id, () => ({
        fromExternalId: 7,
        sendAt: new Date(Date.now() + 3600_000).toISOString(),
      })),
    );

    click(buttonByText('Отправить позже'));
    expect(external, 'письмо ушло сразу, хотя окно обещало «позже»').not.toHaveBeenCalled();
    expect(host.textContent).toContain('Отложенная отправка с адреса staraya@yandex.ru');
  });
});
