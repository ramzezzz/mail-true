// @vitest-environment jsdom
/**
 * Страница настроек уведомлений.
 *
 * Три вещи здесь важнее остальных, и каждая — про доверие, а не про
 * работоспособность:
 *
 *   1. Разрешение у браузера спрашивается ТОЛЬКО по нажатию человека.
 *      Спросить его при открытии страницы — значит почти наверняка
 *      получить «Блокировать» и потерять уведомления навсегда.
 *   2. Недоступный уровень со сводкой ИИ НЕ ПРЯЧЕТСЯ, а объясняется.
 *      Спрятанный пункт выглядит как отсутствие возможности; человек
 *      должен понимать, что мешает, и к кому обращаться.
 *   3. Настройка «класть содержимое в push» выключена по умолчанию и
 *      рассказывает обе стороны сделки — что защищено и чем платят.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { settingsApi } from '../src/api';
import type { GeneralSettings } from '../src/api/settingsTypes';
import { notificationsApi } from '../src/notifications/api';
import type { NotificationPrefs, PushState } from '../src/notifications/types';
import {
  NotificationsPage,
  minutesToTime,
  timeToMinutes,
} from '../src/pages/settings/NotificationsPage';

let host: HTMLDivElement;
let root: Root;

function generalSettings(patch: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    senderName: '',
    signatures: [],
    defaultSignatureId: null,
    autoReply: { enabled: false, text: '', from: null, to: null },
    notifications: { browser: false, tabCounter: true },
    quoteOriginalOnReply: true,
    afterDelete: 'list',
    autoCollectContacts: true,
    showSenderLogos: false,
    ...patch,
  };
}

function prefs(patch: Partial<NotificationPrefs> = {}): NotificationPrefs {
  return {
    enabled: true,
    level: 'sender-subject',
    push: false,
    pushPayload: false,
    skipFiltered: true,
    quietHours: { enabled: false, fromMinutes: 1380, toMinutes: 420 },
    timeZone: 'Europe/Moscow',
    updatedAt: null,
    ...patch,
  };
}

function pushState(patch: Partial<PushState> = {}): PushState {
  return {
    pushAvailable: true,
    pushUnavailableReason: null,
    vapidPublicKey:
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    prefs: prefs(),
    devices: [],
    ai: { available: true, reason: null },
    ...patch,
  };
}

/** Подменяет Notification: разрешение и счётчик обращений к нему. */
function stubNotification(permission: NotificationPermission, answer = permission) {
  const requestPermission = vi.fn(async () => answer);
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = requestPermission;
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { requestPermission };
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <NotificationsPage />
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
  throw new Error(`не дождались: ${what}`);
}

const text = (): string => host.textContent ?? '';

/** Переключатель по подписи. */
function switchByLabel(label: string): HTMLInputElement {
  const found = [...host.querySelectorAll('label')].find((el) => el.textContent?.includes(label));
  const input = found?.querySelector('input[type="checkbox"]');
  if (!input) throw new Error(`не найден переключатель «${label}»`);
  return input as HTMLInputElement;
}

function radioByLabel(label: string): HTMLInputElement {
  const found = [...host.querySelectorAll('label')].find((el) => el.textContent?.includes(label));
  const input = found?.querySelector('input[type="radio"]');
  if (!input) throw new Error(`не найден пункт «${label}»`);
  return input as HTMLInputElement;
}

/**
 * Настоящее нажатие: React слушает у флажков и переключателей событие
 * `click`, а не `change`. Отправленный вручную `change` пройдёт мимо
 * обработчика — и проверка «зелёная» при неработающей странице.
 */
