// @vitest-environment jsdom
/**
 * Ни облака, ни календаря, ни заметок в продукте нет и не планируется,
 * а кнопки к ним были: «Из Облака» в окне написания и «Создать событие»
 * в контекстном меню списка и в шапке письма. Кнопка, которая ничего не
 * делает, хуже её отсутствия — тест ловит их возвращение.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { useUiStore } from '../src/app/store';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

/** Все файлы разметки интерфейса — только в них живут подписи кнопок. */
function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, found);
    else if (entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

describe('следов облака, календаря и заметок нет в разметке', () => {
  it.each([
    ['облако', /Облак/],
    ['календарь', /Календар/],
    ['заметки', /Заметк/],
  ])('нигде не упоминается %s', (_what, pattern) => {
    const guilty = tsxFiles(SRC).filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(guilty).toEqual([]);
  });

  it('нет и кнопки «Создать событие»', () => {
    const guilty = tsxFiles(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes('Создать событие'),
    );
    expect(guilty).toEqual([]);
  });
});

describe('окно написания письма', () => {
  let host: HTMLDivElement;
  let root: Root;

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
  });

  function open() {
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
    act(() => useUiStore.getState().openCompose());
  }

  const buttonTexts = (): string[] =>
    [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');

  it('кнопки прикрепления из облака больше нет, обычная — на месте', () => {
    open();
    expect(buttonTexts().some((t) => /Облак/i.test(t))).toBe(false);
    expect(buttonTexts().some((t) => t.includes('Прикрепить файл'))).toBe(true);
  });
});
