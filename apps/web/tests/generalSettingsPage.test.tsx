// @vitest-environment jsdom
/**
 * Общие настройки ящика против ответа, устроенного как настоящий.
 *
 * Ответы ниже сняты с работающего стенда (127.0.0.1:8080, ящик
 * test@mail.local):
 *
 *   PUT /api/settings/general {"autoReply":{"from":"2026-08-01",…}}
 *     → {"autoReply":{"from":"2026-08-01T00:00:00.000Z","to":"2026-08-20T00:00:00.000Z"}}
 *   PUT /api/settings/general {"signatures":[{"id":"new-1",…}]}  → id "34"
 *   тот же запрос ещё раз                                        → id "35"
 *   и ещё раз                                                    → id "36"
 *
 * Отсюда два дефекта: полную дату ISO поле `<input type="date">` не берёт и
 * показывается пустым (а пустое поле сохраняется как null — срок отпуска
 * пропадает), и черновик после сохранения не перечитывался, поэтому второе
 * нажатие «Сохранить» слало прежний придуманный `new-…` и заводило ещё одну
 * подпись вместо правки прежней. Заглушка всегда отдавала `from: null` и
 * сама придумывала id — на ней не спотыкалось ни то, ни другое.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { settingsApi } from '../src/api';
import type { GeneralSettings } from '../src/api/settingsTypes';
import { dateInputValue } from '../src/settings/generalSettings';
import { GeneralSettingsPage } from '../src/pages/settings/GeneralSettingsPage';

let host: HTMLDivElement;
let root: Root;

/** Ответ сервера: даты — полным ISO, идентификаторы подписей — числами. */
function serverSettings(patch: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    senderName: 'Тест Тестович',
    signatures: [{ id: '31', name: 'Рабочая', text: '—\nС уважением, Тест' }],
    defaultSignatureId: '31',
    autoReply: {
      enabled: true,
      text: 'В отпуске до конца августа',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-20T00:00:00.000Z',
    },
    notifications: { browser: false, tabCounter: true },
    quoteOriginalOnReply: true,
    afterDelete: 'list',
    autoCollectContacts: true,
    ...patch,
  };
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <GeneralSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

const dateFields = (): HTMLInputElement[] => [...host.querySelectorAll('input[type="date"]')];

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

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

describe('срок автоответчика', () => {
  it('приводит дату сервера к виду поля', () => {
    // Ровно то, что отдаёт сервер
    expect(dateInputValue('2026-08-01T00:00:00.000Z')).toBe('2026-08-01');
    // Уже подходящее значение не портим
    expect(dateInputValue('2026-08-20')).toBe('2026-08-20');
    expect(dateInputValue(null)).toBe('');
    // Мусор лучше показать пустым полем, чем недействительным значением
    expect(dateInputValue('когда-нибудь')).toBe('');
  });

  it('показывает срок отпуска, а не пустые поля', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    render();
    await waitFor(() => dateFields().length === 2, 'поля срока автоответчика');

    // Раньше браузер отбрасывал полный ISO и оба поля были пустыми
    expect(dateFields().map((f) => f.value)).toEqual(['2026-08-01', '2026-08-20']);
  });

  it('остаётся на экране и после сохранения', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    // Сервер и в ответе на сохранение отдаёт даты полным ISO
    const saveGeneral = vi
      .spyOn(settingsApi, 'saveGeneral')
      .mockImplementation(async (settings) => {
        const saved = structuredClone(settings);
        saved.autoReply.from = '2026-08-01T00:00:00.000Z';
        saved.autoReply.to = '2026-08-20T00:00:00.000Z';
        return saved;
      });

    render();
    await waitFor(() => dateFields().length === 2, 'поля срока автоответчика');
    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => saveGeneral.mock.calls.length === 1, 'сохранение');
    await waitFor(() => host.textContent!.includes('Настройки сохранены'), 'отметку об успехе');

    // Сохранённый срок уходил на сервер, а показать его было нечем: человек
    // видел пустые поля и считал, что отпуск слетел
    expect(dateFields().map((f) => f.value)).toEqual(['2026-08-01', '2026-08-20']);
    expect(saveGeneral.mock.calls[0]?.[0]?.autoReply.from).not.toBeNull();
  });
});

