// @vitest-environment jsdom
/**
 * Панель форматирования письма.
 *
 * Было (эталонные снимки интерфейса — эталон): кнопки подписаны
 * юникодными глифами «⇤ ↔ •• 1. ↶ ↷», ссылка — цветным эмодзи 🔗, выбор
 * смайлика — нативным `select` со значением 🙂, «очистить форматирование» —
 * комбинирующим символом «A̶». Рядом стояли знаки трёх разных оптических
 * плотностей, два из них цветные. Плюс `select` гарнитуры шириной 48px:
 * «Golos Text» в него не влезал, обрезался и налезал на стрелку.
 *
 * Стало: один набор штриховых значков (сетка 24×24, штрих 1.8,
 * currentColor), выбор гарнитуры и смайлика — меню, а не `select`.
 * Буквы Ж/К/Ч/З остаются: в привычных почтовых интерфейсах начертания подписаны так же.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { useUiStore } from '../src/app/store';

let host: HTMLDivElement;
let root: Root;

/** Панель форматирования: ряд, в котором лежит кнопка «Жирный». */
function formatBar(): HTMLElement {
  const bold = [...host.querySelectorAll('button')].find((b) => b.title === 'Жирный');
  expect(bold, 'кнопки «Жирный» нет — панель не отрисовалась').toBeDefined();
  return bold!.parentElement!;
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ composeWindows: [] });
  act(() => useUiStore.getState().openCompose());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ composeWindows: [] });
  vi.restoreAllMocks();
});

/** Символы, которыми панель была подписана раньше. */
const OLD_GLYPHS = ['⇤', '↔', '••', '1.', '↶', '↷', '🔗', '🙂', 'A̶'];

describe('панель форматирования — один набор значков', () => {
  it('ни одной кнопки, подписанной юникодным глифом или эмодзи', () => {
    render();
    const bar = formatBar();
    for (const glyph of OLD_GLYPHS) {
      expect(bar.textContent, `на панели остался глиф «${glyph}»`).not.toContain(glyph);
    }
  });

  it('у выравнивания, списков, отмены, ссылки и ластика — значки, а не текст', () => {
    render();
    const bar = formatBar();
    const titles = [
      'По левому краю',
      'По центру',
      'Маркированный список',
      'Нумерованный список',
      'Отменить',
      'Повторить',
      'Вставить ссылку',
      'Вставить смайлик',
      'Очистить форматирование',
      'Шрифт',
    ];
    for (const title of titles) {
      const btn = [...bar.querySelectorAll('button')].find((b) => b.title === title);
      expect(btn, `нет кнопки «${title}»`).toBeDefined();
      expect(btn!.querySelector('svg'), `у «${title}» нет значка`).not.toBeNull();
      expect(btn!.textContent?.trim(), `у «${title}» осталась текстовая подпись`).toBe('');
    }
  });

  it('значки нарисованы в одной сетке 24×24 и наследуют цвет', () => {
    render();
    const bar = formatBar();
    const icons = [...bar.querySelectorAll('button svg')];
    expect(icons.length).toBeGreaterThanOrEqual(9);
    for (const icon of icons) {
      expect(icon.getAttribute('viewBox'), 'значок вне сетки 24×24').toBe('0 0 24 24');
      const painted = icon.getAttribute('stroke') ?? icon.getAttribute('fill');
      expect(painted, 'значок покрашен не currentColor').toBe('currentColor');
    }
  });

  it('начертания по-прежнему подписаны буквами Ж/К/Ч/З — как в привычных почтовых интерфейсах', () => {
    render();
    const bar = formatBar();
    for (const [title, letter] of [
      ['Жирный', 'Ж'],
      ['Наклонный', 'К'],
      ['Подчёркнутый', 'Ч'],
      ['Зачёркнутый', 'З'],
    ]) {
      const btn = [...bar.querySelectorAll('button')].find((b) => b.title === title);
      expect(btn?.textContent).toBe(letter);
    }
  });

  it('в панели не осталось нативных `select` — гарнитура выбирается меню', () => {
    render();
    // Раньше их было три: гарнитура (48px, «Golos Text» не влезал),
    // размер и смайлик
    expect(formatBar().querySelectorAll('select')).toHaveLength(0);
  });
});
