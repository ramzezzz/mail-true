/**
 * Тема помнится за УЧЁТНОЙ ЗАПИСЬЮ, а не за браузером.
 *
 * Главный случай, ради которого всё делалось: за одним компьютером
 * работают два администратора. Вошёл второй — обязан увидеть СВОЮ
 * расцветку, а не ту, что оставил первый.
 *
 * На прежнем коде падает почти всё: выбор лежал в localStorage под
 * ключом mt-admin-theme голой строкой, ничьей и общей. Ни серверного
 * поля, ни adoptServerTheme, ни forgetAdminTheme не существовало —
 * сел за другую машину, и тема сбрасывалась; вошёл вторым за той же —
 * получал чужую.
 *
 * @vitest-environment jsdom
 */

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ADMIN_THEME,
  adoptServerTheme,
  forgetAdminTheme,
  getAdminThemeSetting,
  initAdminTheme,
  readAdminThemeSetting,
  setAdminTheme,
  setAdminThemeSaver,
} from '../src/appearance/themeStore';

const KEY = 'mt-admin-theme';

/** Что панель отправила на сервер: по порядку, как отправляла. */
let saved: (string | null)[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeKind;
  saved = [];
  setAdminThemeSaver(async (theme) => {
    saved.push(theme);
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // Каждый тест начинается с чистого листа, как новая загрузка страницы
  forgetAdminTheme();
});

afterEach(() => {
  setAdminThemeSaver(null);
  vi.unstubAllGlobals();
});

/** Тема, которая сейчас на экране. */
const onScreen = (): string | undefined => document.documentElement.dataset.theme;

describe('выбор уезжает на сервер, а не только в браузер', () => {
  it('смена темы отправляется серверу', () => {
    adoptServerTheme('petrov', null);
    saved = [];
    setAdminTheme('coral');
    expect(saved).toEqual(['coral']);
  });

  it('выбор «как в системе» тоже уезжает — это тоже выбор человека', () => {
    adoptServerTheme('petrov', null);
    saved = [];
    setAdminTheme('system');
    expect(saved).toEqual(['system']);
  });

  it('сервер не ответил — на экране всё равно новая тема и ни одной ошибки', async () => {
    setAdminThemeSaver(async () => {
      throw new Error('сеть недоступна');
    });
    adoptServerTheme('petrov', 'light');
    expect(() => setAdminTheme('violet')).not.toThrow();
    expect(onScreen()).toBe('violet');
    // Отказ обещания не должен всплыть необработанным
    await Promise.resolve();
  });

  it('серверная тема применяется, когда приходит ответ о сессии', () => {
    initAdminTheme();
    expect(onScreen()).toBe('graphite'); // кэш пуст — умолчание
    adoptServerTheme('petrov', 'lagoon');
    expect(onScreen()).toBe('lagoon');
    expect(getAdminThemeSetting()).toBe('lagoon');
  });
});

describe('за одним компьютером — два администратора', () => {
  it('второй администратор видит СВОЮ тему, а не тему первого', () => {
    // Первый вошёл и выбрал коралл
    adoptServerTheme('petrov', null);
    setAdminTheme('coral');
    expect(onScreen()).toBe('coral');

    // Он вышел, за компьютер сел второй: браузер тот же, страница
    // загрузилась заново
    forgetAdminTheme();
    initAdminTheme();
    // Сервер отвечает: у этого администратора закат
    adoptServerTheme('sidorov', 'sunset');

    expect(onScreen()).toBe('sunset');
    expect(getAdminThemeSetting()).toBe('sunset');
  });

  it('чужой кэш не подменяет серверный ответ даже без выхода', () => {
    // Кэш остался от первого (браузер закрыли, не выходя из панели)
    adoptServerTheme('petrov', 'coral');
    initAdminTheme();
    expect(onScreen()).toBe('coral'); // до ответа сервера — по кэшу

    // А вошёл второй, и у него на сервере ничего не выбрано
    adoptServerTheme('sidorov', null);
    expect(onScreen()).toBe(DEFAULT_ADMIN_THEME);
  });

  it('у второго нет выбора — он получает умолчание, а не расцветку первого', () => {
    adoptServerTheme('petrov', 'violet');
    forgetAdminTheme();
    adoptServerTheme('sidorov', null);
    expect(onScreen()).toBe('graphite');
  });

  it('свой же кэш переживает обрыв связи с сервером', () => {
    // Тот же администратор, выбор был сделан здесь же, но до сервера
    // не доехал: кэш — единственное, что о нём знает
    adoptServerTheme('petrov', null);
    setAdminTheme('emerald');
    initAdminTheme();
    expect(onScreen()).toBe('emerald');

    saved = [];
    adoptServerTheme('petrov', null);
    expect(onScreen()).toBe('emerald');
    // И панель досылает выбор серверу — иначе на другой машине его не будет
    expect(saved).toEqual(['emerald']);
  });
});

describe('выход из панели', () => {
  it('стирает кэш и возвращает экран к умолчанию', () => {
    adoptServerTheme('petrov', 'sunset');
    expect(onScreen()).toBe('sunset');

    forgetAdminTheme();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(onScreen()).toBe('graphite');
    expect(getAdminThemeSetting()).toBe(DEFAULT_ADMIN_THEME);
  });

  it('после выхода следующая загрузка начинается с умолчания', () => {
    adoptServerTheme('petrov', 'coral');
    forgetAdminTheme();
    expect(initAdminTheme()).toBe('graphite');
  });
});

describe('сервер молчит или поле пустое', () => {
  it('пустое поле у администратора без кэша — тема по умолчанию', () => {
    expect(adoptServerTheme('petrov', null)).toBe('graphite');
  });

  it('незнакомое имя темы из базы не роняет панель', () => {
    // В базе нет проверки на список тем: имя разбирает интерфейс
    expect(adoptServerTheme('petrov', 'мандариновая')).toBe('graphite');
    expect(adoptServerTheme('petrov', '')).toBe('graphite');
  });

  it('панель работает и без хранилища браузера', () => {
    // Приватный режим запрещает localStorage — падать нельзя
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('доступ запрещён');
      },
    });
    try {
      expect(() => setAdminTheme('violet')).not.toThrow();
      expect(onScreen()).toBe('violet');
      expect(() => forgetAdminTheme()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Проводка: сеанс панели применяет тему сам, без ручного вызова        */
/* ------------------------------------------------------------------ */

/** Ответ сервера о сессии — подменяется в каждом тесте. */
const fakeSession = vi.hoisted(() => ({
  value: {
    authenticated: true as const,
    login: 'petrov',
    displayName: null,
    role: 'owner',
    roleLabel: 'Полный доступ',
    permissions: [],
    masterAccess: false,
    theme: null as string | null,
  },
  logoutCalls: 0,
}));

vi.mock('../src/api/client', () => ({
  api: {
    session: async () => fakeSession.value,
    logout: async () => {
      fakeSession.logoutCalls += 1;
      return { ok: true };
    },
    saveTheme: async () => ({ ok: true, theme: null }),
  },
  ApiError: class ApiError extends Error {
    isUnauthorized = false;
  },
}));

describe('сеанс панели красит экран сам', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let logout: (() => Promise<void>) | null = null;

  /** Поднять SessionProvider — как при загрузке панели. */
  async function mount(login: string, theme: string | null): Promise<void> {
    fakeSession.value = { ...fakeSession.value, login, theme };
    const { SessionProvider, useSession } = await import('../src/app/session');
    function Probe(): null {
      const session = useSession();
      useEffect(() => {
        logout = session.logout;
      }, [session.logout]);
      return null;
    }
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container!);
      root.render(createElement(SessionProvider, null, createElement(Probe)));
    });
  }

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    logout = null;
  });

  it('тема из ответа о сессии оказывается на экране без ручных вызовов', async () => {
    await mount('petrov', 'sunset');
    // SessionProvider обязан применить её сам — иначе панель осталась бы
    // на том, что лежит в кэше браузера
    expect(onScreen()).toBe('sunset');
  });

  it('вошёл другой администратор — экран берёт ЕГО тему, а не кэш предыдущего', async () => {
    // Кэш остался от первого
    adoptServerTheme('petrov', 'coral');
    await mount('sidorov', 'lagoon');
    expect(onScreen()).toBe('lagoon');
  });

  it('у вошедшего нет выбора — умолчание, а не расцветка предыдущего', async () => {
    adoptServerTheme('petrov', 'coral');
    await mount('sidorov', null);
    expect(onScreen()).toBe('graphite');
  });

  it('выход стирает кэш: следующему достанется умолчание, а не чужой цвет', async () => {
    await mount('petrov', 'violet');
    setAdminTheme('coral');
    expect(onScreen()).toBe('coral');
    await act(async () => {
      await logout?.();
    });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(onScreen()).toBe('graphite');
  });
});

describe('кэш', () => {
  it('помнит, чей это выбор, — иначе чужой не отличить от своего', () => {
    adoptServerTheme('petrov', 'lagoon');
    const raw = localStorage.getItem(KEY);
    expect(raw).toContain('petrov');
    expect(raw).toContain('lagoon');
  });

  it('старая запись (голое имя темы) не пропадает при обновлении панели', () => {
    // У людей панель уже стоит, и их выбор лежит строкой без владельца
    localStorage.setItem(KEY, 'violet');
    expect(readAdminThemeSetting()).toBe('violet');
    expect(initAdminTheme()).toBe('violet');
    // Но ничей кэш против сервера не играет
    expect(adoptServerTheme('petrov', 'coral')).toBe('coral');
  });

  it('испорченная запись не ломает панель', () => {
    localStorage.setItem(KEY, '{это не json');
    expect(readAdminThemeSetting()).toBe(DEFAULT_ADMIN_THEME);
    localStorage.setItem(KEY, '{"login":"petrov","setting":"мандариновая"}');
    expect(readAdminThemeSetting()).toBe(DEFAULT_ADMIN_THEME);
  });
});
