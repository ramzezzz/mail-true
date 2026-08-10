// @vitest-environment jsdom
/**
 * Отмена отправки в окне написания.
 *
 * Главное, что здесь проверяется, — это НЕ «плашка появилась», а куда
 * девается письмо:
 *
 *  1. письмо не пропадает из окна, пока идёт отсчёт: отмена возвращает его
 *     на место со всеми получателями, вложениями и набранным текстом,
 *     а не «куда-то в черновики»;
 *  2. отмена — это запрос К СЕРВЕРУ, а не закрытие плашки: письмо ждёт там,
 *     и уход со страницы отменяет отмену, а не отправку;
 *  3. опоздавшая отмена говорит правду («письмо уже ушло») — ни молчания,
 *     ни ложного «отменено»;
 *  4. с выключенной настройкой всё ведёт себя как прежде.
 *
 * Каждая проверка идёт обратным ходом: рядом с «сработало» стоит «а без
 * этого не сработало бы».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows, composeWindowPlaces } from '../src/compose/ComposeWindows';
import { secondsLeft } from '../src/compose/UndoSendBar';
import { emptyDraft, useUiStore, type ComposeWindowState } from '../src/app/store';
import { api } from '../src/api';

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

const buttonByLabel = (label: string): HTMLButtonElement | null =>
  host.querySelector(`button[aria-label="${label}"]`);

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
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

/** Ответ сервера на отправку с включённой отменой. */
function pendingAnswer(seconds = 5) {
  return {
    ok: true,
    sentMessageId: null,
    pendingId: 'очередь-1',
    undoUntil: new Date(Date.now() + seconds * 1000).toISOString(),
  };
}

