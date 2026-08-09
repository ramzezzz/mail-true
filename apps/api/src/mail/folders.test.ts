/** Тесты маппинга IMAP-папок в роли и идентификаторы. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRole,
  roleByName,
  encodePathId,
  decodePathId,
  mapFolders,
  type RawFolderInfo,
} from './folders.js';

function raw(partial: Partial<RawFolderInfo> & { path: string }): RawFolderInfo {
  const name = partial.path.split(partial.delimiter ?? '/').pop() ?? partial.path;
  return {
    name,
    delimiter: '/',
    parentPath: '',
    ...partial,
  };
}

test('detectRole: INBOX всегда inbox', () => {
  assert.equal(detectRole(raw({ path: 'INBOX' })), 'inbox');
  assert.equal(detectRole(raw({ path: 'inbox' })), 'inbox');
});

test('detectRole: по SPECIAL-USE', () => {
  assert.equal(detectRole(raw({ path: 'Wyslane', specialUse: '\\Sent' })), 'sent');
  assert.equal(detectRole(raw({ path: 'Kosz', specialUse: '\\Trash' })), 'trash');
  assert.equal(detectRole(raw({ path: 'X', specialUse: '\\Junk' })), 'spam');
});

test('detectRole: по имени папки, включая русские', () => {
  assert.equal(detectRole(raw({ path: 'Sent Items' })), 'sent');
  assert.equal(detectRole(raw({ path: 'Черновики' })), 'drafts');
  assert.equal(detectRole(raw({ path: 'Спам' })), 'spam');
  assert.equal(detectRole(raw({ path: 'Корзина' })), 'trash');
  assert.equal(detectRole(raw({ path: 'Мои проекты' })), 'custom');
});

test('encodePathId/decodePathId обратимы для юникода', () => {
  const path = 'Личное/Счета 2026';
  const id = encodePathId(path);
  assert.ok(id.startsWith('f-'));
  assert.ok(!/[/+=:]/.test(id), 'идентификатор должен быть URL-безопасным');
  assert.equal(decodePathId(id), path);
});

test('mapFolders: роли, идентификаторы, счётчики', () => {
  const folders = mapFolders([
    raw({ path: 'INBOX', status: { messages: 42, unseen: 7, uidValidity: 123n } }),
    raw({
      path: 'Sent',
      specialUse: '\\Sent',
      status: { messages: 10, unseen: 0, uidValidity: 5n },
    }),
    raw({ path: 'Drafts', specialUse: '\\Drafts' }),
    raw({ path: 'Junk', specialUse: '\\Junk' }),
    raw({ path: 'Trash', specialUse: '\\Trash' }),
    raw({ path: 'Archive', specialUse: '\\Archive' }),
    raw({ path: 'Работа' }),
  ]);

  const inbox = folders.find((f) => f.id === 'inbox');
  assert.ok(inbox);
  assert.equal(inbox.role, 'inbox');
  assert.equal(inbox.unreadCount, 7);
  assert.equal(inbox.totalCount, 42);
  assert.equal(inbox.uidValidity, 123);
  assert.equal(inbox.system, true);

  for (const id of ['sent', 'drafts', 'spam', 'trash', 'archive']) {
    assert.ok(
      folders.some((f) => f.id === id),
      `должна быть папка с id=${id}`,
    );
  }

  const custom = folders.find((f) => f.path === 'Работа');
  assert.ok(custom);
  assert.equal(custom.role, 'custom');
  assert.equal(custom.system, false);
  assert.ok(custom.id.startsWith('f-'));

  // Системные папки идут первыми в фиксированном порядке
  assert.equal(folders[0]?.id, 'inbox');
});

test('mapFolders: вложенные папки получают parentId и depth', () => {
  const folders = mapFolders([
    raw({ path: 'INBOX' }),
    raw({ path: 'Проекты' }),
    raw({ path: 'Проекты/Почта', parentPath: 'Проекты', name: 'Почта' }),
  ]);
  const child = folders.find((f) => f.path === 'Проекты/Почта');
  const parent = folders.find((f) => f.path === 'Проекты');
  assert.ok(child && parent);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.depth, 1);
  assert.equal(parent.depth, 0);
});

test('mapFolders: дубликат роли становится custom-папкой', () => {
  const folders = mapFolders([
    raw({ path: 'Sent', specialUse: '\\Sent' }),
    raw({ path: 'Sent Messages' }),
  ]);
  const roleFolders = folders.filter((f) => f.id === 'sent');
  assert.equal(roleFolders.length, 1);
  const dup = folders.find((f) => f.path === 'Sent Messages');
  assert.ok(dup);
  assert.equal(dup.role, 'custom');
  assert.ok(dup.id.startsWith('f-'));
});

test('mapFolders: пропускает Noselect-контейнеры', () => {
  const folders = mapFolders([
    raw({ path: 'INBOX' }),
    raw({ path: '[Gmail]', flags: new Set(['\\Noselect']) }),
  ]);
  assert.ok(!folders.some((f) => f.path === '[Gmail]'));
});

/**
 * Служебные каталоги Dovecot приходили в дерево наравне с обычными:
 * человек видел папку «locks» (`dovecot/lda-dupes/locks` — хранилище
 * защиты от дублей при доставке), мог её переименовать и удалить.
 * Воспроизведено на живом стенде: `GET /api/folders` отдавал её седьмой
 * папкой с идентификатором `f-ZG92ZWNvdC9sZGEtZHVwZXMvbG9ja3M`.
 */
