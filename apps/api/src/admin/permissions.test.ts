/** Проверка прав: роли должны давать ровно то, что заявлено. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ADMIN_ROLES,
  assertPermission,
  hasPermission,
  isAdminRole,
  permissionsOf,
  PERMISSIONS,
  ROLE_LABELS,
} from './permissions.js';
import { ForbiddenError } from './errors.js';

test('роль «только чтение» не может ничего менять', () => {
  const writing = PERMISSIONS.filter((p) => !p.endsWith('.read'));
  for (const permission of writing) {
    assert.equal(
      hasPermission('readonly', permission),
      false,
      `readonly не должен иметь ${permission}`,
    );
  }
  assert.equal(hasPermission('readonly', 'users.read'), true);
  assert.equal(hasPermission('readonly', 'audit.read'), true);
});

test('роль «управление пользователями»: ящики можно, домены и админов — нет', () => {
  assert.equal(hasPermission('user_manager', 'users.write'), true);
  assert.equal(hasPermission('user_manager', 'users.password'), true);
  assert.equal(hasPermission('user_manager', 'aliases.write'), true);
  assert.equal(hasPermission('user_manager', 'mailbox.impersonate'), true);
  assert.equal(hasPermission('user_manager', 'domains.dnscheck'), true);

  assert.equal(hasPermission('user_manager', 'users.delete'), false);
  assert.equal(hasPermission('user_manager', 'domains.write'), false);
  assert.equal(hasPermission('user_manager', 'admins.manage'), false);
});

test('роль «полный доступ» имеет все права', () => {
  for (const permission of PERMISSIONS) {
    assert.equal(hasPermission('owner', permission), true, `owner должен иметь ${permission}`);
  }
});

test('неизвестная роль не имеет никаких прав', () => {
  for (const permission of PERMISSIONS) {
    assert.equal(hasPermission('superuser', permission), false);
    assert.equal(hasPermission('', permission), false);
  }
  assert.deepEqual(permissionsOf('кто-то'), []);
});

test('assertPermission бросает ForbiddenError и молчит при наличии права', () => {
  assert.throws(() => assertPermission('readonly', 'users.write'), ForbiddenError);
  assert.throws(() => assertPermission('readonly', 'users.write'), /Только чтение/);
  assert.doesNotThrow(() => assertPermission('owner', 'users.write'));
});

test('assertPermission ставит статус 403', () => {
  try {
    assertPermission('readonly', 'admins.manage');
    assert.fail('должно было бросить');
  } catch (err) {
    assert.ok(err instanceof ForbiddenError);
    assert.equal(err.statusCode, 403);
    assert.equal(err.code, 'FORBIDDEN');
  }
});

test('isAdminRole принимает только известные роли', () => {
  for (const role of ADMIN_ROLES) assert.equal(isAdminRole(role), true);
  for (const junk of ['OWNER', 'admin', '', null, undefined, 42]) {
    assert.equal(isAdminRole(junk), false);
  }
});

test('у каждой роли есть человекочитаемое название', () => {
  for (const role of ADMIN_ROLES) {
    assert.equal(typeof ROLE_LABELS[role], 'string');
    assert.ok(ROLE_LABELS[role].length > 0);
  }
});

test('права ролей вложены: readonly ⊂ user_manager ⊂ owner', () => {
  const readonly = new Set(permissionsOf('readonly'));
  const manager = new Set(permissionsOf('user_manager'));
  const owner = new Set(permissionsOf('owner'));
  for (const p of readonly) assert.ok(manager.has(p), `${p} потерялось у user_manager`);
  for (const p of manager) assert.ok(owner.has(p), `${p} потерялось у owner`);
  assert.equal(owner.size, PERMISSIONS.length);
});
