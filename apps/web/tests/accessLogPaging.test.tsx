// @vitest-environment jsdom
/**
 * История входов длиннее одной страницы.
 *
 * Постраничный проход сервер умел с самого начала: маршрут принимает
 * `before` и честно отвечает `hasMore`. Интерфейс же запрашивал ровно
 * одну страницу и оба поля выбрасывал — история обрывалась на сотой
 * записи молча, и человек, разбирающийся «это был я?», упирался в стену
 * без единого слова о том, что дальше что-то есть.
 *
 * Отдельно проверяется курсор: за `before` берётся время последней СВОЕЙ
 * записи, а не последней строки на экране. Строки из журналов почтового
 * сервера подмешиваются только к первой странице и своего курсора не
 * имеют — взяв их время, мы перепрыгнули бы через свои записи.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AccessLogPage } from '../src/pages/settings/AccessLogPage';
import { ownerApi, type AccessEvent, type AccessLogState } from '../src/settings/ownerApi';

let host: HTMLDivElement;
let root: Root;

function event(patch: Partial<AccessEvent>): AccessEvent {
  return {
    at: '2026-08-08T10:00:00.000Z',
    channel: 'web',
    success: true,
    ip: '203.0.113.7',
    where: 'интернет',
    userAgent: null,
    service: false,
    detail: 'Вход через веб-интерфейс',
    origin: 'app',
    ...patch,
  };
}

function page(items: AccessEvent[], hasMore: boolean): AccessLogState {
  return { available: true, reason: null, retentionDays: 90, items, hasMore };
}

function render(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AccessLogPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('нечего нажимать');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
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
  vi.restoreAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('история входов длиннее страницы', () => {
  it('показывает «Показать более ранние» и догружает записи по своему курсору', async () => {
    const first = page(
      [
        event({ at: '2026-08-08T10:00:00.000Z', detail: 'Вход через веб-интерфейс' }),
        event({
          at: '2026-08-08T09:00:00.000Z',
          detail: 'Свой вход, самый старый на странице',
        }),
        // Строка из журнала Dovecot: она старше, но курсором быть не может.
        event({
          at: '2020-01-01T00:00:00.000Z',
          origin: 'dovecot',
          channel: 'imap',
          detail: 'Вход по IMAP из журнала',
        }),
      ],
      true,
    );
    const second = page(
      [event({ at: '2026-08-07T10:00:00.000Z', detail: 'Вход неделю назад' })],
      false,
    );

    const load = vi
      .spyOn(ownerApi, 'getAccessLog')
      .mockImplementation((before?: string) => Promise.resolve(before ? second : first));

    render();
    await waitFor(() => (host.textContent ?? '').includes('Вход через веб-интерфейс'), 'историю');

    const more = buttonByText('Показать более ранние');
    expect(more, 'кнопки «Показать более ранние» нет, хотя сервер сказал hasMore').toBeTruthy();

    click(more);
    await waitFor(() => (host.textContent ?? '').includes('Вход неделю назад'), 'вторую страницу');

    expect(load.mock.calls[1]?.[0], 'курсор — время последней СВОЕЙ записи').toBe(
      '2026-08-08T09:00:00.000Z',
    );
    // Первая страница остаётся на экране: это продолжение списка, а не замена.
    expect(host.textContent).toContain('Вход через веб-интерфейс');
    // Больше грузить нечего — кнопка ушла.
    expect(buttonByText('Показать более ранние')).toBeUndefined();
  });

  it('без продолжения кнопки нет вовсе', async () => {
    vi.spyOn(ownerApi, 'getAccessLog').mockResolvedValue(page([event({})], false));
    render();
    await waitFor(() => (host.textContent ?? '').includes('Вход через веб-интерфейс'), 'историю');
    expect(buttonByText('Показать более ранние')).toBeUndefined();
  });
});