test('mapFolders: служебные каталоги Dovecot в дерево не попадают', () => {
  const folders = mapFolders([
    raw({ path: 'INBOX' }),
    raw({ path: 'dovecot', name: 'dovecot' }),
    raw({ path: 'dovecot/lda-dupes', name: 'lda-dupes', parentPath: 'dovecot' }),
    raw({ path: 'dovecot/lda-dupes/locks', name: 'locks', parentPath: 'dovecot/lda-dupes' }),
    raw({ path: 'Проекты', name: 'Проекты' }),
  ]);
  assert.equal(
    folders.some((f) => f.path.startsWith('dovecot')),
    false,
    'служебный каталог не должен показываться как папка пользователя',
  );
  assert.deepEqual(
    folders.map((f) => f.path),
    ['INBOX', 'Проекты'],
  );
});

test('mapFolders: обычная папка со словом dovecot внутри имени остаётся', () => {
  const folders = mapFolders([
    raw({ path: 'INBOX' }),
    raw({ path: 'Про dovecot', name: 'Про dovecot' }),
  ]);
  assert.ok(folders.some((f) => f.path === 'Про dovecot'));
});

/**
 * Папка, куда уезжает очищенная корзина (см. settings/recovery-mailbox.ts).
 * В дереве её быть не должно: рядом с «Корзиной» появилась бы вторая
 * корзина, из которой нельзя ни читать, ни писать. Рассказывает о ней
 * раздел настроек «Восстановление писем».
 */
test('mapFolders: служебная папка восстановления в дерево не попадает', () => {
  const folders = mapFolders([
    raw({ path: 'INBOX' }),
    raw({ path: 'Trash', name: 'Trash', specialUse: '\\Trash' }),
    raw({ path: 'Recovery', name: 'Recovery' }),
  ]);
  assert.deepEqual(
    folders.map((f) => f.path),
    ['INBOX', 'Trash'],
  );
});

test('mapFolders: папка со словом Recovery внутри имени остаётся', () => {
  // Прячется ровно один корневой путь, а не всё похожее: «Recovery plan»
  // — это папка человека, и терять её мы не вправе.
  const folders = mapFolders([
    raw({ path: 'INBOX' }),
    raw({ path: 'Recovery plan', name: 'Recovery plan' }),
  ]);
  assert.ok(folders.some((f) => f.path === 'Recovery plan'));
});

/*
 * Роль папки узнаётся в том числе по имени — так ящик, приехавший с
 * чужого сервера, получает правильные папки. Обратная сторона: папка,
 * заведённая человеком руками под таким именем, тоже становится
 * служебной, а служебную нельзя ни переименовать, ни удалить. Убрать её
 * из продукта было нечем, поэтому создание таких имён теперь отклоняется
 * — а решает это `roleByName`.
 */
test('roleByName: имена служебных папок узнаются по-русски и по-английски', () => {
  assert.equal(roleByName('Архив'), 'archive');
  assert.equal(roleByName('archive'), 'archive');
  assert.equal(roleByName('Спам'), 'spam');
  assert.equal(roleByName('Корзина'), 'trash');
  assert.equal(roleByName('Отложенные'), 'snoozed');
  assert.equal(roleByName('Заглушённые'), 'muted');
  assert.equal(roleByName('Черновики'), 'drafts');
});

test('roleByName: обычное имя остаётся обычным', () => {
  // Иначе запрет разросся бы на всё подряд: «Архивные документы» — это
  // папка человека, а не служебная.
  assert.equal(roleByName('Договоры'), 'custom');
  assert.equal(roleByName('Архивные документы'), 'custom');
  assert.equal(roleByName('Спамеры'), 'custom');
});
