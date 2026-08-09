/**
 * Настройки ЧУЖОГО ящика: кнопка сохраняет свой блок, а не всю форму.
 *
 * Страница показывает три разных блока — имя отправителя с подписями,
 * автоответчик и фильтры, — и у первых двух своя кнопка «Сохранить».
 * Отправляли же они обе одно и то же: весь общий блок целиком.
 *
 * На своём ящике это в худшем случае неожиданность. На чужом — правка
 * чужих данных, которую никто не делал: администратор начал писать
 * подпись, передумал, ничего не сохранял, прокрутил ниже и выключил
 * автоответчик — недописанная подпись уехала в ящик вместе с ним. И в
 * журнал аудита, где выглядит осознанной правкой чужой подписи.
 *
 * Откатить это нечем: прежний текст подписи остался только в журнале.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/app/session';
import { UserSettingsPage } from '../src/pages/UserSettingsPage';

let container: HTMLElement;
let root: Root;
/** Тела запросов PUT — то, что страница на самом деле отправила серверу. */
let sent: Array<Record<string, unknown>> = [];

const SESSION = {
  authenticated: true,
  login: 'osmotr',
  displayName: null,
  role: 'owner',
  roleLabel: 'Владелец',
  permissions: ['users.read', 'usersettings.read', 'usersettings.write'],
  masterAccess: true,
  theme: null,
};

/** То, что лежит на сервере в чужом ящике. Ровно это и надо уберечь. */
function bundle(): Record<string, unknown> {
  return {
    mailbox: { id: 1, email: 'ivan@mail.local', displayName: 'Иван' },
    general: {
      senderName: 'Иван Иванов',
      signatures: [{ id: '10', name: 'Рабочая', text: 'С уважением, Иван' }],
      defaultSignatureId: '10',
      autoReply: { enabled: true, text: 'В отпуске', from: null, to: null },
      notifications: { browser: true, tabCounter: true },
      quoteOriginalOnReply: true,
      afterDelete: 'next-message',
      autoCollectContacts: true,
    },
    filters: [],
    folders: [],
    foldersAvailable: true,
    foldersError: null,
  };
}

const SIEVE = { transport: 'off', path: '/dev/null', activeRules: 0, ok: true, error: '' };

function mockFetch(): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    let body: unknown = {};
    if (url.includes('/auth/session')) body = SESSION;
    else if (url.includes('/settings/general')) {
      sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      body = { ...(bundle().general as object), sieve: SIEVE };
    } else if (url.includes('/settings')) body = bundle();
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function open(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <MemoryRouter initialEntries={['/users/1/settings']}>
            <Routes>
              <Route path="/users/:id/settings" element={<UserSettingsPage />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Поле или кнопка по видимой подписи — так их ищет и человек. */
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`нет кнопки «${label}»`);
  return found;
}

function textareas(): HTMLTextAreaElement[] {
  return [...container.querySelectorAll('textarea')];
}

function type(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  sent = [];
  mockFetch();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('сохранение чужого ящика по блокам', () => {
  it('«Сохранить автоответчик» не уносит недописанную подпись', async () => {
    await open();

    // Первая большая текстовая область — текст подписи; вторая — автоответ.
    const signature = textareas()[0];
    expect(signature, 'на странице нет поля подписи').toBeTruthy();
    await act(async () => type(signature as HTMLTextAreaElement, 'С уважением, Ив'));

    await act(async () => button('Сохранить автоответчик').click());
    await settle();

    expect(sent.length).toBe(1);
    const signatures = sent[0]?.signatures as Array<{ text: string }>;
    expect(
      signatures[0]?.text,
      'недописанная подпись уехала в чужой ящик вместе с автоответчиком',
    ).toBe('С уважением, Иван');
  });

  it('«Сохранить имя и подписи» не уносит несохранённый автоответчик', async () => {
    await open();

    const autoReply = textareas()[1];
    expect(autoReply, 'на странице нет поля автоответа').toBeTruthy();
    await act(async () => type(autoReply as HTMLTextAreaElement, 'Черновик автоответа'));

    await act(async () => button('Сохранить имя и подписи').click());
    await settle();

    expect(sent.length).toBe(1);
    const autoReplySent = sent[0]?.autoReply as { text: string };
    expect(autoReplySent.text, 'черновик автоответа уехал вместе с подписями').toBe('В отпуске');
  });

  it('свой блок кнопка сохраняет целиком', async () => {
    await open();
    const signature = textareas()[0];
    await act(async () => type(signature as HTMLTextAreaElement, 'Новая подпись'));

    await act(async () => button('Сохранить имя и подписи').click());
    await settle();

    const signatures = sent[0]?.signatures as Array<{ text: string }>;
    expect(signatures[0]?.text).toBe('Новая подпись');
  });
});
