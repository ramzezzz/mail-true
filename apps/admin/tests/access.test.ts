/**
 * Права в интерфейсе. Проверяем, что меню и кнопки не показывают того,
 * что сервер всё равно запретит, — и наоборот, не прячут доступное.
 */
import { describe, expect, it } from 'vitest';
import { can, canAny, NAV_ITEMS, ROLE_LABELS, visibleNav } from '../src/lib/access';
import type { Permission } from '../src/api/types';

const READONLY: Permission[] = [
  'overview.read',
  'users.read',
  'aliases.read',
  'domains.read',
  'audit.read',
];

const USER_MANAGER: Permission[] = [
  ...READONLY,
  'users.write',
  'users.password',
  'aliases.write',
  'domains.dnscheck',
  'mailbox.impersonate',
];

const OWNER: Permission[] = [...USER_MANAGER, 'users.delete', 'domains.write', 'admins.manage'];

describe('can', () => {
  it('проверяет наличие права', () => {
    expect(can(READONLY, 'users.read')).toBe(true);
    expect(can(READONLY, 'users.write')).toBe(false);
  });

  it('без сессии прав нет', () => {
    expect(can(undefined, 'users.read')).toBe(false);
    expect(can([], 'users.read')).toBe(false);
  });
});

describe('canAny', () => {
  it('достаточно одного права из списка', () => {
    expect(canAny(READONLY, ['users.write', 'users.read'])).toBe(true);
    expect(canAny(READONLY, ['users.write', 'users.delete'])).toBe(false);
  });
});

describe('меню', () => {
  it('роль «только чтение» видит список ящиков и журнал', () => {
    const titles = visibleNav(READONLY).map((i) => i.title);
    expect(titles).toContain('Пользователи');
    expect(titles).toContain('Журнал аудита');
  });

  it('первый раздел называется «Дашборд», а не «Сводка»', () => {
    const titles = visibleNav(OWNER).map((i) => i.title);
    expect(titles[0]).toBe('Дашборд');
    expect(titles).not.toContain('Сводка');
  });

  it('отдельного пункта «Вход в ящик» в меню нет — входят кнопкой в списке', () => {
    // Даже у роли с правом входа: адрес известен из строки списка,
    // искать его заново в отдельном разделе не нужно.
    const titles = visibleNav(USER_MANAGER).map((i) => i.title);
    expect(titles).not.toContain('Вход в ящик');
    expect(NAV_ITEMS.map((i) => i.to)).not.toContain('/mailbox');
  });

  it('полный доступ видит все пункты', () => {
    expect(visibleNav(OWNER)).toHaveLength(NAV_ITEMS.length);
  });

  it('без сессии меню пустое', () => {
    expect(visibleNav(undefined)).toHaveLength(0);
  });

  it('заглушки помечены и присутствуют в меню', () => {
    const stubs = NAV_ITEMS.filter((i) => i.stub).map((i) => i.to);
    expect(stubs).toEqual(['/flow', '/spam', '/monitoring', '/backups']);
  });

  it('у каждого пункта задано хотя бы одно требуемое право', () => {
    for (const item of NAV_ITEMS) {
      expect(item.requires.length).toBeGreaterThan(0);
    }
  });
});

describe('названия ролей', () => {
  it('переведены на русский', () => {
    expect(ROLE_LABELS.owner).toBe('Полный доступ');
    expect(ROLE_LABELS.user_manager).toBe('Управление пользователями');
    expect(ROLE_LABELS.readonly).toBe('Только чтение');
  });
});
