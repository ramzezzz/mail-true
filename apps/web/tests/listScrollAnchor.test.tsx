// @vitest-environment jsdom
/**
 * Список не должен отпрыгивать сам по себе.
 *
 * Курсор клавиатуры список за собой ведёт — это правильно и так и надо.
 * Но эффект, который доводит прокрутку до строки под курсором, зависел ещё
 * и от самих строк, а строки пересобираются от ЛЮБОГО обновления списка:
 * пришло письмо по сокету, человек вернулся во вкладку, сосед пометился
 * прочитанным. Человек уезжал колесом вниз читать темы — и список без
 * единого объяснения утаскивало обратно к строке, которую он давно оставил.
 *
 * Проверяется ровно это: перерисовка с теми же письмами (новым массивом —
 * именно так их и отдавала склейка страниц) прокрутку не трогает.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { MessageSummary } from '@mail-true/shared';
import { MessageList } from '../src/mail/MessageList';
import { useUiStore } from '../src/app/store';

let host: HTMLDivElement;
let root: Root;
let scrollTo: ReturnType<typeof vi.fn>;

function summary(uid: number): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId: `t-${uid}`,
    from: { name: 'Отправитель', address: 'from@example.com' },
    to: [],
    cc: [],
    subject: `Письмо ${uid}`,
    snippet: 'текст',
    date: new Date(2026, 6, 1, 12, 0, uid % 60).toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 1024,
  };
}

const MESSAGES = Array.from({ length: 60 }, (_, i) => summary(i + 1));

function render(messages: readonly MessageSummary[], focusedId: string | null) {
  act(() => {
    root.render(
      <MemoryRouter>
        <MessageList messages={messages} focusedId={focusedId} />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ selectedIds: new Set<string>() });
  // Виртуализация меряет окно через offsetHeight, а в jsdom он всегда ноль
  for (const [prop, value] of [
    ['offsetHeight', 600],
    ['offsetWidth', 900],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value });
  }
  scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('прокрутка к строке под курсором', () => {
  it('переезд курсора список за собой ведёт', () => {
    render(MESSAGES, 'inbox:1');
    const before = scrollTo.mock.calls.length;
    render(MESSAGES, 'inbox:50');
    expect(
      scrollTo.mock.calls.length,
      'курсор уехал за пределы окна — список обязан его догнать',
    ).toBeGreaterThan(before);
  });

  it('обновление писем без переезда курсора прокрутку не трогает', () => {
    render(MESSAGES, 'inbox:50');
    const before = scrollTo.mock.calls.length;
    expect(before, 'без первой доводки проверка была бы пустой').toBeGreaterThan(0);

    // Тот же список, но новым массивом: ровно так его отдавала склейка
    // страниц при каждом фоновом обновлении
    render([...MESSAGES], 'inbox:50');
    expect(scrollTo.mock.calls.length, 'список не должен был никуда ехать').toBe(before);
  });
});
