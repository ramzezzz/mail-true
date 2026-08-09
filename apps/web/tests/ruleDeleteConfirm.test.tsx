// @vitest-environment jsdom
/**
 * Правило фильтрации не должно исчезать от одного щелчка.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Корзина рядом с правилом вызывала удаление НАПРЯМУЮ: ни вопроса, ни
 * возможности вернуть. Правило — это несколько экранов настроенных
 * условий и действий (кому, куда, какие метки, пересылка), и заводится
 * оно один раз надолго. Промах мышью по соседней строке означал: настрой
 * заново, а до тех пор письма раскладываться перестали — и заметно это
 * не сразу, а через день-два по разъехавшимся папкам.
 *
 * Вторая половина той же беды: результат запроса не смотрели вовсе. При
 * отказе сервера строка правила возвращалась на место при следующем
 * обновлении списка, и человеку это показывалось как «оно само вернулось».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FiltersPage } from '../src/pages/settings/FiltersPage';
import { settingsApi } from '../src/api';
import { emptyRule, type FilterRule } from '../src/lib/filterRules';

let host: HTMLDivElement;
let root: Root;

const RULE: FilterRule = {
  ...emptyRule(),
  id: 'r-1',
  conditions: [{ field: 'from', operator: 'contains', value: 'buhgalteria@example.com' }],
};

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <FiltersPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  // Список правил приходит запросом — ждём, пока он окажется на странице.
  for (let i = 0; i < 20 && !deleteButton(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

const deleteButton = (): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === 'Удалить правило',
  );

/** Кнопка подтверждения в открытом окне (у окна свой footer с «Отменить»). */
const confirmButton = (): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) =>
    /^(Удалить|Выполняем…)$/.test(b.textContent ?? ''),
  );

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.restoreAllMocks();
  vi.spyOn(settingsApi, 'getFilterRules').mockResolvedValue([RULE]);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('удаление правила фильтрации', () => {
  it('щелчок по корзине только спрашивает, но не удаляет', async () => {
    const remove = vi.spyOn(settingsApi, 'deleteFilterRule').mockResolvedValue(undefined);
    await render();

    await act(async () => {
      deleteButton()?.click();
      await Promise.resolve();
    });

    expect(remove, 'до подтверждения запроса на удаление быть не должно').not.toHaveBeenCalled();
    expect(host.textContent).toContain('Удалить правило?');
    // В вопросе видно, о каком именно правиле речь.
    expect(host.textContent).toContain('buhgalteria@example.com');

    await act(async () => {
      confirmButton()?.click();
      await Promise.resolve();
    });
    expect(remove).toHaveBeenCalledWith('r-1');
  });

  it('отказ сервера остаётся на глазах, окно не закрывается', async () => {
    vi.spyOn(settingsApi, 'deleteFilterRule').mockRejectedValue(new Error('503'));
    await render();

    await act(async () => {
      deleteButton()?.click();
      await Promise.resolve();
    });
    await act(async () => {
      confirmButton()?.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(host.textContent).toContain('Не удалось удалить правило');
    expect(host.textContent, 'окно закрывать нельзя — иначе отказ никто не увидит').toContain(
      'Удалить правило?',
    );
  });
});