/** Отправляет письмо из свежего окна и дожидается плашки. */
async function sendLetter(answer: Record<string, unknown> = pendingAnswer()) {
  const send = vi.spyOn(api, 'sendMessage').mockResolvedValue(answer as never);
  render();
  act(() => useUiStore.getState().openCompose());
  type(byLabel('Кому')!, 'kolya@mail.local');
  type(byLabel('Тема')!, 'Договор на подпись');
  click(buttonByText('Отправить'));
  await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
  return send;
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

describe('плашка «Письмо отправлено · Отменить»', () => {
  it('появляется после отправки, а письмо остаётся целым в окне', async () => {
    await sendLetter();
    await waitFor(() => host.textContent?.includes('Письмо отправлено') ?? false, 'плашку');

    expect(buttonByLabel('Отменить отправку')).toBeTruthy();
    // Окно НЕ закрылось: в нём и лежит письмо, которое вернёт отмена
    const win = useUiStore.getState().composeWindows[0];
    expect(win?.draft.pending?.id).toBe('очередь-1');
    expect(win?.draft.subject).toBe('Договор на подпись');
    // …но самого окна на экране нет — видна только плашка
    expect(byLabel('Кому')).toBeNull();
  });

  it('показывает обратный отсчёт, а не просто «отправлено»', async () => {
    await sendLetter(pendingAnswer(10));
    await waitFor(() => host.textContent?.includes('Письмо отправлено') ?? false, 'плашку');
    expect(host.textContent).toMatch(/\b10\b|\b9\b/);
  });

  it('исчезает сама, когда срок вышел: отменять больше нечего', async () => {
    // Срок уже на исходе — ждать по-настоящему секунды в проверке незачем
    await sendLetter(pendingAnswer(0.2));
    await waitFor(
      () => useUiStore.getState().composeWindows.length === 0,
      'закрытие окна по истечении срока',
    );
    expect(host.textContent).not.toContain('Письмо отправлено');
  });
});

describe('отмена возвращает письмо', () => {
  it('в то же окно, со всеми получателями и набранным текстом', async () => {
    const undo = vi.spyOn(api, 'undoSend').mockResolvedValue({ ok: true, cancelled: true });
    await sendLetter();
    await waitFor(() => Boolean(buttonByLabel('Отменить отправку')), 'плашку');

    click(buttonByLabel('Отменить отправку'));
    await waitFor(() => undo.mock.calls.length > 0, 'запрос отмены');

    // Отмена ушла НА СЕРВЕР — там письмо и лежит. Плашка, отменяющая
    // «сама у себя», не отменила бы ничего: сервер о ней не знает.
    // Признак «письмо держит окно» — чтобы сервер не клал лишнюю копию
    // в «Черновики»: возвращает письмо это самое окно, целиком.
    expect(undo.mock.calls[0]?.[0]).toEqual({ pendingId: 'очередь-1', heldByWindow: true });

    await waitFor(() => byLabel('Кому') !== null, 'возврат окна написания');
    expect(byLabel('Кому')?.value).toBe('kolya@mail.local');
    expect(byLabel('Тема')?.value).toBe('Договор на подпись');
    expect(useUiStore.getState().composeWindows[0]?.draft.pending).toBeNull();
    // Ни в какие «Черновики куда-то» письмо не уезжало
    expect(useUiStore.getState().notice).toBeNull();
  });

  it('вместе с вложениями — их идентификаторы остаются прежними', async () => {
    vi.spyOn(api, 'undoSend').mockResolvedValue({ ok: true, cancelled: true });
    vi.spyOn(api, 'sendMessage').mockResolvedValue(pendingAnswer() as never);
    render();
    act(() =>
      useUiStore.getState().openCompose({
        to: 'kolya@mail.local',
        attachments: [{ id: 'загрузка-7', filename: 'договор.pdf', size: 1024 }],
      }),
    );
    click(buttonByText('Отправить'));
    await waitFor(() => Boolean(buttonByLabel('Отменить отправку')), 'плашку');

    click(buttonByLabel('Отменить отправку'));
    await waitFor(() => byLabel('Кому') !== null, 'возврат окна написания');

    const attachments = useUiStore.getState().composeWindows[0]?.draft.attachments ?? [];
    expect(attachments).toHaveLength(1);
    // Тот же идентификатор загрузки: сервер держит файл, пока письмо
    // можно вернуть. Новый id означал бы, что вложение потерялось.
    expect(attachments[0]?.id).toBe('загрузка-7');
    expect(host.textContent).toContain('договор.pdf');
  });

  it('сбрасывает ссылку на черновик: сервер удалил его, приняв письмо', async () => {
    vi.spyOn(api, 'undoSend').mockResolvedValue({ ok: true, cancelled: true });
    vi.spyOn(api, 'sendMessage').mockResolvedValue(pendingAnswer() as never);
    render();
    act(() => useUiStore.getState().openCompose({ to: 'kolya@mail.local', draftUid: 42 }));
    click(buttonByText('Отправить'));
    await waitFor(() => Boolean(buttonByLabel('Отменить отправку')), 'плашку');

    click(buttonByLabel('Отменить отправку'));
    await waitFor(() => byLabel('Кому') !== null, 'возврат окна написания');
    // Ссылаться на удалённый черновик нельзя: следующее сохранение
    // пыталось бы заменить письмо, которого в ящике уже нет
    expect(useUiStore.getState().composeWindows[0]?.draft.draftUid).toBeNull();
  });
});

describe('опоздавшая отмена', () => {
  it('честно говорит «письмо уже ушло», а не молчит и не врёт «отменено»', async () => {
    const undo = vi.spyOn(api, 'undoSend').mockResolvedValue({ ok: true, cancelled: false });
    await sendLetter();
    await waitFor(() => Boolean(buttonByLabel('Отменить отправку')), 'плашку');

    click(buttonByLabel('Отменить отправку'));
    await waitFor(() => undo.mock.calls.length > 0, 'запрос отмены');
    await waitFor(
      () => (useUiStore.getState().notice ?? '').includes('уже ушло'),
      'сообщение об опоздании',
    );

    // Окно закрыто: держать письмо, которое у получателя, не за чем.
    // И, что важнее, оно НЕ вернулось в окно — иначе человек решил бы,
    // что отправлять его надо заново, и отправил бы второй раз.
    await waitFor(
      () => useUiStore.getState().composeWindows.length === 0,
      'закрытие окна после опоздания',
    );
  });

  it('оборванная сеть на отмене не обещает, что письмо осталось', async () => {
    vi.spyOn(api, 'undoSend').mockRejectedValue(new Error('сеть недоступна'));
    await sendLetter();
    await waitFor(() => Boolean(buttonByLabel('Отменить отправку')), 'плашку');

    click(buttonByLabel('Отменить отправку'));
    await waitFor(
      () => (useUiStore.getState().notice ?? '').includes('письмо уйдёт'),
      'честное сообщение о неудавшейся отмене',
    );
  });
});

describe('уход со страницы отправку не отменяет', () => {
  it('размонтирование окна не шлёт отмену: письмо ждёт на сервере и уйдёт', async () => {
    const undo = vi.spyOn(api, 'undoSend').mockResolvedValue({ ok: true, cancelled: true });
    await sendLetter();
    await waitFor(() => Boolean(buttonByLabel('Отменить отправку')), 'плашку');

    // Ровно то, что делает закрытая вкладка: всё, что жило в браузере,
    // исчезает. Ни одного запроса отмены при этом не уходит — и не должно.
    act(() => root.unmount());
    root = createRoot(host);

    expect(undo.mock.calls).toHaveLength(0);
  });

  it('крестик плашки закрывает её, но письма не отзывает', async () => {
    const undo = vi.spyOn(api, 'undoSend').mockResolvedValue({ ok: true, cancelled: true });
    await sendLetter();
    await waitFor(() => Boolean(buttonByLabel('Скрыть сообщение')), 'плашку');

    click(buttonByLabel('Скрыть сообщение'));

    expect(undo.mock.calls).toHaveLength(0);
    expect(useUiStore.getState().composeWindows).toHaveLength(0);
  });
});

describe('выключенная отмена ведёт себя как прежде', () => {
  it('без pendingId окно закрывается сразу и плашки нет', async () => {
    await sendLetter({ ok: true, sentMessageId: 'sent:1' });
    await waitFor(
      () => useUiStore.getState().composeWindows.length === 0,
      'закрытие окна сразу после отправки',
    );
    expect(host.textContent).not.toContain('Письмо отправлено');
  });
});

describe('обратный отсчёт', () => {
  it('считает целые секунды и не уходит в минус', () => {
    const at = new Date('2026-08-06T12:00:05.000Z').toISOString();
    const now = Date.parse('2026-08-06T12:00:00.000Z');
    expect(secondsLeft(at, now)).toBe(5);
    expect(secondsLeft(at, now + 1200)).toBe(4);
    expect(secondsLeft(at, now + 4900)).toBe(1);
    // Прошедший срок — это ноль, а не отрицательное число: иначе плашка
    // показывала бы «-3» и не исчезала
    expect(secondsLeft(at, now + 9000)).toBe(0);
    expect(secondsLeft('не дата', now)).toBe(0);
  });
});

describe('раскладка плашек', () => {
  const windowWith = (id: number, patch: Record<string, unknown>): ComposeWindowState => ({
    id,
    minimized: false,
    init: {},
    draft: { ...emptyDraft({}), ...patch },
  });

  it('несколько отправленных писем встают друг над другом, а не одно на другое', () => {
    const places = composeWindowPlaces([
      windowWith(1, { pending: { id: 'a', until: 'x' } }),
      windowWith(2, { pending: { id: 'b', until: 'y' } }),
    ]);
    expect(places.map((p) => p.undoIndex)).toEqual([0, 1]);
  });

  it('ждущее отмены окно не сдвигает каскад: на экране его нет', () => {
    const places = composeWindowPlaces([
      windowWith(1, { pending: { id: 'a', until: 'x' } }),
      windowWith(2, {}),
      windowWith(3, {}),
    ]);
    // Обратный ход: без пропуска ждущего окна второе письмо оказалось бы
    // сдвинутым на одну ступень вправо ни за что
    expect(places.map((p) => p.offset)).toEqual([0, 0, 1]);
    expect(places.map((p) => p.undoIndex)).toEqual([0, 1, 1]);
  });
});
