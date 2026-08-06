// @vitest-environment jsdom
/**
 * Оформление запоминается ЗА ПОЛЬЗОВАТЕЛЕМ, а не за браузером.
 *
 * Требование заказчика дословно: «тема оформления должна запоминаться для
 * каждого юзера». До этой правки тема лежала только в localStorage, и
 * ломалось это двумя способами сразу: за другим компьютером тема
 * сбрасывалась, а на общем компьютере вошедший вторым видел оформление
 * первого. Оба случая проверяются здесь, а не только «значение сохранилось».
 *
 * На старом коде падает всё: модуля sync.ts не существовало, тема никуда
 * не отправлялась и ниоткуда не приезжала.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_SETTINGS } from '@mail-true/shared';
import { THEME_IDS } from '../src/appearance/themes';
import { WALLPAPER_PRESETS } from '../src/appearance/wallpapers';
import { useUiStore } from '../src/app/store';
import { forgetAppearance, syncAppearance } from '../src/appearance/sync';

/*
 * Заглушки здесь выключены явно: проверка подделывает fetch и смотрит,
 * что уходит на сервер. На заглушечных данных этот путь не работает
 * вовсе — и правильно, ходить там некуда, — но проверять надо именно его.
 */
vi.mock('../src/api/mockFlag', () => ({ useMocks: false }));


/** Запросы к /api/settings/appearance, перехваченные подделкой fetch. */
interface Call {
  method: string;
  body: unknown;
}

let calls: Call[];
/** Что отвечать на GET; null — сервер недоступен. */
let remote: { email: string; theme: string; wallpaper: string } | null;

