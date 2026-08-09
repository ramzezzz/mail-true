// @vitest-environment jsdom
/**
 * Нетронутое окно ответа закрывается БЕЗ черновика.
 *
 * Дефект: окно ответа открывается уже заполненным — «Кому» из письма,
 * тема «Re: …», цитата исходного письма, подпись по умолчанию. Проверка
 * «есть ли что терять» смотрела на всё это как на написанное человеком и
 * потому отвечала «есть» ВСЕГДА. Esc не смотрел на неё вовсе и сохранял
 * безусловно.
 *
 * Что это значило: открыл ответ, перечитал письмо, передумал отвечать,
 * нажал Esc — в «Черновиках» появилось письмо, которого человек не писал.
 * За рабочий день таких пустышек набирается десяток, и настоящий
 * недописанный черновик теряется среди них. Обещание в комментарии
 * («пустое окно закрывается сразу») при этом не выполнялось никогда.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { visibleText } from '../src/compose/ComposeWindow';
import { useUiStore } from '../src/app/store';
import { api } from '../src/api';

let host: HTMLDivElement;
let root: Root;

/** Ответ, каким его собирает composeFromMessage.replyInit. */
const REPLY = {
  to: 'irina@mail.local',
  subject: 'Re: Договор на подпись',
  bodyHtml:
    '<br><br><p>6 августа, Ирина &lt;irina@mail.local&gt;:</p>' +
    '<blockquote><div>Добрый день! Отправляю договор на подпись.</div></blockquote>',
  inReplyTo: '<dogovor@mail.local>',
  sourceMessageId: 'inbox:9',
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

const byLabel = (label: string): HTMLInputElement | null =>
  host.querySelector(`input[aria-label="${label}"]`);

const buttonByLabel = (label: string): HTMLButtonElement | null =>
  host.querySelector(`button[aria-label="${label}"]`);

const editor = (): HTMLElement | null =>
  host.querySelector('[role="textbox"][aria-label="Текст письма"]');

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

/** Дописать в тело письма — так же, как это делает человек с клавиатуры. */
function writeInBody(text: string) {
  const box = editor();
  if (!box) throw new Error('нет тела письма');
  act(() => {
    box.insertAdjacentHTML('afterbegin', `<div>${text}</div>`);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const pressEscape = () => {
  const box = editor();
  if (!box) throw new Error('нет тела письма');
  act(() => box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
};

/** Дать промисам мутации провернуться. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
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

function spySaveDraft() {
  return vi
    .spyOn(api, 'saveDraft')
    .mockResolvedValue({ ok: true, draftId: 'drafts:1', draftUid: 1, savedAt: '' });
}

describe('нетронутое окно', () => {
  it('Esc на ответе, к которому не притронулись, не пишет черновик', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));

    pressEscape();
    await settle();

    expect(
      save,
      'в «Черновиках» появилось письмо, которого человек не писал',
    ).not.toHaveBeenCalled();
    expect(useUiStore.getState().composeWindows.length, 'окно осталось открытым').toBe(0);
  });

  it('крестик на нетронутом ответе ведёт себя так же', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));

    click(buttonByLabel('Закрыть'));
    await settle();

    expect(save).not.toHaveBeenCalled();
    expect(useUiStore.getState().composeWindows.length).toBe(0);
  });

  it('пустое новое письмо закрывается сразу — как и раньше', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose());

    pressEscape();
    await settle();
    expect(save).not.toHaveBeenCalled();
    expect(useUiStore.getState().composeWindows.length).toBe(0);
  });
});

describe('окно, в котором поработали', () => {
  it('одна дописанная строка ответа сохраняется черновиком', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));

    writeInBody('Договор подписан, отправляю сканы завтра.');
    pressEscape();
    await settle();

    expect(save, 'написанное потеряно вместе с окном').toHaveBeenCalled();
    const payload = save.mock.calls[0]?.[0];
    expect(JSON.stringify(payload?.bodyHtml)).toContain('Договор подписан');
  });

  it('дописанный получатель — тоже работа человека', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));

    type(byLabel('Кому')!, 'irina@mail.local, kolya@mail.local');
    pressEscape();
    await settle();
    expect(save).toHaveBeenCalled();
  });

  it('исправленная тема — тоже', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));

    type(byLabel('Тема')!, 'Re: Договор на подпись — с правками');
    pressEscape();
    await settle();
    expect(save).toHaveBeenCalled();
  });

  it('стёртая цитата — не «пусто», а правка: её тоже нельзя терять', async () => {
    const save = spySaveDraft();
    render();
    act(() => useUiStore.getState().openCompose(REPLY));

    const box = editor();
    act(() => {
      if (box) box.innerHTML = '<div>Спасибо!</div>';
      box?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    pressEscape();
    await settle();
    expect(save).toHaveBeenCalled();
  });
});

describe('видимый текст разметки', () => {
  it('не зависит от того, как браузер расставил теги и пробелы', () => {
    expect(visibleText('<div>а</div><div>б</div>')).toBe(visibleText('а  б'));
    expect(visibleText('<p><br></p>')).toBe('');
    expect(visibleText('&nbsp;&nbsp;')).toBe('');
  });

  it('разворачивает сущности — цитата приходит и разметкой, и текстом', () => {
    expect(visibleText('&lt;irina@mail.local&gt;')).toBe('<irina@mail.local>');
    expect(visibleText('&amp;')).toBe('&');
  });
});
