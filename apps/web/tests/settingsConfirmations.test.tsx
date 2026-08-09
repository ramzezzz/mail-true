// @vitest-environment jsdom
/**
 * Необратимое в настройках ящика не должно случаться от одного щелчка.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Две кнопки удаляли сразу, без вопроса и без возможности вернуть:
 *
 *   * «Удалить всё сейчас» в «Восстановлении писем» — а это последнее
 *     место, откуда очищенную корзину ещё можно было достать. Кнопка
 *     стоит вплотную к строке с занятым объёмом, там же, где человек
 *     читает, сколько места едят эти письма;
 *   * корзина в «Почте с других ящиков» — вместе с подключением пропадают
 *     адрес сервера, порт, логин и пароль, введённые тремя шагами
 *     мастера. Часто это отдельный «пароль приложения», который надо идти
 *     выпускать заново.
 *
 * Третье, из того же разряда: автоответчик включался с пустым текстом.
 * Сборка файла правил такой автоответ пропускает, то есть не отвечает
 * никто, — а на экране горит включённый переключатель, переживающий
 * перезагрузку страницы.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RecoveryPage } from '../src/pages/settings/RecoveryPage';
import { CollectorPage } from '../src/pages/settings/CollectorPage';
import { GeneralSettingsPage } from '../src/pages/settings/GeneralSettingsPage';
import { settingsApi } from '../src/api';
import { ownerApi } from '../src/settings/ownerApi';
import { useUiStore } from '../src/app/store';

let host: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
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
  useUiStore.setState({ notice: null });
  vi.restoreAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('«Удалить всё сейчас» в восстановлении писем', () => {
  beforeEach(() => {
    vi.spyOn(ownerApi, 'getRecovery').mockResolvedValue({
      available: true,
      reason: null,
      days: 7,
      maxDays: 30,
      items: [
        {
          id: 1,
          subject: 'Договор',
          fromAddress: 'a@b.ru',
          sentAt: '2026-08-01T00:00:00.000Z',
          deletedAt: '2026-08-05T00:00:00.000Z',
          purgeAt: '2026-08-12T00:00:00.000Z',
          sizeBytes: 2048,
          originPath: 'INBOX',
        },
      ],
      totals: { count: 1, bytes: 2048 },
      scheduledPurge: null,
    } as never);
  });

  it('щелчок только спрашивает, писем не трогает', async () => {
    const purge = vi.spyOn(ownerApi, 'purgeMessages').mockResolvedValue({ purged: 1 });
    render(<RecoveryPage />);
    await waitFor(() => Boolean(buttonByText('Удалить всё сейчас')), 'кнопку удаления');

    click(buttonByText('Удалить всё сейчас'));
    expect(purge, 'до подтверждения удалять нечего').not.toHaveBeenCalled();
    expect(host.textContent).toContain('Удалить всё сейчас?');
    // В вопросе сказано главное: вернуть будет нельзя ничем.
    expect(host.textContent).toContain('восстановить их нельзя');

    click(buttonByText('Удалить'));
    await waitFor(() => purge.mock.calls.length > 0, 'удаление после подтверждения');
    expect(purge.mock.calls[0]?.[0]).toBe('all');
  });

  it('отмена оставляет письма на месте', async () => {
    const purge = vi.spyOn(ownerApi, 'purgeMessages').mockResolvedValue({ purged: 1 });
    render(<RecoveryPage />);
    await waitFor(() => Boolean(buttonByText('Удалить всё сейчас')), 'кнопку удаления');

    click(buttonByText('Удалить всё сейчас'));
    click(buttonByText('Отменить'));
    expect(purge).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Удалить всё сейчас?');
  });
});

describe('удаление подключения в «Почте с других ящиков»', () => {
  it('спрашивает и называет, что именно пропадёт', async () => {
    vi.spyOn(settingsApi, 'getCollectors').mockResolvedValue([
      {
        id: 3,
        email: 'staraya@yandex.ru',
        protocol: 'imap',
        host: 'imap.yandex.ru',
        port: 993,
        secure: true,
        login: 'staraya@yandex.ru',
        targetFolderId: 'inbox',
        leaveOnServer: true,
        applyFilters: false,
        enabled: true,
        status: 'ok',
        lastSyncAt: null,
        lastError: null,
      },
    ] as never);
    const remove = vi.spyOn(settingsApi, 'deleteCollector').mockResolvedValue(undefined);

    render(<CollectorPage />);
    await waitFor(() => host.textContent?.includes('staraya@yandex.ru') ?? false, 'подключение');

    const trash = [...host.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Удалить ящик',
    );
    click(trash);
    expect(remove, 'до подтверждения запроса быть не должно').not.toHaveBeenCalled();
    expect(host.textContent).toContain('Удалить подключение?');
    // Человеку сказано, что придётся вводить заново, — это и есть цена.
    expect(host.textContent).toContain('придётся ввести снова');

    click(buttonByText('Удалить'));
    await waitFor(() => remove.mock.calls.length > 0, 'удаление после подтверждения');
    expect(remove.mock.calls[0]?.[0]).toBe(3);
  });
});

describe('автоответчик без текста', () => {
  it('не сохраняется и объясняет почему', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue({
      senderName: 'Демо',
      signatures: [],
      defaultSignatureId: null,
      quoteOriginalOnReply: true,
      autoReply: { enabled: false, text: '', from: null, to: null },
      notifications: { browser: false, sound: false },
      undoSendSeconds: 5,
      threadedList: true,
      autoCollectContacts: true,
      senderLogos: false,
    } as never);
    const save = vi.spyOn(settingsApi, 'saveGeneral');

    render(<GeneralSettingsPage />);
    await waitFor(() => Boolean(buttonByText('Сохранить')), 'страницу настроек');

    const toggle = [...host.querySelectorAll('input[type="checkbox"]')].find((input) =>
      (input.closest('label')?.textContent ?? '').includes('Включить автоответчик'),
    );
    act(() => {
      (toggle as HTMLInputElement).click();
    });

    click(buttonByText('Сохранить'));
    expect(save, 'включённый автоответчик без текста не отвечает никому').not.toHaveBeenCalled();
    expect(useUiStore.getState().notice ?? '').toContain('без текста');
    // И у самого поля видно, чего не хватает.
    expect(host.textContent).toContain('Без текста автоответчик не отвечает');
  });
});
