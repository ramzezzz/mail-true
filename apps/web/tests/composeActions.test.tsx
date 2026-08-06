// @vitest-environment jsdom
/**
 * Три кнопки окна написания, которые раньше только писали в консоль браузера.
 *
 * «Уведомить о прочтении» и «Отложенная отправка» стояли в нижней панели
 * и на нажатие не делали ничего видимого; «Переслать как вложение» жило
 * в меню над списком писем и вело себя так же. Проверки смотрят не на
 * подсветку кнопки, а на то, что уходит на сервер: без этого «сделано»
 * означало бы ровно то же, что и раньше.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import {
  defaultSendAt,
  formatSendAt,
  toLocalInputValue,
} from '../src/compose/ComposeWindow';
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
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
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

/** Подставная отправка, запоминающая то, что ушло на сервер. */
function spySend() {
  return vi
    .spyOn(api, 'sendMessage')
    .mockResolvedValue({ ok: true, sentMessageId: 'sent:1' });
}

describe('уведомить о прочтении', () => {
  it('нажатие ставит просьбу в письмо, а не пишет в консоль', async () => {
    const send = spySend();
    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Кому')!, 'kolya@mail.local');

    const toggle = buttonByLabel('Уведомить о прочтении');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    click(toggle);
    expect(buttonByLabel('Уведомить о прочтении')?.getAttribute('aria-pressed')).toBe('true');

    click(buttonByText('Отправить'));
    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    expect((send.mock.calls[0]?.[0] as SendRequest).requestReadReceipt).toBe(true);
  });

  it('без нажатия просьбы в письме нет', async () => {
    const send = spySend();
    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Кому')!, 'kolya@mail.local');
    click(buttonByText('Отправить'));

    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    expect((send.mock.calls[0]?.[0] as SendRequest).requestReadReceipt).toBeUndefined();
  });

  it('просьба переживает сворачивание окна вместе с остальным письмом', () => {
    render();
    act(() => useUiStore.getState().openCompose());
    click(buttonByLabel('Уведомить о прочтении'));

    const id = useUiStore.getState().composeWindows[0]?.id ?? 0;
    act(() => useUiStore.getState().toggleComposeMinimized(id));
    act(() => useUiStore.getState().toggleComposeMinimized(id));

    expect(buttonByLabel('Уведомить о прочтении')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('отложенная отправка', () => {
  it('назначенное время уходит на сервер, а человеку говорят когда письмо уйдёт', async () => {
    const at = new Date(Date.now() + 3600_000);
    at.setSeconds(0, 0);
    const send = vi
      .spyOn(api, 'sendMessage')
      .mockResolvedValue({ ok: true, sentMessageId: null, scheduled: true, sendAt: at.toISOString() });

    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Кому')!, 'kolya@mail.local');

    click(buttonByLabel('Отложенная отправка'));
    const when = byLabel('Время отправки');
    expect(when, 'меню отложенной отправки должно открыться').not.toBeNull();
    type(when!, toLocalInputValue(at));
    click(buttonByText('Назначить'));

    // Кнопка отправки честно называет, что произойдёт
    expect(buttonByText('Отправить позже'), 'кнопка должна сменить подпись').toBeTruthy();
    expect(host.textContent).toContain('Уйдёт');

    click(buttonByText('Отправить позже'));
    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    expect((send.mock.calls[0]?.[0] as SendRequest).sendAt).toBe(at.toISOString());

    // «Отправлено» о письме, которого у получателя ещё нет, было бы неправдой
    await waitFor(
      () => (useUiStore.getState().notice ?? '').includes('уйдёт'),
      'сообщение о времени отправки',
    );
  });

  it('время в прошлом не принимается: обещать «позже» было бы неправдой', () => {
    render();
    act(() => useUiStore.getState().openCompose());
    click(buttonByLabel('Отложенная отправка'));
    type(byLabel('Время отправки')!, toLocalInputValue(new Date(Date.now() - 3600_000)));
    click(buttonByText('Назначить'));

    expect(host.textContent).toContain('Выберите время хотя бы через минуту');
    expect(useUiStore.getState().composeWindows[0]?.draft.sendAt).toBeNull();
  });

  it('от назначенного времени можно отказаться', () => {
    const at = new Date(Date.now() + 3600_000);
    render();
    act(() => useUiStore.getState().openCompose());

    click(buttonByLabel('Отложенная отправка'));
    type(byLabel('Время отправки')!, toLocalInputValue(at));
    click(buttonByText('Назначить'));
    expect(useUiStore.getState().composeWindows[0]?.draft.sendAt).not.toBeNull();

    click(buttonByLabel('Отложенная отправка'));
    click(buttonByText('Отправить сразу'));
    expect(useUiStore.getState().composeWindows[0]?.draft.sendAt).toBeNull();
    expect(buttonByText('Отправить')).toBeTruthy();
  });

  it('по умолчанию предлагается завтра в 9 утра', () => {
    const at = defaultSendAt(new Date('2026-08-06T15:20:00'));
    expect(at.getDate()).toBe(7);
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(0);
  });

  it('время показывается по-человечески, а не строкой ISO', () => {
    expect(formatSendAt(new Date(2026, 7, 7, 9, 0).toISOString())).toBe('7 августа в 09:00');
  });
});

describe('переслать как вложение', () => {
  it('письмо уходит идентификатором, а не пересказом цитатой', async () => {
    const send = spySend();
    render();
    act(() =>
      useUiStore.getState().openCompose({
        subject: 'Fwd: Договор',
        attachMessages: [{ id: 'inbox:5', label: 'Договор' }],
      }),
    );

    // Вложенное письмо видно плашкой — иначе неясно, что вообще уйдёт
    expect(host.textContent).toContain('Договор');
    type(byLabel('Кому')!, 'kolya@mail.local');
    click(buttonByText('Отправить'));

    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    const payload = send.mock.calls[0]?.[0] as SendRequest;
    expect(payload.attachMessageIds).toEqual(['inbox:5']);
  });

  it('вложенное письмо можно снять до отправки', async () => {
    const send = spySend();
    render();
    act(() =>
      useUiStore.getState().openCompose({
        attachMessages: [{ id: 'inbox:5', label: 'Договор' }],
      }),
    );

    click(buttonByLabel('Убрать письмо Договор'));
    type(byLabel('Кому')!, 'kolya@mail.local');
    click(buttonByText('Отправить'));

    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    expect((send.mock.calls[0]?.[0] as SendRequest).attachMessageIds).toBeUndefined();
  });

  it('окно с одним вложенным письмом не считается пустым', async () => {
    const saveDraft = vi
      .spyOn(api, 'saveDraft')
      .mockResolvedValue({ ok: true, draftId: 'drafts:1', draftUid: 1, savedAt: '' });
    render();
    act(() =>
      useUiStore.getState().openCompose({
        attachMessages: [{ id: 'inbox:5', label: 'Договор' }],
      }),
    );

    // Пустое окно закрывается сразу и без черновика; это — не пустое,
    // и закрытие крестиком обязано сохранить его черновиком
    click(buttonByLabel('Закрыть'));
    await waitFor(() => saveDraft.mock.calls.length > 0, 'сохранение черновика');
  });
});

describe('Ctrl+Enter — отправить', () => {
  /*
   * Сочетание, к которому в Рунете привыкли все: mail.ru, Яндекс, Telegram.
   * Проверяем не нажатие, а то, что ушло на сервер, — иначе «сделано»
   * означало бы ровно то же, что и раньше.
   */
  const press = (target: Element, init: KeyboardEventInit) => {
    act(() =>
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })),
    );
  };

  it('отправляет из любого поля окна, а не только из тела письма', async () => {
    const send = spySend();
    render();
    act(() => useUiStore.getState().openCompose());
    const to = byLabel('Кому');
    if (!to) throw new Error('нет поля «Кому»');
    type(to, 'kto@mail.local');

    press(to, { key: 'Enter', ctrlKey: true });
    await waitFor(() => send.mock.calls.length > 0, 'письмо ушло');
    const sent = send.mock.calls[0]?.[0] as SendRequest;
    expect(JSON.stringify(sent.to)).toContain('kto@mail.local');
  });

  it('без получателя не отправляет, а говорит об этом', () => {
    const send = spySend();
    render();
    act(() => useUiStore.getState().openCompose());
    const subject = byLabel('Тема');
    if (!subject) throw new Error('нет поля «Тема»');
    type(subject, 'без адресата');

    press(subject, { key: 'Enter', ctrlKey: true });
    expect(send).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Укажите хотя бы одного получателя');
  });

  it('Enter без Ctrl письмо не отправляет', () => {
    const send = spySend();
    render();
    act(() => useUiStore.getState().openCompose());
    const to = byLabel('Кому');
    if (!to) throw new Error('нет поля «Кому»');
    type(to, 'kto@mail.local');

    press(to, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
  });
});
