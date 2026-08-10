// @vitest-environment jsdom
/**
 * Черновик сохраняется САМ.
 *
 * ------------------------------------------------------------------
 * ЧЕГО НЕ БЫЛО
 * ------------------------------------------------------------------
 * Автосохранения не было ни одного: черновик уходил на сервер только по
 * кнопке «Сохранить» и при закрытии окна. То есть F5, закрытая вкладка,
 * упавший браузер, уснувший телефон, случайный переход по ссылке
 * уничтожали написанное целиком и молча — при том что окно показывало
 * подпись «Сохранено в 14:32», на сервере жила очередь сохранений, а
 * разбор адресов в черновике умел даже недописанные строки. Весь механизм
 * был готов, не было ровно одного: того, кто его позовёт.
 *
 * Проверки идут парой: рядом с «сохранилось» стоит «а вот это сохраняться
 * не должно» — иначе папка «Черновики» обросла бы письмами, которых
 * человек не писал.
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

/** Ответ, каким его собирает окно: «Кому», тема и цитата уже заполнены. */
const REPLY = {
  to: 'irina@mail.local',
  subject: 'Re: Договор',
  bodyHtml: '<br><br><blockquote><div>Добрый день!</div></blockquote>',
  inReplyTo: '<dogovor@mail.local>',
};

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

const editor = (): HTMLElement | null =>
  host.querySelector('[role="textbox"][aria-label="Текст письма"]');

/** Дописать в тело письма — так же, как это делает человек с клавиатуры. */
function writeInBody(text: string) {
  const box = editor();
  if (!box) throw new Error('нет тела письма');
  act(() => {
    box.insertAdjacentHTML('afterbegin', `<div>${text}</div>`);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Пауза в наборе — та самая, после которой черновик уходит сам. */
async function pause(ms = 4000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
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
  vi.useRealTimers();
});

function spySaveDraft() {
  return vi
    .spyOn(api, 'saveDraft')
    .mockResolvedValue({
      ok: true,
      draftId: 'drafts:1',
      draftUid: 1,
      savedAt: '2026-08-10T09:00:00.000Z',
    });
}

describe('черновик уходит на сервер сам', () => {
  it('через паузу в наборе — без единого нажатия «Сохранить»', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));

    writeInBody('Договор посмотрел, всё в порядке');
    await pause();

    expect(save, 'написанное так и осталось бы только в браузере').toHaveBeenCalledTimes(1);
    const payload = save.mock.calls[0]?.[0] as { bodyHtml: string; subject: string };
    expect(payload.bodyHtml).toContain('Договор посмотрел');
    expect(payload.subject).toBe('Re: Договор');
    // UID черновика запомнен: следующая запись заменит его, а не заведёт
    // второй экземпляр того же письма.
    expect(useUiStore.getState().composeWindows[0]?.draft.draftUid).toBe(1);
  });

  it('второй раз — только если что-то изменилось', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));
    /*
     * Ждём подпись. Она приходит своим запросом настроек и почти всегда
     * позже открытия окна, то есть меняет тело письма сама по себе. Это
     * настоящее изменение, и черновик после него обновиться обязан —
     * поэтому считать записи начинаем, когда окно устоялось.
     */
    await pause();

    writeInBody('Первая правка');
    await pause();
    expect(save).toHaveBeenCalledTimes(1);

    // Обратный ход: человек ушёл за кофе, ничего не набрав. Запросов
    // больше быть не должно — иначе окно долбило бы сервер вечно.
    await pause(20_000);
    expect(save, 'запись повторяется без единой правки').toHaveBeenCalledTimes(1);

    writeInBody('Вторая правка');
    await pause();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('нетронутый ответ не сохраняется — даже спустя долгую паузу', async () => {
    /*
     * Окно ответа открывается уже заполненным: «Кому», тема «Re: …»,
     * цитата и подпись. Считать это написанным нельзя — иначе каждое
     * открытое и брошенное окно само заводило бы черновик, и настоящий
     * недописанный терялся бы среди десятка пустышек за день.
     */
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));

    await pause(30_000);

    expect(
      save,
      'в «Черновиках» появилось письмо, которого человек не писал',
    ).not.toHaveBeenCalled();
  });
});
