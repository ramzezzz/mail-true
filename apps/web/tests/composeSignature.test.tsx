// @vitest-environment jsdom
/**
 * Подпись в окне написания письма.
 *
 * Окно брало подпись из `account.signature`, а настоящий сервер отдаёт это
 * поле пустой строкой:
 *
 *   GET /api/account → {"email":"test@mail.local","displayName":"Test",
 *                       "signature":"", …}
 *
 * — в письмо подставлялся пустой блок. Сами подписи лежат в общих настройках
 * (GET /api/settings/general → signatures[]), и выпадающего списка, который
 * обещает контракт, в окне не было вовсе. На заглушках это не всплывало:
 * там `account.signature` непустой.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Account } from '@mail-true/shared';
import { api, settingsApi } from '../src/api';
import type { GeneralSettings } from '../src/api/settingsTypes';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { useUiStore } from '../src/app/store';

let host: HTMLDivElement;
let root: Root;

/** Ответ настоящего /api/account: подпись здесь всегда пустая. */
const serverAccount: Account = {
  id: 'test@mail.local',
  email: 'test@mail.local',
  displayName: 'Test',
  avatarUrl: null,
  quotaUsedBytes: 34_509_824,
  quotaLimitBytes: 1_073_741_824,
  signature: '',
  createdAt: '2026-08-05T01:56:56.454Z',
};

function serverSettings(patch: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    senderName: 'Тест Тестович',
    signatures: [
      { id: '31', name: 'Рабочая', text: '—\nС уважением, Тест' },
      { id: '32', name: 'Короткая', text: 'Тест' },
    ],
    defaultSignatureId: '31',
    autoReply: { enabled: false, text: '', from: null, to: null },
    notifications: { browser: false, tabCounter: true },
    quoteOriginalOnReply: true,
    afterDelete: 'list',
    autoCollectContacts: true,
    ...patch,
  };
}

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

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.innerHTML}`);
}

const editor = () => host.querySelector('[aria-label="Текст письма"]') as HTMLElement | null;
const picker = () => host.querySelector('select[aria-label="Подпись"]') as HTMLSelectElement | null;
const bodyHtml = () => useUiStore.getState().composeWindows[0]?.draft.bodyHtml ?? '';

/** Выбор в списке — так, как это делает пользователь. */
function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ composeWindows: [] });
  vi.spyOn(api, 'getAccount').mockResolvedValue(serverAccount);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ composeWindows: [] });
  vi.restoreAllMocks();
});

describe('подпись в новом письме', () => {
  it('берётся из общих настроек, а не из пустого поля учётной записи', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    render();
    act(() => useUiStore.getState().openCompose());

    // Раньше сюда подставлялся пустой блок: сервер отдаёт account.signature === ''
    await waitFor(() => editor()!.textContent!.includes('С уважением, Тест'), 'подпись в письме');
    expect(bodyHtml()).toContain('С уважением, Тест');
  });

  it('подписей в настройках нет — в письмо ничего не подставляется', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ signatures: [], defaultSignatureId: null }),
    );
    render();
    act(() => useUiStore.getState().openCompose());
    await waitFor(
      () => useUiStore.getState().composeWindows[0]?.draft.signatureApplied === true,
      'решение о подписи',
    );

    expect(editor()!.textContent!.trim()).toBe('');
    // Выбирать не из чего — списка тоже нет
    expect(picker()).toBeNull();
  });

  it('«без подписи» в настройках — подпись не подставляется, но выбрать её можно', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ defaultSignatureId: null }),
    );
    render();
    act(() => useUiStore.getState().openCompose());
    await waitFor(() => picker() !== null, 'список подписей');

    expect(picker()!.value).toBe('');
    expect(editor()!.textContent!.trim()).toBe('');
  });
});

describe('выбор подписи в окне написания', () => {
  it('список показывает все подписи из настроек', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    render();
    act(() => useUiStore.getState().openCompose());
    await waitFor(() => picker() !== null, 'список подписей');

    // Списка не было вовсе, хотя контракт его обещает
    expect([...picker()!.options].map((o) => o.textContent)).toEqual([
      'Без подписи',
      'Рабочая',
      'Короткая',
    ]);
    expect(picker()!.value).toBe('31');
  });

  it('переключение меняет подпись и не трогает написанное', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    render();
    act(() => useUiStore.getState().openCompose());
    await waitFor(() => picker() !== null, 'список подписей');

    // Пишем письмо поверх подставленной подписи
    const first = editor()!.firstElementChild as HTMLElement;
    act(() => {
      first.innerHTML = 'Коллеги, во вложении договор.';
      editor()!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    choose(picker()!, '32');
    expect(editor()!.textContent).toContain('Коллеги, во вложении договор.');
    expect(editor()!.textContent).not.toContain('С уважением');
    expect(bodyHtml()).toContain('Коллеги, во вложении договор.');
    expect(bodyHtml()).toContain('Тест');

    choose(picker()!, '');
    expect(editor()!.textContent).toContain('Коллеги, во вложении договор.');
    expect(editor()!.textContent).not.toContain('С уважением');
  });

  it('выбранная подпись переживает сворачивание окна', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    render();
    act(() => useUiStore.getState().openCompose());
    await waitFor(() => picker() !== null, 'список подписей');

    choose(picker()!, '32');
    const id = useUiStore.getState().composeWindows[0]!.id;
    act(() => useUiStore.getState().toggleComposeMinimized(id));
    act(() => useUiStore.getState().toggleComposeMinimized(id));

    expect(picker()!.value).toBe('32');
    expect(editor()!.textContent).toContain('Тест');
  });
});

describe('подпись и цитата в ответе', () => {
  it('подпись встаёт над цитатой исходного письма', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    render();
    act(() =>
      useUiStore.getState().openCompose({
        to: 'petr@example.com',
        subject: 'Re: Договор',
        bodyHtml: '<blockquote>исходное письмо</blockquote>',
      }),
    );
    await waitFor(() => editor()!.textContent!.includes('С уважением, Тест'), 'подпись в ответе');

    const html = editor()!.innerHTML;
    expect(html.indexOf('С уважением')).toBeLessThan(html.indexOf('исходное письмо'));
  });
});
