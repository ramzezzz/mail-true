// @vitest-environment jsdom
/**
 * Вход, выход и истёкшая сессия.
 *
 * Маршрута входа в почте не было вовсе, кнопки «Выйти» — тоже (хотя
 * `POST /api/auth/logout` на сервере есть), а ответ 401 никто не перехватывал:
 * пользователь с закончившейся сессией видел пустое меню и невнятную ошибку.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../src/api';
import { ApiError } from '../src/api/http';
import { SessionProvider, useSession } from '../src/app/session';
import { LoginPage } from '../src/pages/LoginPage';

let host: HTMLDivElement;
let root: Root;

/** Экран, который ведёт себя как настоящая калитка маршрутов. */
function Gate() {
  const { session, loading } = useSession();
  if (loading) return <p>Проверяем сессию…</p>;
  if (!session) return <LoginPage />;
  return <p>Список писем: {session.email}</p>;
}

function LogoutButton() {
  const { logout } = useSession();
  return (
    <button type="button" onClick={() => void logout()}>
      Выйти
    </button>
  );
}

function render(children = <Gate />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Routes>
            <Route path="*" element={<SessionProvider>{children}</SessionProvider>} />
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

const text = () => host.textContent ?? '';

function typeInto(selector: string, value: string) {
  const input = host.querySelector(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

describe('вход', () => {
  it('без сессии показывается экран входа, а не пустой список', async () => {
    vi.spyOn(api, 'getSession').mockRejectedValue(
      new ApiError(401, '/api/auth/session', 'Требуется вход'),
    );
    render();
    await waitFor(() => text().includes('Вход в почту'), 'экран входа');
  });

  it('после успешного входа показывается почта', async () => {
    vi.spyOn(api, 'getSession')
      .mockRejectedValueOnce(new ApiError(401, '/api/auth/session', 'Требуется вход'))
      .mockResolvedValue({ authenticated: true, email: 'test@mail.local' });
    const login = vi
      .spyOn(api, 'login')
      .mockResolvedValue({ authenticated: true, email: 'test@mail.local' });

    render();
    await waitFor(() => text().includes('Вход в почту'), 'экран входа');

    typeInto('#login-email', 'test@mail.local');
    typeInto('#login-password', 'test12345');
    const submit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Войти');
    act(() => submit!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => text().includes('Список писем: test@mail.local'), 'список писем');
    expect(login).toHaveBeenCalledWith('test@mail.local', 'test12345');
  });

  it('неверный пароль объясняется, а не теряется', async () => {
    vi.spyOn(api, 'getSession').mockRejectedValue(
      new ApiError(401, '/api/auth/session', 'Требуется вход'),
    );
    vi.spyOn(api, 'login').mockRejectedValue(
      new ApiError(401, '/api/auth/login', 'Неверный адрес или пароль'),
    );

    render();
    await waitFor(() => text().includes('Вход в почту'), 'экран входа');
    typeInto('#login-email', 'test@mail.local');
    typeInto('#login-password', 'нет');
    const submit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Войти');
    act(() => submit!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => text().includes('Неверный адрес или пароль'), 'сообщение об отказе');
  });
});

describe('выход', () => {
  it('дёргает POST /api/auth/logout и возвращает на вход', async () => {
    vi.spyOn(api, 'getSession').mockResolvedValue({
      authenticated: true,
      email: 'test@mail.local',
    });
    const logout = vi.spyOn(api, 'logout').mockResolvedValue(undefined);

    render(
      <>
        <Gate />
        <LogoutButton />
      </>,
    );
    await waitFor(() => text().includes('Список писем'), 'список писем');

    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Выйти');
    expect(button).toBeDefined();
    act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => text().includes('Вход в почту'), 'экран входа после выхода');
    expect(logout).toHaveBeenCalled();
  });
});

describe('истёкшая сессия', () => {
  it('401 из любого запроса уводит на вход', async () => {
    vi.spyOn(api, 'getSession').mockResolvedValue({
      authenticated: true,
      email: 'test@mail.local',
    });
    render();
    await waitFor(() => text().includes('Список писем'), 'список писем');

    // Настоящий запрос к любому маршруту отвечает 401 — так и бывает,
    // когда сессия закончилась, пока страница была открыта
    const { apiFetch } = await import('../src/api/http');
    await act(async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ error: 'UNAUTHORIZED', message: 'Требуется вход' }),
        })),
      );
      await apiFetch('/api/folders').catch(() => undefined);
      vi.unstubAllGlobals();
    });

    await waitFor(() => text().includes('Вход в почту'), 'экран входа после 401');
  });
});
