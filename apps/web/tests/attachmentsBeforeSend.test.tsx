// @vitest-environment jsdom
/**
 * Письмо не должно уходить, пока вложения ещё едут на сервер.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Письмо собирается из идентификаторов УЖЕ ЗАГРУЖЕННЫХ вложений: пока
 * файл не доехал, в черновике его просто нет. А кнопка «Отправить» знала
 * ровно одно условие — идёт ли сама отправка.
 *
 * Отсюда потеря, которую человек замечает у получателя:
 *
 *   * прикрепил файл на двадцать мегабайт, дописал «см. вложение», нажал
 *     «Отправить» через пять секунд — письмо ушло БЕЗ файла и без единого
 *     предупреждения;
 *   * то же при пересылке: вложения исходного письма скачиваются и
 *     заливаются обратно фоном, а окно открывается сразу.
 *
 * Загрузка потом дописывала вложение в уже закрытое окно — то есть в
 * никуда.
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

let host: HTMLDivElement;
let root: Root;

function render(): void {
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

const sendButton = (): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) =>
    /Отправить|Ждём вложения/.test(b.textContent ?? ''),
  );

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.getState().closeAllCompose();
  vi.restoreAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('отправка и недоехавшие вложения', () => {
  it('пока файл грузится, отправить нельзя', async () => {
    // Загрузка, которая не завершится, пока мы её не отпустим.
    let release: ((value: unknown) => void) | undefined;
    vi.spyOn(api, 'uploadAttachment').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as ReturnType<typeof api.uploadAttachment>,
    );
    const send = vi.spyOn(api, 'sendMessage').mockResolvedValue({ ok: true } as never);

    act(() => {
      useUiStore.getState().openCompose({ to: 'ivan@mail.local', subject: 'см. вложение' });
    });
    render();

    const input = host.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input, 'в окне должно быть поле выбора файла').toBeTruthy();

    const file = new File(['x'.repeat(1024)], 'schet.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const button = sendButton();
    expect(button?.disabled, 'кнопка обязана быть недоступна, пока файл едет').toBe(true);
    expect(button?.textContent).toContain('Ждём вложения');

    // Даже если нажать силой — письмо не уходит.
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(send).not.toHaveBeenCalled();

    // Отпускаем загрузку — и отправка снова доступна.
    await act(async () => {
      release?.({ id: 'up-1', filename: 'schet.pdf', size: 1024 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendButton()?.disabled).toBe(false);
  });

  it('пересылка ждёт перенос вложений исходного письма', async () => {
    /*
     * Перенос идёт мимо окна: файлы скачивает и заливает страница письма,
     * а окно узнаёт о них через счётчик в самом черновике.
     */
    const send = vi.spyOn(api, 'sendMessage').mockResolvedValue({ ok: true } as never);

    let windowId = 0;
    act(() => {
      windowId = useUiStore.getState().openCompose({ to: 'ivan@mail.local', subject: 'Fwd: счёт' });
      useUiStore.getState().updateComposeDraft(windowId, (draft) => ({
        pendingAttachments: draft.pendingAttachments + 1,
      }));
    });
    render();

    const button = sendButton();
    expect(button?.disabled, 'вложения ещё едут — отправлять нечего').toBe(true);

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(send).not.toHaveBeenCalled();

    act(() => {
      useUiStore.getState().updateComposeDraft(windowId, (draft) => ({
        pendingAttachments: Math.max(0, draft.pendingAttachments - 1),
      }));
    });
    expect(sendButton()?.disabled).toBe(false);
  });
});
