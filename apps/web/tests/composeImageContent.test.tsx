// @vitest-environment jsdom
/**
 * Письмо, состоящее из одной картинки, — это письмо.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ЭТО
 * ------------------------------------------------------------------
 * Проверка «есть ли что терять» сравнивала ВИДИМЫЙ ТЕКСТ: разметка
 * снималась целиком, и `<img>` от неё не оставалось ничего. На этом
 * сравнении держатся три вещи разом — идёт ли автосохранение,
 * спрашивать ли при закрытии окна и мешать ли уходу со страницы.
 *
 * Выходило так: человек нажал «Написать», вставил снимок экрана и больше
 * ничего не набрал. Черновик не сохранялся НИ РАЗУ, а крестик и Esc
 * закрывали окно молча и сразу — снимок исчезал без следа. Тем же путём
 * терялась правка «убрать из черновика лишнее фото»: видимый текст от
 * неё не менялся, значит и сохранять было якобы нечего.
 *
 * Проверки идут через настоящее окно написания и настоящие события, а не
 * через вызов функции: дефект был именно в связке «редактор → проверка».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { visibleContent, visibleText } from '../src/compose/ComposeWindow';
import { useUiStore } from '../src/app/store';
import { api } from '../src/api';

let host: HTMLDivElement;
let root: Root;

/** Однопиксельный PNG — настоящие байты, а не выдуманные. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

/** Вставить картинку в тело — так же, как это делает Ctrl+V со снимком. */
function pasteImage() {
  const box = editor();
  if (!box) throw new Error('нет тела письма');
  act(() => {
    box.insertAdjacentHTML('afterbegin', `<img src="${PNG}">`);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const pressEscape = () => {
  const box = editor();
  if (!box) throw new Error('нет тела письма');
  act(() => box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
};

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

describe('картинка — это содержимое письма', () => {
  it('Esc на письме из одной картинки сохраняет черновик, а не закрывает молча', async () => {
    const save = vi
      .spyOn(api, 'saveDraft')
      .mockResolvedValue({ ok: true, draftId: 'drafts:1', draftUid: 1, savedAt: '' });
    render();
    act(() => useUiStore.getState().openCompose({ to: 'irina@mail.local' }));

    pasteImage();
    pressEscape();
    await settle();

    expect(save).toHaveBeenCalled();
    const sent = save.mock.calls[0]?.[0] as { bodyHtml?: string } | undefined;
    expect(sent?.bodyHtml ?? '').toContain('data:image/png');
  });

  it('удаление картинки из черновика тоже считается правкой', () => {
    /*
     * Открыл черновик с фотографией, убрал её, закрыл окно. Видимый текст
     * при этом не изменился ни на знак — и правка пропадала: фотография
     * оставалась в черновике на месте.
     */
    const withImage = `<div>Смотрите</div><img src="${PNG}">`;
    const withoutImage = '<div>Смотрите</div>';

    // Прежнее сравнение этих двух тел не различало
    expect(visibleText(withImage)).toBe(visibleText(withoutImage));
    // Новое — различает
    expect(visibleContent(withImage)).not.toBe(visibleContent(withoutImage));
  });

  it('нетронутое письмо с картинкой в цитате изменившимся НЕ считается', () => {
    /*
     * Обратный ход, и он здесь обязателен. Сравнивай мы разметку целиком —
     * окно считало бы изменившимся нетронутый ответ (браузер переписывает
     * порядок атрибутов и кавычки по-своему), и черновик молча
     * переписывался бы от одного лишь открытия «посмотреть».
     */
    const fromServer =
      '<blockquote><img src="/api/messages/inbox:9/parts/2" alt="фото"></blockquote>';
    const fromBrowser =
      "<blockquote><img alt='фото' src='/api/messages/inbox:9/parts/2'></blockquote>";

    expect(visibleContent(fromServer)).toBe(visibleContent(fromBrowser));
  });

  it('амперсанд в адресе картинки не делает письмо изменившимся', () => {
    // Браузер экранирует `&` в значении атрибута при чтении разметки —
    // без разворота сущностей два одинаковых тела оказались бы разными.
    const raw = '<img src="/api/parts?id=2&size=big">';
    const escaped = '<img src="/api/parts?id=2&amp;size=big">';

    expect(visibleContent(raw)).toBe(visibleContent(escaped));
  });
});
