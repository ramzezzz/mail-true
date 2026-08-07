/**
 * Меню панели: группы вместо столбца из четырнадцати строк.
 *
 * Проверки закрывают то, чем группировка меню может навредить:
 *
 *   1. Порядок групп — от тревожной минуты к редкому обслуживанию.
 *      Наверху «Состояние»: туда идут, когда что-то не так.
 *   2. Пустых заголовков не бывает НИ ПРИ КАКОЙ роли. Подпись без единой
 *      строки под ней — обещание раздела, которого у человека нет.
 *   3. Каждый пункт лежит ровно в одной группе, и плоский список
 *      совпадает с группами: иначе раздел то появлялся бы дважды, то
 *      пропадал бы из проверок прав.
 *   4. Заголовок группы — не ссылка: нажать на него нельзя, и он не
 *      должен уводить фокус на себя при обходе с клавиатуры.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAV_GROUPS, NAV_ITEMS, visibleNav, visibleNavGroups } from '../src/lib/access';
import { SidebarNav } from '../src/app/AdminLayout';
import type { Permission } from '../src/api/types';

const READONLY: Permission[] = [
  'overview.read',
  'users.read',
  'aliases.read',
  'domains.read',
  'audit.read',
  'usersettings.read',
  'branding.read',
  'migration.read',
];

const USER_MANAGER: Permission[] = [
  ...READONLY,
  'users.write',
  'users.password',
  'aliases.write',
  'domains.dnscheck',
  'mailbox.impersonate',
  'usersettings.write',
  'migration.run',
];

const OWNER: Permission[] = [
  ...USER_MANAGER,
  'users.delete',
  'domains.write',
  'usersettings.bulk',
  'branding.write',
  'backup.export',
  'backup.restore',
  'serversettings.read',
  'serversettings.write',
  'admins.manage',
];

/** Роль, у которой прав хватает ровно на сводку: почти всё меню отпадает. */
const BARE: Permission[] = ['overview.read'];

describe('порядок групп', () => {
  it('сверху состояние, снизу обслуживание', () => {
    expect(NAV_GROUPS.map((group) => group.title)).toEqual([
      'Состояние',
      'Люди и адреса',
      'Почта',
      'Настройка',
      'Обслуживание',
    ]);
  });

  it('первый пункт меню — «Дашборд»', () => {
    expect(visibleNav(OWNER)[0]?.title).toBe('Дашборд');
    expect(visibleNavGroups(OWNER)[0]?.items[0]?.title).toBe('Дашборд');
  });

  it('«Журнал аудита» стоит в «Состоянии», а не в «Обслуживании»', () => {
    // В него идут с тем же вопросом «что произошло», что и в «Наблюдение».
    // А «Обслуживание» — это работы, которые сервер ИЗМЕНЯЮТ.
    const state = NAV_GROUPS.find((group) => group.id === 'state');
    const service = NAV_GROUPS.find((group) => group.id === 'service');
    expect(state?.items.map((i) => i.to)).toContain('/audit');
    expect(service?.items.map((i) => i.to)).not.toContain('/audit');
  });

  it('«Настройки сервера» — первый пункт группы «Настройка»', () => {
    const setup = NAV_GROUPS.find((group) => group.id === 'setup');
    expect(setup?.items[0]?.to).toBe('/server-settings');
  });
});

describe('группы и плоский список — одно и то же', () => {
  it('плоский список собран из групп по порядку', () => {
    expect(NAV_ITEMS.map((i) => i.to)).toEqual(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to)));
  });

  it('ни один раздел не попал в две группы', () => {
    const paths = NAV_ITEMS.map((i) => i.to);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('«Смены домена» в меню нет: её вход — внизу «Доменов и DNS»', () => {
    expect(NAV_ITEMS.map((i) => i.to)).not.toContain('/domain-change');
  });
});

describe('пустых заголовков не бывает', () => {
  for (const [name, permissions] of [
    ['полный доступ', OWNER],
    ['управление пользователями', USER_MANAGER],
    ['только чтение', READONLY],
    ['одна сводка', BARE],
    ['без сессии', undefined],
  ] as const) {
    it(`роль «${name}»: у каждой показанной группы есть хотя бы один пункт`, () => {
      for (const group of visibleNavGroups(permissions)) {
        expect(group.items.length, `пустая группа «${group.title}»`).toBeGreaterThan(0);
      }
    });
  }

  it('роль без прав на людей и адреса этой группы не видит вовсе', () => {
    const titles = visibleNavGroups(BARE).map((group) => group.title);
    expect(titles).not.toContain('Люди и адреса');
    // При этом «Состояние» и «Почта» ей доступны — по overview.read
    expect(titles).toContain('Состояние');
    expect(titles).toContain('Почта');
  });

  it('«только чтение» не видит группы с настройками сервера, но видит саму «Настройку»', () => {
    const groups = visibleNavGroups(READONLY);
    const setup = groups.find((group) => group.id === 'setup');
    expect(setup?.items.map((i) => i.to)).not.toContain('/server-settings');
    // Помощник ИИ и оформление входа ей доступны — группа остаётся
    expect(setup?.items.map((i) => i.to)).toContain('/ai');
  });

  it('без сессии меню пустое целиком', () => {
    expect(visibleNavGroups(undefined)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Отрисовка меню                                                      */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // ResizeObserver в jsdom нет, а подложка выделения его слушает
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {
        /* размеров в jsdom нет — измерять нечего */
      }
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderNav(permissions: Permission[] | undefined): void {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <SidebarNav groups={visibleNavGroups(permissions)} />
      </MemoryRouter>,
    );
  });
}

describe('меню на экране', () => {
  it('у владельца нарисованы все пять подписей, и они не ссылки', () => {
    renderNav(OWNER);
    const titles = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(titles).toEqual(['Состояние', 'Люди и адреса', 'Почта', 'Настройка', 'Обслуживание']);
    // Заголовок — ярлык над списком, нажимать его не на что
    for (const heading of container.querySelectorAll('h2')) {
      expect(heading.querySelector('a')).toBeNull();
    }
  });

  it('подпись без единого пункта под ней не рисуется', () => {
    renderNav(BARE);
    const titles = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(titles).not.toContain('Люди и адреса');
    expect(titles).not.toContain('Обслуживание');
    // Каждой оставшейся подписи соответствует хотя бы одна ссылка
    for (const group of container.querySelectorAll('nav > div')) {
      expect(group.querySelectorAll('a').length).toBeGreaterThan(0);
    }
  });

  it('без сессии меню пустое: ни ссылок, ни подписей', () => {
    renderNav(undefined);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelectorAll('h2')).toHaveLength(0);
  });

  it('порядок ссылок на экране совпадает с порядком групп', () => {
    renderNav(OWNER);
    const links = [...container.querySelectorAll('a')].map((a) => a.textContent);
    expect(links).toEqual(visibleNav(OWNER).map((item) => item.title));
  });
});
