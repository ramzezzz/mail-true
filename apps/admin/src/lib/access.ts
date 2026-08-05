/**
 * Права в интерфейсе.
 *
 * ВАЖНО: это только для того, чтобы не показывать кнопки, которыми
 * всё равно нельзя воспользоваться. Настоящая проверка — на сервере
 * (apps/api/src/admin/permissions.ts), и она выполняется на каждом запросе.
 * Если здесь ошибиться в сторону «разрешить», сервер всё равно ответит 403.
 */
import type { AdminRole, Permission } from '../api/types';

/** Есть ли право у сессии. */
export function can(
  permissions: readonly Permission[] | undefined,
  permission: Permission,
): boolean {
  return permissions?.includes(permission) ?? false;
}

/** Есть ли хотя бы одно из прав (для показа раздела в меню). */
export function canAny(
  permissions: readonly Permission[] | undefined,
  wanted: readonly Permission[],
): boolean {
  return wanted.some((p) => can(permissions, p));
}

export const ROLE_LABELS: Readonly<Record<AdminRole, string>> = {
  owner: 'Полный доступ',
  user_manager: 'Управление пользователями',
  readonly: 'Только чтение',
};

/** Пункт бокового меню админки. */
export interface NavItem {
  to: string;
  title: string;
  /** Права, при отсутствии которых пункт не показывается. */
  requires: readonly Permission[];
  /** Раздел ещё не реализован — рисуем как заглушку. */
  stub?: boolean;
}

/** Полное меню админки; фильтруется правами текущей сессии. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', title: 'Дашборд', requires: ['overview.read'] },
  { to: '/users', title: 'Пользователи', requires: ['users.read'] },
  { to: '/aliases', title: 'Алиасы', requires: ['aliases.read'] },
  { to: '/domains', title: 'Домены и DNS', requires: ['domains.read'] },
  // Настройки помощника ИИ — это настройки домена, поэтому и право то же.
  { to: '/ai', title: 'Помощник ИИ', requires: ['domains.read'] },
  /*
   * Пункта «Вход в ящик» здесь больше нет. Входят теперь кнопкой прямо в
   * строке списка ящиков — искать нужный адрес заново не приходится.
   * Сама страница /mailbox осталась: в ней читают уже открытый ящик.
   * Журнал входов отдельного пункта не требует — он в «Журнале аудита».
   */
  { to: '/audit', title: 'Журнал аудита', requires: ['audit.read'] },
  // Очередь писем и история обработанных. Заглушкой раздел больше не
  // является: очередь читается у Postfix, история — из разобранного журнала.
  { to: '/flow', title: 'Почтовый поток', requires: ['overview.read'] },
  // Журналы служб содержат адреса переписки, поэтому право то же, что
  // у журнала аудита, а не «кто видит сводку».
  { to: '/logs', title: 'Журналы почты', requires: ['audit.read'] },
  { to: '/spam', title: 'Спам', requires: ['overview.read'], stub: true },
  { to: '/monitoring', title: 'Наблюдение', requires: ['overview.read'], stub: true },
  { to: '/backups', title: 'Резервные копии', requires: ['overview.read'], stub: true },
];

/** Пункты меню, доступные этой роли. */
export function visibleNav(permissions: readonly Permission[] | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => canAny(permissions, item.requires));
}
