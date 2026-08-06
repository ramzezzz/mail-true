// @vitest-environment jsdom
/**
 * Проверки раздела «Одноразовые адреса».
 *
 * Защищается то, что ломается молча:
 *
 *  1. Пока сервер не сказал `available`, ни пункта меню, ни карточки на
 *     главной настроек нет. Пункт, ведущий на страницу «раздел
 *     недоступен», — это кнопка без поведения.
 *  2. На заглушечных данных запрос не отправляется вовсе: настоящий
 *     маршрут без сессии отвечает 401, а общий разбор 401 уводит на вход.
 *  3. Числа про письма никогда не показываются без окна журнала: «0 писем»
 *     и «за сутки писем не было» — разные утверждения.
 *  4. Выключенный адрес виден как выключенный, а не пропадает из списка.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ReactNode } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DisposableAlias, DisposableState } from '../src/settings/disposableApi';
import * as disposableQueries from '../src/settings/disposableQueries';
import * as ownerQueries from '../src/settings/ownerQueries';
import { DisposablePage } from '../src/pages/settings/DisposablePage';
import { SettingsHomePage } from '../src/pages/settings/SettingsHomePage';
import { SettingsLayout } from '../src/settings/SettingsLayout';

/* ------------------------------------------------------------------ */
/* Заготовки                                                            */
/* ------------------------------------------------------------------ */

const ALIAS: DisposableAlias = {
  id: 1,
  address: 'shop-2026@mail.local',
  destination: 'test@mail.local',
  active: true,
  note: 'Магазин обуви',
  createdAt: '2026-08-01T10:00:00.000Z',
  disabledAt: null,
  traffic: {
    received: 3,
    rejected: 0,
    lastAt: '2026-08-05T18:30:00.000Z',
    senders: [{ address: 'prodavec@example.org', count: 3, lastAt: '2026-08-05T18:30:00.000Z' }],
    windowDays: 7,
  },
};

const ON: DisposableState & { loading: boolean } = {
  available: true,
  reason: null,
  items: [ALIAS],
  domain: 'mail.local',
  limit: 50,
  used: 1,
  loading: false,
};

const OFF: DisposableState & { loading: boolean } = {
  available: false,
  reason: 'Не применена миграция 0028_disposable_aliases.sql',
  items: [],
  domain: '',
  limit: 0,
  used: 0,
  loading: false,
};

/** Прочие разделы владельца выключены — чтобы не мешали чтению меню. */
function stubOthers() {
  const off = { available: false, reason: null } as never;
  vi.spyOn(ownerQueries, 'useAccessLog').mockReturnValue(off);
  vi.spyOn(ownerQueries, 'useExports').mockReturnValue(off);
  vi.spyOn(ownerQueries, 'useRecovery').mockReturnValue(off);
}

function stubDisposable(state: DisposableState & { loading: boolean }) {
  vi.spyOn(disposableQueries, 'useDisposable').mockReturnValue(state);
  // Мутации в этих проверках не вызываются, но хуки обязаны вернуть форму.
  const idle = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null };
  vi.spyOn(disposableQueries, 'useCreateDisposable').mockReturnValue(idle as never);
  vi.spyOn(disposableQueries, 'useSetDisposableActive').mockReturnValue(idle as never);
  vi.spyOn(disposableQueries, 'useDeleteDisposable').mockReturnValue(idle as never);
}

let host: HTMLElement;
let root: Root;

function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe('раздела, за которым ничего нет, в меню нет', () => {
  it('без применённой миграции пункта не появляется', () => {
    stubOthers();
    stubDisposable(OFF);
    render(<SettingsLayout />);
    expect(host.textContent).not.toContain('Одноразовые адреса');
  });

  it('и карточки на главной настроек тоже', () => {
    stubOthers();
    stubDisposable(OFF);
    render(<SettingsHomePage />);
    expect(host.textContent).not.toContain('Одноразовые адреса');
  });

  it('когда сервер сказал available — пункт и карточка появляются', () => {
    stubOthers();
    stubDisposable(ON);
    render(<SettingsLayout />);
    expect(host.textContent).toContain('Одноразовые адреса');

    act(() => root.unmount());
    root = createRoot(host);
    render(<SettingsHomePage />);
    expect(host.textContent).toContain('Одноразовые адреса');
  });
});

