// @vitest-environment jsdom
/**
 * Оформление раздела настроек — сверка с эталонные снимки интерфейса
 *
 * Было:
 *   - на `/settings/` ни один пункт левого меню не подсвечен: в меню стоит
 *     `/settings`, ссылка из почты ведёт на `/settings/`, и точное сравнение
 *     их не отождествляло;
 *   - подложка активного пункта (--mt-settings-nav-active-bg) была РОВНО
 *     того же цвета, что и фон страницы настроек, — даже сработай подсветка,
 *     видно бы её не было;
 *   - карточки главной лежали внутри одного большого белого контейнера и
 *     различались только рамкой 1px. в привычных почтовых интерфейсах это отдельные белые карточки
 *     без рамок на сером фоне (пипетка: фон #F6F7F8, карточки #FFFFFF,
 *     активная пилюля меню rgb(227,229,234)).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../src/api';
import { labelsApi } from '../src/mail/labelsApi';
import { SettingsLayout, isNavItemActive, normalizePath } from '../src/settings/SettingsLayout';
import { SettingsHomePage } from '../src/pages/settings/SettingsHomePage';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const themesCss = readFileSync(join(SRC, 'styles/themes.css'), 'utf8');
const homeCss = readFileSync(join(SRC, 'pages/settings/SettingsHomePage.module.css'), 'utf8');
const layoutCss = readFileSync(join(SRC, 'settings/SettingsLayout.module.css'), 'utf8');

describe('сравнение адресов в меню настроек', () => {
  it('хвостовая косая ничего не значит', () => {
    expect(normalizePath('/settings/')).toBe('/settings');
    expect(normalizePath('/settings')).toBe('/settings');
    expect(normalizePath('/')).toBe('/');
  });

  it('«Главная» активна и на /settings, и на /settings/', () => {
    const home = { to: '/settings', title: 'Главная', end: true };
    expect(isNavItemActive('/settings', home)).toBe(true);
    expect(isNavItemActive('/settings/', home)).toBe(true);
    // …но не на вложенном разделе — там свой пункт
    expect(isNavItemActive('/settings/general', home)).toBe(false);
  });

  it('раздел активен и на своём адресе, и на вложенном', () => {
    const filters = { to: '/settings/filters', title: 'Фильтры' };
    expect(isNavItemActive('/settings/filters', filters)).toBe(true);
    expect(isNavItemActive('/settings/filters/', filters)).toBe(true);
    expect(isNavItemActive('/settings/folders', filters)).toBe(false);
  });
});

let host: HTMLDivElement;
let root: Root;

function render(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<SettingsHomePage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Дать react-query разрешить запросы: одного тика ему не хватает. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // Помощника администратор не разрешал — его пункта в меню нет
  vi.spyOn(api, 'getAiState').mockResolvedValue({
    available: false,
    consent: false,
    features: [],
  } as never);
  // Справочник меток по умолчанию есть — пункт «Метки» в меню ожидается
  vi.spyOn(labelsApi, 'getLabels').mockResolvedValue({
    available: true,
    reason: null,
    items: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('левое меню настроек', () => {
  for (const path of ['/settings', '/settings/']) {
    it(`на ${path} подсвечен пункт «Главная»`, () => {
      render(path);
      const active = [...host.querySelectorAll('nav a')].filter(
        (a) => a.getAttribute('aria-current') === 'page',
      );
      expect(active.map((a) => a.textContent)).toEqual(['Главная']);
      // Подсветка — не только для скринридера: у пункта есть свой класс
      expect(active[0]!.className).toMatch(/navItemActive/u);
    });
  }

  /*
   * Правило записано там же, где хук меток: «пока сервер не сказал
   * available, ни раздела настроек, ни пункта „Метки“ в меню не
   * появляется». Оно не выполнялось — пункт стоял в меню всегда и на
   * сервере без применённой миграции вёл на страницу, которая умеет
   * сказать только «метки недоступны».
   */
  it('пункт «Метки» есть, пока справочник доступен', async () => {
    render('/settings');
    await settle();
    const titles = [...host.querySelectorAll('nav a')].map((a) => a.textContent);
    expect(titles).toContain('Метки');
    // и стоит сразу за «Папками», а не в конце списка
    expect(titles.indexOf('Метки')).toBe(titles.indexOf('Папки') + 1);
  });

  it('справочника нет — пункта в меню тоже нет', async () => {
    vi.spyOn(labelsApi, 'getLabels').mockResolvedValue({
      available: false,
      reason: 'Справочник меток недоступен',
      items: [],
    });
    render('/settings');
    await settle();
    const titles = [...host.querySelectorAll('nav a')].map((a) => a.textContent);
    expect(titles).not.toContain('Метки');
    // остальные разделы на месте — убрали один пункт, а не меню целиком
    expect(titles).toContain('Папки');
  });

  it('серая пилюля активного пункта отличается от фона страницы', () => {
    // Раньше обе переменные были --mt-color-background-secondary
    const nav = themesCss.match(/--mt-settings-nav-active-bg:\s*([^;]+);/u)?.[1]?.trim();
    const bg = themesCss.match(/--mt-settings-bg:\s*([^;]+);/u)?.[1]?.trim();
    expect(nav).toBeTruthy();
    expect(nav).not.toBe(bg);
  });
});

describe('карточки главной страницы настроек', () => {
  it('на главной под плиткой нет общей белой подложки', () => {
    render('/settings/');
    const main = host.querySelector('main')!;
    expect(main.className, 'у main нет класса «без подложки»').toMatch(/cardPlain/u);
    expect(layoutCss).toMatch(/\.cardPlain\s*\{[^}]*background:\s*transparent/u);
  });

  it('у карточек нет рамки — они отличаются от фона своей белизной', () => {
    const card = homeCss.slice(homeCss.indexOf('\n.card {'), homeCss.indexOf('\n.cardTitle'));
    expect(card).toMatch(/border:\s*none/u);
    expect(card).not.toMatch(/border:\s*1px solid/u);
  });
});
