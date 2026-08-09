// @vitest-environment jsdom
/**
 * Окно написания письма переживает сворачивание.
 *
 * Дефект был устроен так: развёрнутые окна рисовались одним родителем,
 * свёрнутые — другим, поэтому при сворачивании React размонтировал
 * компонент и всё введённое (получатели, тема, вложения, тело письма)
 * пропадало. Тест разворачивает окно обратно и проверяет, что письмо на
 * месте, — на прежнем коде он падает на первом же поле.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React 18 просит явного согласия на act(...) вне тестовых библиотек
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows, composeWindowPlaces } from '../src/compose/ComposeWindows';
import { emptyDraft, useUiStore, type ComposeWindowState } from '../src/app/store';
import { api } from '../src/api';
import { ApiError } from '../src/api/http';

let host: HTMLDivElement;
let root: Root;

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        {/* окно написания живёт поверх страницы, значит внутри роутера */}
        <MemoryRouter>
          <ComposeWindows />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const byLabel = (label: string): HTMLInputElement | null =>
  host.querySelector(`input[aria-label="${label}"]`);

/** Ввод в поле так, как это делает пользователь. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function windowState(): ComposeWindowState {
  const win = useUiStore.getState().composeWindows[0];
  if (!win) throw new Error('окно написания не открылось');
  return win;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ composeWindows: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ composeWindows: [] });
  vi.restoreAllMocks();
});

/** Ждёт появления ожидаемого: запросы асинхронные. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}
${host.textContent}`);
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

describe('сворачивание окна написания', () => {
  it('не теряет получателей, тему и тело письма', () => {
    render();
    act(() => useUiStore.getState().openCompose());

    const to = byLabel('Кому');
    const subject = byLabel('Тема');
    expect(to).not.toBeNull();
    expect(subject).not.toBeNull();

    type(to!, 'kolya@mail.local');
    type(subject!, 'Договор на подпись');

    // Тело письма набирается в contenteditable
    const editor = host.querySelector('[aria-label="Текст письма"]') as HTMLElement | null;
    expect(editor).not.toBeNull();
    act(() => {
      editor!.innerHTML = '<div>Коллеги, во вложении договор.</div>';
      editor!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Сворачиваем — на экране остаётся только плашка с темой
    const id = windowState().id;
    act(() => useUiStore.getState().toggleComposeMinimized(id));
    expect(byLabel('Кому')).toBeNull();
    expect(host.textContent).toContain('Договор на подпись');

    // Разворачиваем обратно: письмо должно быть целым
    act(() => useUiStore.getState().toggleComposeMinimized(id));
    expect(byLabel('Кому')?.value).toBe('kolya@mail.local');
    expect(byLabel('Тема')?.value).toBe('Договор на подпись');
    const editorAgain = host.querySelector('[aria-label="Текст письма"]') as HTMLElement;
    expect(editorAgain.innerHTML).toContain('Коллеги, во вложении договор.');
  });

  it('не размонтирует окно: собственное состояние компонента остаётся', () => {
    render();
    act(() => useUiStore.getState().openCompose());

    // «Развернуть» — состояние самого компонента, не черновика. Если при
    // сворачивании окно размонтируется, оно потеряется вместе со всем
    // остальным: именно так и терялось письмо.
    const expand = host.querySelector('button[aria-label="Развернуть"]') as HTMLButtonElement;
    act(() => expand.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelector('button[aria-label="Свернуть в окно"]')).not.toBeNull();

    const id = windowState().id;
    act(() => useUiStore.getState().toggleComposeMinimized(id));
    act(() => useUiStore.getState().toggleComposeMinimized(id));

    expect(host.querySelector('button[aria-label="Свернуть в окно"]')).not.toBeNull();
  });

  it('вложения и раскрытые поля копий тоже переживают сворачивание', () => {
    render();
    act(() => useUiStore.getState().openCompose());
    const id = windowState().id;

    act(() =>
      useUiStore.getState().updateComposeDraft(id, {
        showCc: true,
        cc: 'boss@mail.local',
        attachments: [{ id: 'up-1', filename: 'Договор.pdf', size: 12_345 }],
      }),
    );

    act(() => useUiStore.getState().toggleComposeMinimized(id));
    act(() => useUiStore.getState().toggleComposeMinimized(id));

    expect(byLabel('Копия')?.value).toBe('boss@mail.local');
    expect(host.textContent).toContain('Договор.pdf');
    expect(windowState().draft.attachments).toHaveLength(1);
  });
});

describe('composeWindowPlaces', () => {
  const win = (id: number, minimized: boolean): ComposeWindowState => ({
    id,
    minimized,
    init: {},
    draft: emptyDraft({}),
  });

  it('все окна — одним списком в порядке открытия, свёрнуты они или нет', () => {
    const windows = [win(1, false), win(2, true), win(3, false)];
    expect(composeWindowPlaces(windows).map((p) => p.win.id)).toEqual([1, 2, 3]);

    // Сворачивание не меняет ни состав списка, ни порядок — только это
    // и уберегает окно от размонтирования
    const afterMinimize = [win(1, true), win(2, true), win(3, false)];
    expect(composeWindowPlaces(afterMinimize).map((p) => p.win.id)).toEqual([1, 2, 3]);
  });

  it('развёрнутые встают каскадом, свёрнутые — в ряд слева', () => {
    const places = composeWindowPlaces([win(1, false), win(2, true), win(3, false), win(4, true)]);
    expect(places.map((p) => p.offset)).toEqual([0, 0, 1, 0]);
    expect(places[1]?.minimizedLeft).toBe(16);
    expect(places[3]?.minimizedLeft).toBeGreaterThan(16);
  });
});

describe('черновик окна написания', () => {
  it('хранится в состоянии, а не в компоненте, и переживает сворачивание', () => {
    const store = useUiStore.getState();
    store.openCompose({ subject: 'Re: Отчёт' });
    const id = windowState().id;

    useUiStore.getState().updateComposeDraft(id, { to: 'a@mail.local', bodyHtml: '<p>текст</p>' });
    useUiStore.getState().toggleComposeMinimized(id);

    expect(windowState().minimized).toBe(true);
    expect(windowState().draft.to).toBe('a@mail.local');
    expect(windowState().draft.bodyHtml).toBe('<p>текст</p>');
    expect(windowState().draft.subject).toBe('Re: Отчёт');
  });

  it('функциональный патч видит текущее значение — вложения не затираются', () => {
    useUiStore.getState().openCompose();
    const id = windowState().id;
    useUiStore.getState().updateComposeDraft(id, {
      attachments: [{ id: '1', filename: 'a.pdf', size: 1 }],
    });
    useUiStore.getState().updateComposeDraft(id, (draft) => ({
      attachments: [...draft.attachments, { id: '2', filename: 'b.pdf', size: 2 }],
    }));
    expect(windowState().draft.attachments.map((a) => a.id)).toEqual(['1', '2']);
  });
});

describe('отказы при отправке и сохранении', () => {
  it('письмо не отправилось — окно на месте, причина видна', async () => {
    vi.spyOn(api, 'sendMessage').mockRejectedValue(
      new ApiError(502, '/api/messages/send', 'Не удалось отправить письмо'),
    );
    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Кому')!, 'kolya@mail.local');
    type(byLabel('Тема')!, 'Важное письмо');

    act(() => button('Отправить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Раньше кнопка просто переставала мигать, и было непонятно, ушло ли письмо
    await waitFor(
      () => (host.textContent ?? '').includes('Не удалось отправить письмо'),
      'причину отказа',
    );
    expect(byLabel('Кому')?.value).toBe('kolya@mail.local');
    expect(useUiStore.getState().composeWindows).toHaveLength(1);
  });

  it('Esc не закрывает окно, если черновик не сохранился', async () => {
    vi.spyOn(api, 'saveDraft').mockRejectedValue(
      new ApiError(503, '/api/drafts', 'Папка черновиков недоступна'),
    );
    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Кому')!, 'kolya@mail.local');

    const window_ = host.querySelector('section[aria-label="Новое письмо"]') as HTMLElement;
    act(() => {
      window_.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await waitFor(
      () => (host.textContent ?? '').includes('Не удалось сохранить черновик'),
      'причину отказа сохранения',
    );
    // Окно осталось вместе с текстом: закрыть его сейчас значило бы потерять письмо
    expect(useUiStore.getState().composeWindows).toHaveLength(1);
    expect(byLabel('Кому')?.value).toBe('kolya@mail.local');
  });

  it('Esc закрывает окно, когда черновик сохранился', async () => {
    vi.spyOn(api, 'saveDraft').mockResolvedValue({
      ok: true,
      draftId: 'drafts:21',
      draftUid: 21,
      savedAt: new Date().toISOString(),
    });
    render();
    act(() => useUiStore.getState().openCompose());

    const window_ = host.querySelector('section[aria-label="Новое письмо"]') as HTMLElement;
    act(() => {
      window_.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await waitFor(() => useUiStore.getState().composeWindows.length === 0, 'закрытие окна');
  });

  it('повторное сохранение заменяет черновик, а не плодит копии', async () => {
    const saveDraft = vi.spyOn(api, 'saveDraft').mockResolvedValue({
      ok: true,
      draftId: 'drafts:21',
      draftUid: 21,
      savedAt: new Date().toISOString(),
    });
    render();
    act(() => useUiStore.getState().openCompose());

    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => windowState().draft.draftUid === 21, 'первый ответ сервера');

    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => saveDraft.mock.calls.length === 2, 'второе сохранение');
    // Во второй раз уходит draftUid — сервер удалит прежнюю версию черновика
    expect(saveDraft.mock.calls[1]?.[0]?.draftUid).toBe(21);
  });

  it('вложение не загрузилось — пользователь об этом узнаёт', async () => {
    vi.spyOn(api, 'uploadAttachment').mockRejectedValue(
      new ApiError(413, '/api/uploads', 'Файл слишком велик'),
    );
    render();
    act(() => useUiStore.getState().openCompose());

    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'big.bin');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));

    // Раньше это был необработанный промис: файл молча не прикреплялся
    await waitFor(
      () => (host.textContent ?? '').includes('Не удалось загрузить «big.bin»'),
      'причину отказа',
    );
    expect(windowState().draft.attachments).toHaveLength(0);
  });
});

describe('закрытие окна написания', () => {
  /**
   * Главный случай. Крестик уничтожал написанное письмо: закрывал окно
   * напрямую, без сохранения, без черновика и без вопроса. При этом Esc в том
   * же окне вёл себя правильно — сохранял черновик и закрывался только при
   * успехе. Два жеста «закрыть» делали прямо противоположное, и более
   * очевидный из двух уничтожал работу.
   */
  it('крестик сохраняет написанное черновиком, а не выбрасывает', async () => {
    const saveDraft = vi
      .spyOn(api, 'saveDraft')
      .mockResolvedValue({ savedAt: new Date().toISOString(), draftUid: 7 } as never);

    render();
    act(() => useUiStore.getState().openCompose());

    type(byLabel('Кому')!, 'kolya@mail.local');
    type(byLabel('Тема')!, 'Важное письмо');
    const editor = host.querySelector('[aria-label="Текст письма"]') as HTMLElement;
    act(() => {
      editor.innerHTML = '<div>Текст, который нельзя потерять.</div>';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const cross = [...host.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Закрыть',
    );
    expect(cross, 'крестик должен быть на экране').toBeTruthy();
    act(() => cross!.click());

    await waitFor(() => saveDraft.mock.calls.length > 0, 'черновик должен сохраниться');
    const payload = saveDraft.mock.calls[0]?.[0] as { subject?: string; bodyHtml?: string };
    expect(payload.subject).toBe('Важное письмо');
    expect(payload.bodyHtml).toContain('нельзя потерять');

    await waitFor(
      () => useUiStore.getState().composeWindows.length === 0,
      'окно должно закрыться после сохранения',
    );
  });

  it('окно не закрывается, если черновик не сохранился', async () => {
    vi.spyOn(api, 'saveDraft').mockRejectedValue(
      new ApiError(503, '/api/drafts', 'Сервер не отвечает'),
    );

    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Тема')!, 'Черновик, который не сохранился');

    const cross = [...host.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Закрыть',
    );
    act(() => cross!.click());

    await waitFor(
      () => host.textContent?.includes('Не удалось сохранить черновик') === true,
      'человеку должны сказать об отказе',
    );
    expect(
      useUiStore.getState().composeWindows.length,
      'окно с несохранённым письмом закрывать нельзя',
    ).toBe(1);
  });

  it('крестик СВЁРНУТОГО окна тоже сохраняет написанное', async () => {
    /*
     * Ту же беду чинили у развёрнутого окна, а у свёрнутого она осталась.
     * Причина: проверка «есть ли что терять» смотрела на текст РЕДАКТОРА,
     * а у свёрнутой плашки редактора в DOM нет вовсе — ref пуст. Если
     * человек набрал только текст (тему и адресата ещё не заполнил),
     * окно считалось пустым и закрывалось молча.
     */
    const saveDraft = vi
      .spyOn(api, 'saveDraft')
      .mockResolvedValue({ savedAt: new Date().toISOString(), draftUid: 11 } as never);

    render();
    act(() => useUiStore.getState().openCompose());

    const editor = host.querySelector('[aria-label="Текст письма"]') as HTMLElement;
    act(() => {
      editor.innerHTML = '<div>Набрано и свёрнуто — терять нельзя.</div>';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Сворачиваем: редактор уходит из DOM, остаётся плашка.
    const [win] = useUiStore.getState().composeWindows;
    act(() => useUiStore.getState().toggleComposeMinimized(win!.id));
    expect(
      host.querySelector('[aria-label="Текст письма"]'),
      'после сворачивания редактора в DOM быть не должно',
    ).toBeNull();

    const cross = [...host.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Закрыть',
    );
    expect(cross, 'крестик на свёрнутой плашке должен быть').toBeTruthy();
    act(() => cross!.click());

    await waitFor(() => saveDraft.mock.calls.length > 0, 'черновик должен сохраниться');
    const payload = saveDraft.mock.calls[0]?.[0] as { bodyHtml?: string };
    expect(payload.bodyHtml).toContain('терять нельзя');
  });

  it('пустое окно закрывается сразу, черновик из ничего не заводится', async () => {
    const saveDraft = vi.spyOn(api, 'saveDraft').mockResolvedValue({} as never);

    render();
    act(() => useUiStore.getState().openCompose());

    const cross = [...host.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Закрыть',
    );
    act(() => cross!.click());

    expect(useUiStore.getState().composeWindows.length).toBe(0);
    expect(saveDraft, 'пустое письмо сохранять незачем').not.toHaveBeenCalled();
  });

  it('«Отменить» выбрасывает написанное только после подтверждения', () => {
    render();
    act(() => useUiStore.getState().openCompose());
    type(byLabel('Тема')!, 'Написанное');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => button('Отменить')!.click());
    expect(confirm).toHaveBeenCalled();
    expect(
      useUiStore.getState().composeWindows.length,
      'отказ от подтверждения оставляет окно',
    ).toBe(1);

    confirm.mockReturnValue(true);
    act(() => button('Отменить')!.click());
    expect(useUiStore.getState().composeWindows.length).toBe(0);
  });
});
