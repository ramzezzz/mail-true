/** Проверка формирования записей журнала аудита. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  actionLabel,
  buildAuditRecord,
  diffValues,
  redactSecrets,
  REDACTED,
  type AuditActor,
  type AuditOrigin,
} from './audit.js';

const actor: AuditActor = { id: 7, login: 'root' };
const origin: AuditOrigin = { ip: '10.0.0.5', userAgent: 'Mozilla/5.0' };

test('секреты не попадают в журнал', () => {
  const redacted = redactSecrets({
    email: 'user@mail.local',
    password: 'очень-секретно',
    password_hash: '{SHA512-CRYPT}$6$abc$def',
    totp_secret: 'JBSWY3DPEHPK3PXP',
    nested: { api_key: 'sk-123', display_name: 'Иван' },
  }) as Record<string, unknown>;

  assert.equal(redacted.email, 'user@mail.local');
  assert.equal(redacted.password, REDACTED);
  assert.equal(redacted.password_hash, REDACTED);
  assert.equal(redacted.totp_secret, REDACTED);
  const nested = redacted.nested as Record<string, unknown>;
  assert.equal(nested.api_key, REDACTED);
  assert.equal(nested.display_name, 'Иван');

  // Никакого следа исходных значений в сериализованном виде
  const json = JSON.stringify(redacted);
  assert.equal(json.includes('очень-секретно'), false);
  assert.equal(json.includes('SHA512-CRYPT'), false);
  assert.equal(json.includes('sk-123'), false);
});

test('redactSecrets переживает массивы, даты, null и примитивы', () => {
  assert.deepEqual(redactSecrets([{ password: 'x' }, { a: 1 }]), [{ password: REDACTED }, { a: 1 }]);
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), null);
  assert.equal(redactSecrets('строка'), 'строка');
  assert.equal(redactSecrets(42), 42);
  assert.equal(redactSecrets(true), true);
  assert.equal(redactSecrets(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
});

test('diffValues оставляет только изменившиеся поля', () => {
  const diff = diffValues(
    { email: 'a@mail.local', quota_bytes: 1024, active: true, display_name: 'Иван' },
    { email: 'a@mail.local', quota_bytes: 2048, active: false, display_name: 'Иван' },
  );
  assert.deepEqual(diff.old, { quota_bytes: 1024, active: true });
  assert.deepEqual(diff.new, { quota_bytes: 2048, active: false });
});

test('diffValues: без изменений — пустой дифф', () => {
  const diff = diffValues({ a: 1, b: 'x' }, { a: 1, b: 'x' });
  assert.equal(diff.old, null);
  assert.equal(diff.new, null);
});

test('diffValues: создание и удаление', () => {
  const created = diffValues(null, { email: 'new@mail.local', password: 'секрет' });
  assert.equal(created.old, null);
  assert.deepEqual(created.new, { email: 'new@mail.local', password: REDACTED });

  const deleted = diffValues({ email: 'old@mail.local' }, null);
  assert.deepEqual(deleted.old, { email: 'old@mail.local' });
  assert.equal(deleted.new, null);
});

test('diffValues не считает изменением поле, которого нет в новом состоянии', () => {
  const diff = diffValues({ a: 1, b: 2 }, { a: 1 });
  assert.equal(diff.old, null);
  assert.equal(diff.new, null);
});

test('buildAuditRecord собирает полную строку журнала', () => {
  const record = buildAuditRecord(actor, origin, {
    action: 'user.update',
    targetType: 'user',
    targetId: 42,
    targetLabel: 'user@mail.local',
    before: { quota_bytes: 1024, password: 'старый' },
    after: { quota_bytes: 4096, password: 'новый' },
  });

  assert.equal(record.adminId, 7);
  assert.equal(record.adminLogin, 'root');
  assert.equal(record.action, 'user.update');
  assert.equal(record.targetType, 'user');
  assert.equal(record.targetId, 42);
  assert.equal(record.targetLabel, 'user@mail.local');
  assert.equal(record.ip, '10.0.0.5');
  assert.equal(record.userAgent, 'Mozilla/5.0');
  assert.deepEqual(record.oldValue, { quota_bytes: 1024, password: REDACTED });
  assert.deepEqual(record.newValue, { quota_bytes: 4096, password: REDACTED });
});

test('buildAuditRecord подставляет null там, где ничего не передали', () => {
  const record = buildAuditRecord(actor, { ip: null, userAgent: null }, {
    action: 'admin.logout',
    targetType: 'admin',
  });
  assert.equal(record.targetId, null);
  assert.equal(record.targetLabel, null);
  assert.equal(record.ip, null);
  assert.equal(record.userAgent, null);
  assert.equal(record.oldValue, null);
  assert.equal(record.newValue, null);
});

test('buildAuditRecord режет слишком длинные строки под размер столбцов', () => {
  const record = buildAuditRecord(
    actor,
    { ip: 'x'.repeat(200), userAgent: 'u'.repeat(900) },
    { action: 'user.create', targetType: 'user', targetLabel: 'l'.repeat(500) },
  );
  assert.equal(record.targetLabel?.length, 255);
  assert.equal(record.ip?.length, 64);
  assert.equal(record.userAgent?.length, 512);
});

test('actionLabel переводит известные действия и не теряет неизвестные', () => {
  assert.equal(actionLabel('user.create'), 'Создан ящик');
  assert.equal(actionLabel('mailbox.impersonate'), 'Вход администратора в ящик');
  assert.equal(actionLabel('нечто.новое'), 'нечто.новое');
});
