// @vitest-environment jsdom
/**
 * «Уйдут позже» — письма, отложенные кнопкой «Отправить позже».
 *
 * Проверяется не «панель нарисовалась», а то, ради чего она заведена:
 * между нажатием и сроком письма не было видно НИГДЕ — из «Черновиков»
 * оно уходит при постановке в очередь, в «Отправленные» ещё не попало.
 * Значит человек должен: увидеть письмо в списке, узнать, кому и когда
 * оно уйдёт, отменить его — и получить обратно в «Черновики», а не
 * потерять.
 *
 * Отдельно проверяется честность отказа: «письмо прямо сейчас
 * отправляется» — это не «письмо уже ушло», и говорить одно вместо
 * другого нельзя.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { formatRecipients, formatSendAt } from '../src/compose/ScheduledPanel';
import { useUiStore } from '../src/app/store';
import { api } from '../src/api';
import type { ScheduledMessage } from '../src/api/types';

let host: HTMLDivElement;
let root: Root;

function scheduled(patch: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: 'ochered-1',
    sendAt: new Date(Date.now() + 3600_000).toISOString(),
    subject: 'Договор на подпись',
    to: ['kolya@mail.local'],
    attempts: 0,
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

/** Кнопку ищем по вхождению: рядом с текстом стоит значок раскрытия. */
const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

const click = (element: Element | null | undefined) => {
  if (!element) throw new Error('нечего нажимать');
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
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

describe('отложенное письмо видно и его можно вернуть', () => {
  it('панель показывает, кому и когда уйдёт письмо', async () => {
    vi.spyOn(api, 'getScheduled').mockResolvedValue([scheduled()]);
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([]);
    render();

    await waitFor(() => host.textContent?.includes('Уйдут позже') ?? false, 'панель очереди');
    click(buttonByText('Уйдут позже'));
    expect(host.textContent).toContain('Договор на подпись');
    expect(host.textContent).toContain('kolya@mail.local');
  });

  it('пустая очередь не рисует ничего', async () => {
    vi.spyOn(api, 'getScheduled').mockResolvedValue([]);
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([]);
    render();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(host.textContent).not.toContain('Уйдут позже');
  });

  it('отмена зовёт сервер по номеру письма — тому самому, что он и вернул', async () => {
    vi.spyOn(api, 'getScheduled').mockResolvedValue([scheduled()]);
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([]);
    const undo = vi
      .spyOn(api, 'undoSend')
      .mockResolvedValue({ ok: true, cancelled: true, draftUid: 42, draftId: 'drafts:42' });
    render();

    await waitFor(() => host.textContent?.includes('Уйдут позже') ?? false, 'панель очереди');
    click(buttonByText('Уйдут позже'));
    click(buttonByText('Отменить'));
    await waitFor(() => undo.mock.calls.length > 0, 'запрос отмены');
    /*
     * Признака «письмо держит окно» здесь быть НЕ ДОЛЖНО: окна у этого
     * письма нет — ни у отложенного на понедельник, ни у обычного, которому
     * почтовый сервер отказал временно. Пошли бы мы его отсюда, сервер
     * снял бы письмо с очереди БЕЗ возврата в «Черновики», то есть кнопка
     * «Отменить» уничтожала бы письмо целиком.
     */
    expect(undo.mock.calls[0]?.[0]).toEqual({ pendingId: 'ochered-1' });
  });

  it('«сейчас отправляется» не выдаётся за «письмо уже ушло»', async () => {
    vi.spyOn(api, 'getScheduled').mockResolvedValue([scheduled()]);
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([]);
    vi.spyOn(api, 'undoSend').mockResolvedValue({ ok: true, cancelled: false, reason: 'sending' });
    render();

    await waitFor(() => host.textContent?.includes('Уйдут позже') ?? false, 'панель очереди');
    click(buttonByText('Уйдут позже'));
    click(buttonByText('Отменить'));
    await waitFor(
      () => host.textContent?.includes('прямо сейчас отправляется') ?? false,
      'честную причину отказа',
    );
    expect(host.textContent).not.toContain('уже ушло');
  });
});

describe('время и получатели читаются словами', () => {
  it('сегодня и завтра называются словами, а не датой', () => {
    const today = new Date();
    today.setHours(18, 30, 0, 0);
    expect(formatSendAt(today.toISOString())).toMatch(/^сегодня в /);

    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    tomorrow.setHours(9, 0, 0, 0);
    expect(formatSendAt(tomorrow.toISOString())).toMatch(/^завтра в /);
  });

  it('получателей не перечисляют строкой в километр', () => {
    expect(formatRecipients(['a@mail.local'])).toBe('a@mail.local');
    expect(formatRecipients(['a@mail.local', 'b@mail.local', 'c@mail.local'])).toBe(
      'a@mail.local и ещё 2',
    );
    expect(formatRecipients([])).toBe('без получателей');
  });
});
