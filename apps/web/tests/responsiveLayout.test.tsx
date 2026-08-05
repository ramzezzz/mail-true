// @vitest-environment jsdom
/**
 * Узкий экран.
 *
 * До этих правок во всём почтовом интерфейсе был ровно один `@media` —
 * в настройках. На 390px левая колонка занимала 232px из 390, строка поиска
 * сжималась до четырёх пикселей, а «Фильтр» на планшете стоял за правым
 * краем экрана. Здесь проверяется и разметка (кнопка вызова колонки и её
 * состояния), и наличие самих правил для узкого экрана: медиазапросы
 * jsdom не вычисляет, поэтому правила читаются из исходников стилей.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Folder } from '@mail-true/shared';
import { api } from '../src/api';
import { SessionProvider } from '../src/app/session';
import { AppLayout } from '../src/layout/AppLayout';
import { NAV_DRAWER_ID } from '../src/layout/Header';

let host: HTMLDivElement;
let root: Root;

const folders: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 3,
    totalCount: 187,
    system: true,
    uidValidity: 1,
  },
];

function stubApi() {
  vi.spyOn(api, 'getSession').mockResolvedValue({
    authenticated: true,
    email: 'demo@mail.local',
  } as Awaited<ReturnType<typeof api.getSession>>);
  vi.spyOn(api, 'getFolders').mockResolvedValue(folders);
  vi.spyOn(api, 'getAccount').mockResolvedValue({
    email: 'demo@mail.local',
    displayName: 'Демо Пользователь',
    avatarUrl: null,
    signature: '',
  } as Awaited<ReturnType<typeof api.getAccount>>);
  vi.spyOn(api, 'getAiState').mockRejectedValue(new Error('помощник выключен'));
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox/']}>
          <SessionProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path=":folderId" element={<div>список писем</div>} />
              </Route>
            </Routes>
          </SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Кнопка-гамбургер: единственная, что управляет ящиком с папками. */
const navButton = (): HTMLButtonElement | null =>
  host.querySelector(`button[aria-controls="${NAV_DRAWER_ID}"]`);

