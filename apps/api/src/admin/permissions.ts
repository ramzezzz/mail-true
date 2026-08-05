/**
 * Роли и права администраторов.
 *
 * Права проверяются НА СЕРВЕРЕ при каждом запросе (см. requireAdmin в
 * routes/*.ts). Интерфейс использует тот же список только чтобы прятать
 * недоступные кнопки — это удобство, а не защита.
 */
import { ForbiddenError } from './errors.js';

/** Роли из admin_users.role (значения синхронизированы с CHECK в миграции 0003). */
export const ADMIN_ROLES = ['owner', 'user_manager', 'readonly'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Атомарные права. Действие в API всегда требует ровно одно из них. */
export const PERMISSIONS = [
  'overview.read',
  'users.read',
  'users.write',
  'users.password',
  'users.delete',
  'aliases.read',
  'aliases.write',
  'domains.read',
  'domains.write',
  'domains.dnscheck',
  'audit.read',
  'mailbox.impersonate',
  'admins.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Всё, что доступно только на чтение — базовый набор для любой роли. */
const READ_ONLY: readonly Permission[] = [
  'overview.read',
  'users.read',
  'aliases.read',
  'domains.read',
  'audit.read',
];

const USER_MANAGER: readonly Permission[] = [
  ...READ_ONLY,
  'users.write',
  'users.password',
  'aliases.write',
  'domains.dnscheck',
  'mailbox.impersonate',
];

const OWNER: readonly Permission[] = [
  ...USER_MANAGER,
  'users.delete',
  'domains.write',
  'admins.manage',
];

const ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly Permission[]>> = {
  readonly: READ_ONLY,
  user_manager: USER_MANAGER,
  owner: OWNER,
};

/** Человекочитаемые названия ролей для интерфейса. */
export const ROLE_LABELS: Readonly<Record<AdminRole, string>> = {
  owner: 'Полный доступ',
  user_manager: 'Управление пользователями',
  readonly: 'Только чтение',
};

/** Проверка, что строка из базы — известная роль. */
export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Полный список прав роли. Неизвестная роль трактуется как «прав нет». */
export function permissionsOf(role: string): readonly Permission[] {
  return isAdminRole(role) ? ROLE_PERMISSIONS[role] : [];
}

/** Есть ли у роли право. Единственный источник истины для проверок. */
export function hasPermission(role: string, permission: Permission): boolean {
  return permissionsOf(role).includes(permission);
}

/** Бросает 403, если права нет. Используется во всех изменяющих маршрутах. */
export function assertPermission(role: string, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new ForbiddenError(
      `Роль «${isAdminRole(role) ? ROLE_LABELS[role] : role}» не имеет права «${permission}»`,
    );
  }
}