describe('страница раздела', () => {
  it('без возможности показывает причину словами и не показывает кнопок', () => {
    stubDisposable(OFF);
    render(<DisposablePage />);
    expect(host.textContent).toContain('0028');
    expect(host.textContent).not.toContain('Завести адрес');
  });

  it('показывает адрес, пометку и предел', () => {
    stubDisposable(ON);
    render(<DisposablePage />);
    expect(host.textContent).toContain('shop-2026@mail.local');
    expect(host.textContent).toContain('Магазин обуви');
    expect(host.textContent).toContain('Занято 1 из 50');
  });

  it('число писем всегда идёт вместе с окном журнала', () => {
    stubDisposable(ON);
    render(<DisposablePage />);
    // Ни одного числа про письма без слов «за N суток» рядом.
    expect(host.textContent).toContain('3 письма за 7 суток');
  });

  it('когда журнала нет, чисел про письма нет вовсе — даже нулей', () => {
    stubDisposable({ ...ON, items: [{ ...ALIAS, traffic: null }] });
    render(<DisposablePage />);
    expect(host.textContent).not.toContain('писем');
    expect(host.textContent).not.toContain('письма');
  });

  it('тишину называет тишиной за окно, а не «0 писем»', () => {
    stubDisposable({
      ...ON,
      items: [
        {
          ...ALIAS,
          traffic: { received: 0, rejected: 0, lastAt: null, senders: [], windowDays: 14 },
        },
      ],
    });
    render(<DisposablePage />);
    expect(host.textContent).toContain('За 14 суток писем не было');
  });

  it('выключенный адрес остаётся в списке и помечен выключенным', () => {
    stubDisposable({
      ...ON,
      items: [{ ...ALIAS, active: false, disabledAt: '2026-08-05T12:00:00.000Z' }],
    });
    render(<DisposablePage />);
    expect(host.textContent).toContain('shop-2026@mail.local');
    expect(host.textContent).toContain('выключен');
  });

  it('на исчерпанном пределе кнопка «Завести» выключена', () => {
    stubDisposable({ ...ON, used: 50, limit: 50 });
    render(<DisposablePage />);
    const button = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Завести адрес'),
    );
    expect(button?.disabled).toBe(true);
  });

  it('говорит, что отправитель получает отказ, а не тишину', () => {
    stubDisposable(ON);
    render(<DisposablePage />);
    expect(host.textContent).toContain('отказ');
  });
});

describe('заглушечный режим', () => {
  it('раздел отвечает «недоступно» и не трогает fetch', async () => {
    // Признак режима вычисляется один раз при загрузке модуля, поэтому
    // подменяется он, а не переменная окружения.
    vi.resetModules();
    vi.doMock('../src/api/mockFlag', () => ({ useMocks: true }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const mocked = await import('../src/settings/disposableApi');
    const state = await mocked.disposableApi.getAliases();

    expect(state.available).toBe(false);
    expect(state.reason).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.doUnmock('../src/api/mockFlag');
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe('склонение чисел', () => {
  it('письмо / письма / писем', async () => {
    const { plural } = await import('../src/settings/disposableApi');
    expect(plural(1, 'письмо', 'письма', 'писем')).toBe('письмо');
    expect(plural(3, 'письмо', 'письма', 'писем')).toBe('письма');
    expect(plural(5, 'письмо', 'письма', 'писем')).toBe('писем');
    expect(plural(11, 'письмо', 'письма', 'писем')).toBe('писем');
    expect(plural(21, 'письмо', 'письма', 'писем')).toBe('письмо');
  });
});