describe('идентификатор подписи', () => {
  it('второе сохранение правит ту же подпись, а не заводит ещё одну', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ signatures: [], defaultSignatureId: null }),
    );

    // Сервер выдаёт подписи собственные идентификаторы; придуманный
    // клиентом `new-…` он не находит и заводит новую строку
    let nextId = 31;
    const saveGeneral = vi
      .spyOn(settingsApi, 'saveGeneral')
      .mockImplementation(async (settings) => {
        const saved = structuredClone(settings);
        saved.signatures = saved.signatures.map((s) =>
          /^\d+$/u.test(s.id) ? s : { ...s, id: String((nextId += 1)) },
        );
        saved.defaultSignatureId = saved.signatures[0]?.id ?? null;
        return saved;
      });

    render();
    await waitFor(() => Boolean(button('Добавить подпись')), 'кнопку добавления подписи');
    act(() =>
      button('Добавить подпись')!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => saveGeneral.mock.calls.length === 1, 'первое сохранение');
    expect(saveGeneral.mock.calls[0]?.[0]?.signatures[0]?.id).toMatch(/^new-/u);

    await waitFor(
      () => !button('Сохранить')!.hasAttribute('disabled'),
      'кнопку после первого сохранения',
    );
    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => saveGeneral.mock.calls.length === 2, 'второе сохранение');

    // Раньше сюда снова уходил `new-…`: id рос 32 → 33 → 34 на каждое нажатие
    const secondId = saveGeneral.mock.calls[1]?.[0]?.signatures[0]?.id;
    expect(secondId).toBe('32');
    expect(secondId).not.toMatch(/^new-/u);
  });

  it('подпись по умолчанию остаётся выбранной после сохранения', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ signatures: [], defaultSignatureId: null }),
    );
    vi.spyOn(settingsApi, 'saveGeneral').mockImplementation(async (settings) => {
      const saved = structuredClone(settings);
      saved.signatures = saved.signatures.map((s) => ({ ...s, id: '31' }));
      saved.defaultSignatureId = '31';
      return saved;
    });

    render();
    await waitFor(() => Boolean(button('Добавить подпись')), 'кнопку добавления подписи');
    act(() =>
      button('Добавить подпись')!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => host.textContent!.includes('Настройки сохранены'), 'отметку об успехе');

    const select = [...host.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.textContent === 'Без подписи'),
    );
    expect(select?.value).toBe('31');
  });
});

describe('адресная книга', () => {
  it('переключатель вернулся вместе с самой подсказкой адреса', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    render();
    await waitFor(() => host.textContent!.includes('Автоответчик'), 'страницу настроек');

    // Раньше раздела здесь не было намеренно: адресной книги в продукте не
    // существовало, и переключатель не менял ровно ничего. Теперь за ним
    // стоит GET /api/contacts/suggest и указатель переписки в Postgres.
    expect(host.textContent).toContain('Адресная книга');
    expect(host.textContent).toContain('Пополнять контакты из полученных писем');
    // Цена сказана рядом с выключателем, а не спрятана: речь о списке тех,
    // кто пишет человеку.
    expect(host.textContent).toContain('удаляется вместе с ним');
  });

  it('переключатель меняет своё поле, а не соседние', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ autoCollectContacts: true }),
    );
    const saveGeneral = vi
      .spyOn(settingsApi, 'saveGeneral')
      .mockImplementation(async (settings) => structuredClone(settings));
    render();
    await waitFor(() => host.textContent!.includes('Адресная книга'), 'раздел адресной книги');

    const toggle = [...host.querySelectorAll('input[type="checkbox"]')].find(
      (node) => node.closest('label')?.textContent?.includes('Пополнять контакты') === true,
    ) as HTMLInputElement | undefined;
    expect(toggle, 'переключателя пополнения контактов нет').toBeTruthy();
    expect(toggle!.checked).toBe(true);
    act(() => toggle!.click());

    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => saveGeneral.mock.calls.length === 1, 'сохранение');
    expect(saveGeneral.mock.calls[0]?.[0]?.autoCollectContacts).toBe(false);
    // Обратный ход: соседние настройки переключатель не задел
    expect(saveGeneral.mock.calls[0]?.[0]?.quoteOriginalOnReply).toBe(
      serverSettings().quoteOriginalOnReply,
    );
  });

  it('значение всё равно уходит на сервер нетронутым', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ autoCollectContacts: false }),
    );
    const saveGeneral = vi
      .spyOn(settingsApi, 'saveGeneral')
      .mockImplementation(async (settings) => structuredClone(settings));

    render();
    await waitFor(() => Boolean(button('Сохранить')), 'кнопку сохранения');
    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => saveGeneral.mock.calls.length === 1, 'сохранение');

    // Убрали переключатель, а не поле: чужое значение затирать нельзя
    expect(saveGeneral.mock.calls[0]?.[0]?.autoCollectContacts).toBe(false);
  });
});