const drawer = (): HTMLElement | null => host.querySelector(`#${NAV_DRAWER_ID}`);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  stubApi();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('вызов колонки папок', () => {
  it('в шапке есть кнопка, и она управляет ящиком с папками', () => {
    render();

    const button = navButton();
    expect(button, 'кнопки вызова папок нет в шапке').not.toBeNull();
    expect(drawer(), 'ящика с папками нет в разметке').not.toBeNull();

    // Название кнопки читаемое: значок сам по себе ничего не говорит
    expect(button!.getAttribute('aria-label')).toBe('Показать папки');
    expect(button!.getAttribute('aria-expanded')).toBe('false');
  });

  it('нажатие открывает и закрывает ящик, помечая состояние в разметке', () => {
    render();

    const closedClass = drawer()!.className;
    act(() => navButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(navButton()!.getAttribute('aria-expanded')).toBe('true');
    expect(navButton()!.getAttribute('aria-label')).toBe('Скрыть папки');
    const openClass = drawer()!.className;
    expect(openClass, 'открытый ящик ничем не отличается от закрытого').not.toBe(closedClass);

    act(() => navButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(navButton()!.getAttribute('aria-expanded')).toBe('false');
    expect(drawer()!.className).toBe(closedClass);
  });

  it('затемнение под ящиком закрывает его нажатием мимо', () => {
    render();
    act(() => navButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const scrim = host.querySelector<HTMLButtonElement>('button[aria-label="Закрыть список папок"]');
    expect(scrim, 'закрыть ящик нажатием мимо нечем').not.toBeNull();

    act(() => scrim!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(navButton()!.getAttribute('aria-expanded')).toBe('false');
  });
});

/* --- Правила для узкого экрана ---------------------------------------- */

/** Исходник стиля из src/. Vitest запускается из apps/web. */
const read = (relative: string): string =>
  readFileSync(resolve(process.cwd(), 'src', relative), 'utf8');

/** Содержимое всех блоков `@media (max-width: N)` с N не больше предела. */
function narrowRules(css: string, upTo: number): string {
  let out = '';
  const media = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let found = media.exec(css);
  while (found) {
    const limit = Number(found[1]);
    // Собираем тело блока по балансу скобок: вложенные правила тоже нужны
    let depth = 1;
    let i = media.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    if (limit <= upTo) out += css.slice(media.lastIndex, i);
    found = media.exec(css);
  }
  return out;
}

describe('правила для узкого экрана', () => {
  it('каркас прячет колонку папок и растягивает контент', () => {
    const css = narrowRules(read('layout/AppLayout.module.css'), 1024);
    expect(css).toMatch(/\.aside\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.aside\s*\{[^}]*visibility:\s*hidden/);
    expect(css).toMatch(/\.asideOpen/);
    // Скруглённый угол карточки контента при её полной ширине не нужен
    expect(css).toMatch(/\.content\s*\{[^}]*border-radius:\s*0/);
  });

  it('кнопка вызова папок скрыта по умолчанию и показывается на узком экране', () => {
    const css = read('layout/Header.module.css');
    expect(css).toMatch(/\.menuButton\s*\{[^}]*display:\s*none/);
    expect(narrowRules(css, 1024)).toMatch(/\.menuButton\s*\{[^}]*display:\s*inline-flex/);
    // На телефоне логотип уступает место строке поиска
    expect(narrowRules(css, 480)).toMatch(/\.logoZone\s*\{[^}]*display:\s*none/);
  });

  it('панели над списком и над письмом переносят кнопки, а не прячут их за краем', () => {
    for (const file of ['mail/ListToolbar.module.css', 'pages/MessagePage.module.css']) {
      const css = read(file);
      // Перенос разрешён на любой ширине: полный набор кнопок письма не
      // помещался уже на 1100px, а обрезал их `overflow: hidden` контента
      expect(css, file).toMatch(/\.toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
      // Жёсткая высота 48px не дала бы второй строке места
      expect(css, file).not.toMatch(/\.toolbar\s*\{[^}]*[^-]height:\s*48px/);
      expect(css, file).toMatch(/\.toolbar\s*\{[^}]*min-height:\s*48px/);
      // Распорка при переносе одна заняла бы всю первую строку
      expect(narrowRules(css, 1024), file).toMatch(/\.spacer\s*\{[^}]*display:\s*none/);
    }
  });

  it('подписи кнопок на телефоне уводятся с глаз, а не удаляются', () => {
    for (const file of ['mail/ListToolbar.module.css', 'pages/MessagePage.module.css']) {
      const css = narrowRules(read(file), 600);
      // display: none забрал бы у кнопки название для чтения с экрана
      expect(css, file).toMatch(/clip-path:\s*inset\(50%\)/);
      expect(css, file).not.toMatch(/span\s*\+\s*span\s*\{[^}]*display:\s*none/);
    }
  });

  it('окно написания разворачивается на весь экран, а его подвал переносится', () => {
    const css = read('compose/ComposeWindow.module.css');
    expect(narrowRules(css, 1024)).toMatch(/\.footer\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(narrowRules(css, 640)).toMatch(/\.window\s*\{[^}]*inset:\s*0/);
    // Каскад окон задаётся переменной: встроенный `right` перебил бы
    // правило для узкого экрана и оставил окно у правого края
    expect(css).toMatch(/--mt-compose-offset/);
    expect(read('compose/ComposeWindow.tsx')).not.toMatch(/style=\{[^}]*right:/);
  });

  it('список писем не заводит собственную горизонтальную прокрутку', () => {
    const css = narrowRules(read('mail/MessageList.module.css'), 600);
    expect(css).toMatch(/\.scroll\s*\{[^}]*overflow-x:\s*hidden/);
    // Отправитель, дата и превью ужимаются — иначе теме не остаётся места
    expect(css).toMatch(/\.correspondent/);
    expect(css).toMatch(/\.snippet\s*\{[^}]*display:\s*none/);
  });

  it('тело письма перестаёт отдавать треть ширины телефона полям', () => {
    const css = narrowRules(read('pages/MessagePage.module.css'), 600);
    const body = /\.body,\s*\.bodyText\s*\{[^}]*padding:\s*\d+px\s+(\d+)px/.exec(css);
    expect(body, 'поля тела письма на телефоне не уменьшены').not.toBeNull();
    expect(Number(body![1])).toBeLessThanOrEqual(12);
  });

  it('на телефоне цели касания не меньше 44px', () => {
    const targets: Array<[string, RegExp]> = [
      ['layout/Header.module.css', /\.menuButton,\s*\.headerButton\s*\{[^}]*height:\s*44px/],
      ['layout/Sidebar.module.css', /\.item\s*\{[^}]*height:\s*44px/],
      ['mail/ListToolbar.module.css', /\.toolbar button\s*\{[^}]*height:\s*44px/],
      ['pages/MessagePage.module.css', /\.toolbar button[^{]*\{[^}]*height:\s*44px/],
    ];
    for (const [file, rule] of targets) {
      expect(narrowRules(read(file), 480), file).toMatch(rule);
    }
  });
});