beforeEach(() => {
  calls = [];
  remote = null;
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--mt-user-wallpaper');
  useUiStore.setState({ themeSetting: 'system', theme: 'light' });

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url) !== '/api/settings/appearance') throw new Error(`лишний запрос: ${url}`);
    if (method === 'PUT') {
      return Promise.resolve(
        new Response(JSON.stringify(remote ?? {}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (remote === null) return Promise.reject(new TypeError('сеть недоступна'));
    return Promise.resolve(
      new Response(JSON.stringify(remote), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const theme = (): string | undefined => document.documentElement.dataset['theme'];
const wallpaperCss = (): string =>
  document.documentElement.style.getPropertyValue('--mt-user-wallpaper');

describe('тема приезжает с сервера', () => {
  it('чистый браузер: применяется тема учётной записи, а не умолчание', async () => {
    remote = { email: 'test@mail.local', theme: 'emerald', wallpaper: '' };
    await syncAppearance('test@mail.local');
    expect(theme()).toBe('emerald');
    expect(useUiStore.getState().themeSetting).toBe('emerald');
    // и попадает в кэш — чтобы следующая загрузка не мигала
    expect(localStorage.getItem('mt-theme')).toBe('emerald');
    expect(localStorage.getItem('mt-appearance-account')).toBe('test@mail.local');
  });

  it('выбор фона тоже приезжает и применяется', async () => {
    const preset = WALLPAPER_PRESETS[3]!;
    remote = { email: 'test@mail.local', theme: 'wallpaper', wallpaper: `preset:${preset.id}` };
    await syncAppearance('test@mail.local');
    expect(theme()).toBe('wallpaper');
    expect(wallpaperCss()).toBe(preset.css);
    expect(localStorage.getItem('mt-wallpaper')).toBe(`preset:${preset.id}`);
  });

  it('ответ от прошлой сессии не применяется', async () => {
    // Между запросом и ответом человек успел войти другим ящиком
    remote = { email: 'кто-то@mail.local', theme: 'coral', wallpaper: '' };
    await syncAppearance('test@mail.local');
    expect(theme()).not.toBe('coral');
  });
});

describe('смена пользователя на том же компьютере', () => {
  it('вошедший вторым видит СВОЮ тему, а не тему предыдущего', async () => {
    remote = { email: 'test@mail.local', theme: 'dark', wallpaper: '' };
    await syncAppearance('test@mail.local');
    expect(theme()).toBe('dark');

    // теперь тем же браузером входит другой человек
    remote = { email: 'demo@mail.local', theme: 'coral', wallpaper: '' };
    await syncAppearance('demo@mail.local');
    expect(theme()).toBe('coral');
    expect(localStorage.getItem('mt-theme')).toBe('coral');
    expect(localStorage.getItem('mt-appearance-account')).toBe('demo@mail.local');
  });

  it('чужой кэш стирается ДО ответа сервера, а не после', async () => {
    remote = { email: 'test@mail.local', theme: 'dark', wallpaper: 'preset:forest' };
    await syncAppearance('test@mail.local');
    expect(theme()).toBe('dark');

    // сервер молчит — но чужая тёмная тема всё равно не должна остаться
    remote = null;
    await syncAppearance('demo@mail.local');
    expect(theme()).toBe('light');
    expect(useUiStore.getState().themeSetting).toBe('system');
    expect(localStorage.getItem('mt-theme')).toBeNull();
    expect(wallpaperCss()).toBe(WALLPAPER_PRESETS[0]!.css);
  });

  it('свой кэш при повторном входе не трогается', async () => {
    remote = { email: 'test@mail.local', theme: 'violet', wallpaper: '' };
    await syncAppearance('test@mail.local');
    // регистр адреса не должен превращать свой кэш в чужой
    await syncAppearance('Test@Mail.Local');
    expect(theme()).toBe('violet');
    expect(localStorage.getItem('mt-theme')).toBe('violet');
  });
});

describe('выход', () => {
  it('не оставляет тему следующему', async () => {
    remote = { email: 'test@mail.local', theme: 'dark', wallpaper: 'preset:plum' };
    await syncAppearance('test@mail.local');
    expect(theme()).toBe('dark');

    forgetAppearance();
    expect(theme()).toBe('light');
    expect(localStorage.getItem('mt-theme')).toBeNull();
    expect(localStorage.getItem('mt-wallpaper')).toBeNull();
    expect(localStorage.getItem('mt-appearance-account')).toBeNull();
    expect(wallpaperCss()).toBe(WALLPAPER_PRESETS[0]!.css);
  });
});

describe('сервер недоступен', () => {
  it('чистый браузер: тема по умолчанию и ни одной ошибки', async () => {
    remote = null;
    await expect(syncAppearance('test@mail.local')).resolves.toBeUndefined();
    expect(theme()).toBeUndefined();
    expect(useUiStore.getState().themeSetting).toBe('system');
  });

  it('свой кэш переживает недоступность сервера', async () => {
    remote = { email: 'test@mail.local', theme: 'lagoon', wallpaper: '' };
    await syncAppearance('test@mail.local');
    remote = null;
    await syncAppearance('test@mail.local');
    expect(theme()).toBe('lagoon');
  });
});

describe('выбор уходит на сервер', () => {
  it('смена темы отправляется за учётную запись', () => {
    useUiStore.getState().setTheme('sunset');
    const put = calls.filter((c) => c.method === 'PUT');
    expect(put).toHaveLength(1);
    expect(put[0]!.body).toEqual({ theme: 'sunset' });
  });

  it('ответ сервера обратно на сервер не уезжает', async () => {
    remote = { email: 'test@mail.local', theme: 'emerald', wallpaper: 'preset:grid' };
    await syncAppearance('test@mail.local');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('выбор фона отправляется отдельным полем, тему не затирая', async () => {
    const preset = WALLPAPER_PRESETS[2]!;
    const { setWallpaperPreset } = await import('../src/appearance/wallpapers');
    await setWallpaperPreset(preset.id);
    const put = calls.filter((c) => c.method === 'PUT');
    expect(put).toHaveLength(1);
    expect(put[0]!.body).toEqual({ wallpaper: `preset:${preset.id}` });
  });

  it('своей картинки нет на этом устройстве — запасной фон на сервер не пишется', async () => {
    // IndexedDB в jsdom нет: ровно тот случай, что и вход с другого
    // компьютера, где картинка не сохранена
    remote = { email: 'test@mail.local', theme: 'wallpaper', wallpaper: 'custom' };
    await syncAppearance('test@mail.local');
    expect(theme()).toBe('wallpaper');
    expect(wallpaperCss()).toBe(WALLPAPER_PRESETS[0]!.css);
    // выбор на сервере остаётся «своя картинка» — на своём компьютере
    // она никуда не делась
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(localStorage.getItem('mt-wallpaper')).toBe('custom');
  });
});

describe('список тем не расходится с сервером', () => {
  it('общий контракт перечисляет ровно те же темы, что реестр интерфейса', () => {
    expect([...THEME_SETTINGS]).toEqual(['system', ...THEME_IDS]);
  });
});