describe('отмена отправки', () => {
  const undoSelect = (): HTMLSelectElement | undefined =>
    [...host.querySelectorAll('select')].find((s) =>
      s.closest('label,div')?.textContent?.includes('Отменить отправку'),
    );

  it('предлагает выключить и три срока — ровно то, что понимает сервер', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings({ undoSendSeconds: 5 }));
    render();
    await waitFor(() => Boolean(undoSelect()), 'выбор срока отмены');

    const options = [...(undoSelect()?.options ?? [])].map((o) => o.value);
    expect(options).toEqual(['0', '5', '10', '30']);
    // Ноль подписан по-человечески: «0 секунд» никому ничего не говорит
    expect(undoSelect()?.options[0]?.textContent).toContain('сразу');
    expect(undoSelect()?.value).toBe('5');
  });

  it('выбранный срок уходит на сервер числом, а не строкой', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings({ undoSendSeconds: 5 }));
    const saveGeneral = vi
      .spyOn(settingsApi, 'saveGeneral')
      .mockImplementation(async (settings) => structuredClone(settings));

    render();
    await waitFor(() => Boolean(undoSelect()), 'выбор срока отмены');

    const select = undoSelect()!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, '30');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => saveGeneral.mock.calls.length === 1, 'сохранение');

    // Схема сервера принимает 0, 5, 10 и 30 числами; строка «30» была бы
    // отвергнута целиком — вместе со всей формой настроек
    expect(saveGeneral.mock.calls[0]?.[0]?.undoSendSeconds).toBe(30);
  });

  it('«выключено» сохраняется как ноль, а не пропадает из запроса', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings({ undoSendSeconds: 0 }));
    const saveGeneral = vi
      .spyOn(settingsApi, 'saveGeneral')
      .mockImplementation(async (settings) => structuredClone(settings));

    render();
    await waitFor(() => Boolean(undoSelect()), 'выбор срока отмены');
    expect(undoSelect()?.value).toBe('0');

    act(() => button('Сохранить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => saveGeneral.mock.calls.length === 1, 'сохранение');
    // Обратный ход: поле, пропавшее из запроса, сервер понимает как
    // «не трогать» — и выключить отмену было бы нечем
    expect(saveGeneral.mock.calls[0]?.[0]?.undoSendSeconds).toBe(0);
  });

  it('честно предупреждает, что письмо эти секунды ждёт на сервере', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
    render();
    await waitFor(() => Boolean(undoSelect()), 'выбор срока отмены');
    // Умолчать о цене нельзя: «отправил и ушёл» иначе однажды окажется
    // неправдой, а человек об этом узнает от адресата
    expect(host.textContent).toContain('уходит');
    expect(host.textContent).toContain('закрыть вкладку');
  });
});
