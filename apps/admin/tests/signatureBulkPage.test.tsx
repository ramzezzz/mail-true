/**
 * Страница групповой установки подписей: защита от применения вслепую.
 *
 * Три поведения, ради которых страница и разделена на шаги. Каждое
 * закрывает способ испортить чужие подписи одним неверным нажатием:
 *
 *   1. «Применить» не работает, пока не посчитан предпросмотр. Иначе
 *      администратор узнаёт о последствиях уже из журнала аудита.
 *   2. Если предпросмотр насчитал уничтожаемые чужие подписи, нужна
 *      отдельная отмашка — само по себе нажатие «Применить» ею не является.
 *   3. Правка условий ПОСЛЕ предпросмотра снова запирает применение:
 *      посчитали в режиме «добавить», переключили на «заменить» и нажали —
 *      уничтожив подписи, о которых предупреждения не было.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignatureBulkPreview } from '../src/api/types';

/** Что вернёт предпросмотр — меняется прямо в проверке. */
let previewAnswer: SignatureBulkPreview;
const applied: unknown[] = [];

vi.mock('../src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    domains: () => Promise.resolve({ items: [{ id: 1, name: 'mail.local', userCount: 3 }] }),
    signatureVariables: () =>
      Promise.resolve({
        items: [
          { name: 'имя', hint: '', manual: false },
          { name: 'должность', hint: '', manual: true },
        ],
      }),
    signatureBulkPreview: () => Promise.resolve(previewAnswer),
    signatureBulkApply: (body: unknown) => {
      applied.push(body);
      return Promise.resolve({
        ok: true,
        applied: 1,
        failed: [],
        total: 1,
        willAdd: 1,
        willReplace: 0,
        willSkipExisting: 0,
        willSkipIncomplete: 0,
        signaturesReplaced: 0,
        withExistingSignatures: 0,
      });
    },
  },
}));

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, session: { login: 'osmotr' } }),
}));

const { SignatureBulkPage } = await import('../src/pages/SignatureBulkPage');

function preview(over: Partial<SignatureBulkPreview> = {}): SignatureBulkPreview {
  return {
    problem: null,
    mode: 'append',
    total: 3,
    willAdd: 3,
    willReplace: 0,
    willSkipExisting: 0,
    willSkipIncomplete: 0,
    signaturesReplaced: 0,
    withExistingSignatures: 0,
    rows: [],
    rowsTruncated: 0,
    sample: { email: 'a@mail.local', displayName: 'Анна', outcome: 'add', missing: [], text: 'Анна' },
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  previewAnswer = preview();
  applied.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Рисует страницу и даёт запросам отработать. */
async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SignatureBulkPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Кнопка по видимому тексту — так же, как её ищет человек. */
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!found) throw new Error(`Кнопка «${text}» не найдена`);
  return found;
}

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('групповая установка подписей', () => {
  it('не даёт применить шаблон, пока не посчитан предпросмотр', async () => {
    await render();
    expect(container.textContent).toContain('Сначала посчитайте предпросмотр');
    expect(() => button('Применить')).toThrow();
  });

  it('после предпросмотра без потерь применение доступно сразу', async () => {
    await render();
    await click(button('Посчитать и показать'));
    expect(button('Применить').disabled).toBe(false);
  });

  it('требует отдельной отмашки, когда чужие подписи будут уничтожены', async () => {
    previewAnswer = preview({
      mode: 'replace',
      willAdd: 1,
      willReplace: 2,
      signaturesReplaced: 3,
      withExistingSignatures: 2,
    });
    await render();
    await click(button('Посчитать и показать'));

    // Число потерь названо прямо, а не спрятано в подсказке.
    expect(container.textContent).toContain('чужих подписей будет затёрто');
    expect(container.textContent).toMatch(/Будет уничтожено 3 существующие подписи/);

    const apply = button('Применить');
    expect(apply.disabled).toBe(true);

    const confirm = container.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)');
    expect(confirm).not.toBeNull();
  });

  it('правка шаблона после предпросмотра снова запирает применение', async () => {
    await render();
    await click(button('Посчитать и показать'));
    expect(button('Применить').disabled).toBe(false);

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'совсем другой шаблон');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('Условия изменились после предпросмотра');
    expect(button('Применить').disabled).toBe(true);
    expect(applied).toHaveLength(0);
  });

  it('шаблон с неизвестной подстановкой применить нельзя', async () => {
    previewAnswer = preview({
      problem: 'Неизвестные подстановки: {{долность}}',
      willAdd: 3,
    });
    await render();
    await click(button('Посчитать и показать'));

    expect(container.textContent).toContain('{{долность}}');
    expect(button('Применить').disabled).toBe(true);
  });
});