function click(element: HTMLInputElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  /*
   * jsdom по умолчанию объявляет страницу незащищённой, и раздел честно
   * отвечал бы «уведомления работают только по https» на каждую проверку.
   * В браузере на 127.0.0.1 (наш стенд) и на боевом https контекст
   * защищённый — его и воспроизводим.
   */
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  /*
   * jsdom не знает ни Service Worker, ни Push API, и без них раздел
   * честно отвечал бы «этот браузер не умеет фоновую доставку» —
   * то есть проверялось бы поведение jsdom, а не страницы.
   */
  Object.defineProperty(window, 'PushManager', { value: class {}, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      register: vi.fn(),
      getRegistration: vi.fn(async () => undefined),
      ready: Promise.resolve({}),
    },
    configurable: true,
  });
  vi.spyOn(notificationsApi, 'getState').mockResolvedValue(pushState());
  vi.spyOn(notificationsApi, 'savePrefs').mockImplementation(async (patch) =>
    prefs(patch as Partial<NotificationPrefs>),
  );
  vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(generalSettings());
  vi.spyOn(settingsApi, 'saveGeneral').mockImplementation(async (s) => s);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe('разрешение браузера', () => {
  it('НЕ спрашивается при открытии страницы', async () => {
    const { requestPermission } = stubNotification('default');
    render();
    await waitFor(() => text().includes('Показывать уведомления'), 'загрузку страницы');

    // Браузеры наказывают за запрос без действия человека: Chrome прячет
    // его в иконку адресной строки, Firefox гасит совсем.
    expect(requestPermission).not.toHaveBeenCalled();
    expect(text()).toContain('Разрешение у браузера ещё не спрошено');
  });

  it('спрашивается ровно один раз — по нажатию переключателя', async () => {
    const { requestPermission } = stubNotification('default', 'granted');
    render();
    await waitFor(() => text().includes('Показывать уведомления'), 'загрузку страницы');

    click(switchByLabel('Показывать уведомления о новых письмах'));
    await waitFor(() => requestPermission.mock.calls.length === 1, 'запрос разрешения');

    // И только после разрешения настройка уходит на сервер
    await waitFor(
      () => (settingsApi.saveGeneral as ReturnType<typeof vi.fn>).mock.calls.length === 1,
      'сохранение настройки',
    );
    const saved = (settingsApi.saveGeneral as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as GeneralSettings;
    expect(saved.notifications.browser).toBe(true);
  });

  it('отказ не включает настройку и объясняет, что делать', async () => {
    stubNotification('default', 'denied');
    render();
    await waitFor(() => text().includes('Показывать уведомления'), 'загрузку страницы');

    click(switchByLabel('Показывать уведомления о новых письмах'));
    await waitFor(() => text().includes('Браузер заблокировал'), 'сообщение об отказе');

    // Настройку не включаем: она означала бы «работает», а оно не работает
    expect(settingsApi.saveGeneral).not.toHaveBeenCalled();
  });

  it('заблокированное разрешение даёт пошаговую инструкцию, а не молчание', async () => {
    stubNotification('denied');
    render();
    await waitFor(() => text().includes('заблокировал уведомления'), 'сообщение о блокировке');

    const shown = text();
    expect(shown).toContain('разрешение ещё раз почта не может');
    // Инструкция именно для этого браузера
    expect(shown).toContain('Уведомления');
    expect(host.querySelectorAll('ol li').length).toBeGreaterThanOrEqual(2);
  });
});

describe('подробность уведомления', () => {
  beforeEach(() => {
    stubNotification('granted');
    vi.mocked(settingsApi.getGeneral).mockResolvedValue(
      generalSettings({ notifications: { browser: true, tabCounter: true } }),
    );
  });

  it('показывает все четыре уровня с примером окна', async () => {
    render();
    await waitFor(() => text().includes('Что показывать в уведомлении'), 'раздел подробности');

    const shown = text();
    expect(shown).toContain('Только факт: пришло письмо');
    expect(shown).toContain('Отправитель и тема');
    expect(shown).toContain('Отправитель, тема и первые фразы');
    expect(shown).toContain('Отправитель, тема и сводка от ИИ');
    // Пример важнее описания: решение принимается по виду окна
    expect(shown).toContain('Пётр Смирнов');
    expect(shown).toContain('Откройте почту, чтобы прочитать');
  });

  it('уровень с первыми фразами честно предупреждает о цене', async () => {
    render();
    await waitFor(() => text().includes('Что показывать в уведомлении'), 'раздел подробности');
    expect(text()).toContain('прочтёт всякий, кто посмотрит на экран');
  });

  it('уровень со сводкой ИИ предупреждает о расходе средств', async () => {
    render();
    await waitFor(() => text().includes('Что показывать в уведомлении'), 'раздел подробности');
    expect(text()).toContain('расходует средства помощника');
    expect(text()).toContain('первые фразы письма');
  });

  it('выбор уровня уходит на сервер', async () => {
    render();
    await waitFor(() => text().includes('Что показывать в уведомлении'), 'раздел подробности');

    click(radioByLabel('Отправитель, тема и первые фразы'));
    await waitFor(
      () => (notificationsApi.savePrefs as ReturnType<typeof vi.fn>).mock.calls.length === 1,
      'сохранение уровня',
    );
    expect((notificationsApi.savePrefs as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      level: 'preview',
    });
  });

  it('недоступный уровень ИИ не прячется, а объясняет причину', async () => {
    vi.mocked(notificationsApi.getState).mockResolvedValue(
      pushState({
        ai: {
          available: false,
          reason: 'Помощник на основе ИИ выключен администратором домена',
        },
      }),
    );
    render();
    await waitFor(() => text().includes('Что показывать в уведомлении'), 'раздел подробности');

    // Пункт на месте — иначе человек решил бы, что такой возможности нет
    expect(text()).toContain('Отправитель, тема и сводка от ИИ');
    expect(text()).toContain('выключен администратором домена');
    expect(radioByLabel('Отправитель, тема и сводка от ИИ').disabled).toBe(true);

    // Обратный ход: помощник разрешён — пункт выбирается
    vi.mocked(notificationsApi.getState).mockResolvedValue(pushState());
  });

  it('при разрешённом помощнике уровень ИИ доступен', async () => {
    render();
    await waitFor(() => text().includes('Что показывать в уведомлении'), 'раздел подробности');
    expect(radioByLabel('Отправитель, тема и сводка от ИИ').disabled).toBe(false);
    expect(text()).not.toContain('Недоступно:');
  });
});

describe('доставка при закрытой вкладке', () => {
  beforeEach(() => {
    stubNotification('granted');
    vi.mocked(settingsApi.getGeneral).mockResolvedValue(
      generalSettings({ notifications: { browser: true, tabCounter: true } }),
    );
  });

  it('содержимое в push выключено по умолчанию и объясняет обе стороны сделки', async () => {
    vi.mocked(notificationsApi.getState).mockResolvedValue(
      pushState({ prefs: prefs({ push: true }) }),
    );
    render();
    await waitFor(() => text().includes('Класть содержимое'), 'настройку содержимого в push');

    expect(switchByLabel('Класть содержимое письма в само push-сообщение').checked).toBe(false);
    const shown = text();
    // Что защищено — говорим честно, не пугая сверх меры
    expect(shown).toContain('зашифровано');
    expect(shown).toContain('прочитать его не может');
    // Чем платят — тоже честно
    expect(shown).toContain('остаётся у неё');
    expect(shown).toContain('снимком прошлого');
    // И зачем это всё-таки может понадобиться
    expect(shown).toContain('недоступен с устройства');
  });

  it('выключенный на сервере push объясняет причину и не даёт себя включить', async () => {
    vi.mocked(notificationsApi.getState).mockResolvedValue(
      pushState({
        pushAvailable: false,
        pushUnavailableReason:
          'Уведомления при закрытой вкладке выключены на сервере (PUSH_ENABLED=false)',
        prefs: prefs({ push: true }),
      }),
    );
    render();
    await waitFor(() => text().includes('PUSH_ENABLED=false'), 'причину недоступности');
    expect(switchByLabel('Присылать уведомления при закрытой вкладке').disabled).toBe(true);
  });

  it('список устройств называет браузер и помечает текущий', async () => {
    vi.mocked(notificationsApi.getState).mockResolvedValue(
      pushState({
        prefs: prefs({ push: true }),
        devices: [
          {
            id: 1,
            browser: 'Chrome',
            createdAt: '2026-08-06T10:00:00.000Z',
            lastSeenAt: '2026-08-06T10:00:00.000Z',
            current: true,
            lastError: null,
          },
        ],
      }),
    );
    render();
    await waitFor(() => text().includes('Где включены уведомления'), 'список устройств');
    expect(text()).toContain('Chrome');
    expect(text()).toContain('этот браузер');
  });
});

describe('тихие часы', () => {
  it('минуты и время переводятся друг в друга без потерь', () => {
    expect(minutesToTime(1380)).toBe('23:00');
    expect(minutesToTime(420)).toBe('07:00');
    expect(minutesToTime(0)).toBe('00:00');
    expect(timeToMinutes('23:00', 0)).toBe(1380);
    expect(timeToMinutes('07:05', 0)).toBe(425);
    // Мусор не превращается в полночь: он оставляет прежнее значение
    expect(timeToMinutes('', 1380)).toBe(1380);
    expect(timeToMinutes('25:00', 1380)).toBe(1380);
    expect(timeToMinutes('12:99', 1380)).toBe(1380);
  });

  it('неизвестный часовой пояс называется прямо', async () => {
    stubNotification('granted');
    vi.mocked(settingsApi.getGeneral).mockResolvedValue(
      generalSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    vi.mocked(notificationsApi.getState).mockResolvedValue(
      pushState({
        prefs: prefs({
          quietHours: { enabled: true, fromMinutes: 1380, toMinutes: 420 },
          timeZone: null,
        }),
      }),
    );
    render();
    await waitFor(() => text().includes('Тихие часы'), 'раздел тихих часов');

    // Молча промолчать не в те часы хуже, чем лишний раз пикнуть
    expect(text()).toContain('пояс браузера определить не удалось');
    expect(text()).toContain('тихие часы пока не действуют');
  });

  it('накопленные уведомления не всплывают все разом — и об этом сказано', async () => {
    stubNotification('granted');
    vi.mocked(settingsApi.getGeneral).mockResolvedValue(
      generalSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    vi.mocked(notificationsApi.getState).mockResolvedValue(
      pushState({
        prefs: prefs({ quietHours: { enabled: true, fromMinutes: 1380, toMinutes: 420 } }),
      }),
    );
    render();
    await waitFor(() => text().includes('Тихие часы'), 'раздел тихих часов');
    expect(text()).toContain('потом не всплывают все разом');
  });
});

describe('о чём не уведомлять', () => {
  it('спам и свои письма заявлены как безусловное поведение, без настройки', async () => {
    stubNotification('granted');
    vi.mocked(settingsApi.getGeneral).mockResolvedValue(
      generalSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    render();
    await waitFor(() => text().includes('О чём не уведомлять'), 'раздел исключений');

    const shown = text();
    expect(shown).toContain('Спам');
    expect(shown).toContain('собственные отправленные');
    expect(shown).toContain('не уведомляют никогда');
    // Настройка есть только у того, что действительно спорно
    expect(shown).toContain('пометил прочитанными');
  });
});
