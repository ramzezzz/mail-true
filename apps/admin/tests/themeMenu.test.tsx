/**
 * Смена оформления: переключатель в шапке, память между сеансами.
 *
 * Здесь нужен настоящий DOM: тема ставится признаком на <html>, выбор
 * пишется в localStorage, а меню живёт на обработчиках щелчка и Escape.
 *
 * На прежнем коде падает всё: тем в панели не было, шапка знала только
 * логотип, имя администратора и «Выйти».
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_THEMES, adminThemeMeta } from '../src/appearance/adminThemes';
import {
  DEFAULT_ADMIN_THEME,
  applyAdminTheme,
  getAdminThemeSetting,
  initAdminTheme,
  readAdminThemeSetting,
  resolveAdminTheme,
  setAdminTheme,
  systemAdminTheme,
} from '../src/appearance/themeStore';
import { ThemeMenu } from '../src/app/ThemeMenu';

let container: HTMLDivElement;
let root: Root;

/** Системная тема: по умолчанию светлая, тёмную включаем точечно. */
function stubMatchMedia(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeKind;
  stubMatchMedia(false);
  container = document.createElement('div');
  document.body.append(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(): void {
  act(() => {
    root.render(
      <MemoryRouter>
        <ThemeMenu />
      </MemoryRouter>,
    );
  });
}

/** Кнопка-палитра в шапке. */
function trigger(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Тема оформления"]');
  if (!button) throw new Error('в шапке нет кнопки смены темы');
  return button;
}

function openMenu(): void {
  render();
  act(() => trigger().click());
}

/** Пункт меню по названию темы. */
function option(title: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent?.includes(title),
  );
  if (!found) throw new Error(`в меню нет темы «${title}»`);
  return found;
}

describe('переключатель стоит в шапке, а не закопан в настройки', () => {
  it('это кнопка с доступным именем, а не безымянный значок', () => {
    render();
    expect(trigger().getAttribute('aria-label')).toBe('Тема оформления');
  });

  it('в подсказке видно, какая тема сейчас', () => {
    setAdminTheme('emerald');
    render();
    expect(container.textContent).toContain('Изумруд');
  });

  it('открытое меню показывает все темы разом, а не перебирает по кругу', () => {
    openMenu();
    for (const theme of ADMIN_THEMES) expect(container.textContent).toContain(theme.title);
    // И «как в системе» — девятым пунктом
    expect(container.textContent).toContain('Как в системе');
    expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(
      ADMIN_THEMES.length + 1,
    );
  });

  it('выбранная тема помечена для скринридера, а не только цветом', () => {
    setAdminTheme('coral');
    openMenu();
    expect(option('Коралл').getAttribute('aria-checked')).toBe('true');
    expect(option('Изумруд').getAttribute('aria-checked')).toBe('false');
  });

  it('выбор применяется сразу, а меню остаётся открытым — темы сравнивают', () => {
    openMenu();
    act(() => option('Фиалка').click());
    expect(document.documentElement.dataset.theme).toBe('violet');
    // Меню на месте: иначе каждую тему пришлось бы открывать заново
    expect(container.querySelectorAll('[role="menuitemradio"]').length).toBeGreaterThan(0);
    act(() => option('Графит').click());
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });
});

describe('выбор помнится между сеансами', () => {
  it('запись переживает перезагрузку страницы', () => {
    openMenu();
    act(() => option('Лагуна').click());
    // «Перезагрузка»: состояние в памяти теряется, остаётся только хранилище
    expect(readAdminThemeSetting()).toBe('lagoon');
    expect(initAdminTheme()).toBe('lagoon');
    expect(document.documentElement.dataset.theme).toBe('lagoon');
  });

  it('пока ничего не выбрано, панель встречает фирменным графитом', () => {
    // Заказчик просил для панели особую гамму: открыв её, человек должен
    // видеть, что это не почта
    expect(readAdminThemeSetting()).toBe(DEFAULT_ADMIN_THEME);
    expect(initAdminTheme()).toBe('graphite');
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });

  it('испорченная запись не ломает панель, а откатывается к умолчанию', () => {
    localStorage.setItem('mt-admin-theme', 'мандариновая');
    expect(readAdminThemeSetting()).toBe(DEFAULT_ADMIN_THEME);
  });

  it('почта и панель помнят темы по отдельности', () => {
    // У почты ключ mt-theme: тому, кто держит почту светлой, панель незачем
    // делать светлой заодно
    localStorage.setItem('mt-theme', 'sunset');
    setAdminTheme('graphite');
    expect(localStorage.getItem('mt-theme')).toBe('sunset');
    // В кэше панели лежит её собственная запись — с темой и владельцем
    expect(localStorage.getItem('mt-admin-theme')).toContain('graphite');
    expect(readAdminThemeSetting()).toBe('graphite');
  });
});

describe('«как в системе»', () => {
  it('тёмной системе отвечает графит, а не тёмная тема почты', () => {
    // Иначе фирменная гамма панели терялась бы у всех, кто держит тёмную ОС
    stubMatchMedia(true);
    expect(systemAdminTheme()).toBe('graphite');
    expect(resolveAdminTheme('system')).toBe('graphite');
  });

  it('светлой системе — светлая тема', () => {
    stubMatchMedia(false);
    expect(resolveAdminTheme('system')).toBe('light');
  });

  it('выбор «как в системе» тоже запоминается', () => {
    openMenu();
    act(() => option('Как в системе').click());
    expect(getAdminThemeSetting()).toBe('system');
    expect(readAdminThemeSetting()).toBe('system');
  });
});

describe('признаки на <html>', () => {
  it('рядом с темой ставится её вид — светлая она или тёмная', () => {
    // По нему стили выбирают тёмное начертание логотипа: перечислять тёмные
    // темы поимённо значит забыть про следующую
    for (const theme of ADMIN_THEMES) {
      applyAdminTheme(theme.id);
      expect(document.documentElement.dataset.theme).toBe(theme.id);
      expect(document.documentElement.dataset.themeKind).toBe(
        theme.id === 'light' ? 'light' : theme.kind,
      );
    }
  });

  it('у графита и тёмной вид тёмный, у цветных — светлый', () => {
    expect(adminThemeMeta('graphite').kind).toBe('dark');
    expect(adminThemeMeta('dark').kind).toBe('dark');
    for (const id of ['light', 'emerald', 'violet', 'coral', 'lagoon', 'sunset'] as const) {
      expect(adminThemeMeta(id).kind).toBe('light');
    }
  });
});
