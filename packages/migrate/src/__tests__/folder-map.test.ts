/** Тесты сопоставления папок источника и приёмника. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFolderMappings,
  detectInboxPrefix,
  detectRole,
  translatePath,
} from '../folder-map.js';
import type { SourceFolder } from '../types.js';

function folder(path: string, delimiter = '/', specialUse?: string): SourceFolder {
  return { path, delimiter, ...(specialUse ? { specialUse } : {}), noSelect: false };
}

describe('detectRole', () => {
  it('распознаёт спец-папки Kerio Connect по именам', () => {
    assert.equal(detectRole(folder('Sent Items')), 'sent');
    assert.equal(detectRole(folder('Deleted Items')), 'trash');
    assert.equal(detectRole(folder('Junk E-mail')), 'junk');
    assert.equal(detectRole(folder('Drafts')), 'drafts');
    assert.equal(detectRole(folder('INBOX')), 'inbox');
  });

  it('распознаёт русские имена', () => {
    assert.equal(detectRole(folder('Отправленные')), 'sent');
    assert.equal(detectRole(folder('Корзина')), 'trash');
    assert.equal(detectRole(folder('Спам')), 'junk');
    assert.equal(detectRole(folder('Черновики')), 'drafts');
    assert.equal(detectRole(folder('Удалённые')), 'trash');
  });

  it('SPECIAL-USE имеет приоритет над именем', () => {
    assert.equal(detectRole(folder('Whatever', '/', '\\Sent')), 'sent');
    assert.equal(detectRole(folder('Мусор', '/', '\\Trash')), 'trash');
  });

  it('видит спец-папки под префиксом INBOX (Courier/Exchange)', () => {
    assert.equal(detectRole(folder('INBOX/Sent Items')), 'sent');
    assert.equal(detectRole(folder('INBOX.Drafts', '.')), 'drafts');
  });

  it('обычные папки не считает специальными', () => {
    assert.equal(detectRole(folder('Проекты')), null);
    assert.equal(detectRole(folder('Projects/Sent Items')), null);
  });
});

describe('translatePath', () => {
  it('меняет разделитель "." на "/" (Dovecot maildir → наш сервер)', () => {
    assert.equal(translatePath('Work.Reports.2024', '.', '/', false), 'Work/Reports/2024');
  });

  it('отбрасывает префикс INBOX', () => {
    assert.equal(translatePath('INBOX.Работа', '.', '/', true), 'Работа');
    assert.equal(translatePath('INBOX/Работа/Счета', '/', '/', true), 'Работа/Счета');
  });

  it('не трогает сам INBOX', () => {
    assert.equal(translatePath('INBOX', '.', '/', true), 'INBOX');
  });

  it('экранирует разделитель приёмника внутри имени сегмента', () => {
    // папка "2024/2025" на сервере с разделителем "." не должна стать двумя уровнями
    assert.equal(translatePath('Отчёты.2024/2025', '.', '/', false), 'Отчёты/2024_2025');
  });
});

describe('detectInboxPrefix', () => {
  it('true, когда все папки лежат под INBOX', () => {
    const folders = [folder('INBOX', '.'), folder('INBOX.Sent', '.'), folder('INBOX.Work', '.')];
    assert.equal(detectInboxPrefix(folders), true);
  });

  it('false при папках на верхнем уровне', () => {
    const folders = [folder('INBOX'), folder('Sent'), folder('INBOX/Sub')];
    assert.equal(detectInboxPrefix(folders), false);
  });
});

describe('buildFolderMappings', () => {
  const kerio = [
    folder('INBOX'),
    folder('Sent Items'),
    folder('Deleted Items'),
    folder('Junk E-mail'),
    folder('Drafts'),
    folder('Projects'),
    folder('Projects/Alpha'),
  ];

  it('кладёт спец-папки Kerio в наши папки Dovecot', () => {
    const mappings = buildFolderMappings(kerio, '/');
    const byPath = new Map(mappings.map((m) => [m.source.path, m.destPath]));
    assert.equal(byPath.get('INBOX'), 'INBOX');
    assert.equal(byPath.get('Sent Items'), 'Sent');
    assert.equal(byPath.get('Deleted Items'), 'Trash');
    assert.equal(byPath.get('Junk E-mail'), 'Spam');
    assert.equal(byPath.get('Drafts'), 'Drafts');
    assert.equal(byPath.get('Projects/Alpha'), 'Projects/Alpha');
  });

  it('уважает спец-папки приёмника из его SPECIAL-USE', () => {
    const mappings = buildFolderMappings(kerio, '/', { junk: 'Junk', trash: 'Deleted' });
    const byPath = new Map(mappings.map((m) => [m.source.path, m.destPath]));
    assert.equal(byPath.get('Junk E-mail'), 'Junk');
    assert.equal(byPath.get('Deleted Items'), 'Deleted');
  });

  it('переопределения пользователя сильнее всего', () => {
    const mappings = buildFolderMappings(
      kerio,
      '/',
      {},
      {
        overrides: { 'Sent Items': 'Архив/Отправленные', Projects: 'Работа' },
      },
    );
    const byPath = new Map(mappings.map((m) => [m.source.path, m.destPath]));
    assert.equal(byPath.get('Sent Items'), 'Архив/Отправленные');
    assert.equal(byPath.get('Projects'), 'Работа');
    assert.equal(mappings.find((m) => m.source.path === 'Sent Items')?.reason, 'override');
  });

  it('исключает папки из списка exclude', () => {
    const mappings = buildFolderMappings(kerio, '/', {}, { exclude: ['Junk E-mail'] });
    assert.equal(
      mappings.some((m) => m.source.path === 'Junk E-mail'),
      false,
    );
  });

  it('пропускает невыбираемые папки (\\Noselect)', () => {
    const withNoselect = [...kerio, { ...folder('Public Folders'), noSelect: true }];
    const mappings = buildFolderMappings(withNoselect, '/');
    assert.equal(
      mappings.some((m) => m.source.path === 'Public Folders'),
      false,
    );
  });

  it('переносит иерархию с точкой-разделителем и префиксом INBOX', () => {
    const dovecot = [
      folder('INBOX', '.'),
      folder('INBOX.Sent', '.', '\\Sent'),
      folder('INBOX.Работа', '.'),
      folder('INBOX.Работа.Счета', '.'),
    ];
    const mappings = buildFolderMappings(dovecot, '/');
    const byPath = new Map(mappings.map((m) => [m.source.path, m.destPath]));
    assert.equal(byPath.get('INBOX'), 'INBOX');
    assert.equal(byPath.get('INBOX.Sent'), 'Sent');
    assert.equal(byPath.get('INBOX.Работа'), 'Работа');
    assert.equal(byPath.get('INBOX.Работа.Счета'), 'Работа/Счета');
  });

  it('пропускает служебный контейнер [Gmail] и переносит его детей', () => {
    const gmail = [
      folder('INBOX'),
      { ...folder('[Gmail]'), noSelect: true },
      folder('[Gmail]/Sent Mail', '/', '\\Sent'),
      folder('[Gmail]/Spam', '/', '\\Junk'),
    ];
    const mappings = buildFolderMappings(gmail, '/');
    const byPath = new Map(mappings.map((m) => [m.source.path, m.destPath]));
    assert.equal(byPath.get('[Gmail]/Sent Mail'), 'Sent');
    assert.equal(byPath.get('[Gmail]/Spam'), 'Spam');
    assert.equal(
      mappings.some((m) => m.source.path === '[Gmail]'),
      false,
    );
  });
});
