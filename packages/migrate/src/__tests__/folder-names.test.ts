/**
 * Тесты имён папок-приёмников.
 *
 * Разбирается дефект: папка с точкой в имени не переносилась вовсе.
 * Хранилище Maildir использует точку как разделитель уровней, а
 * translatePath заменял только разделитель приёмника. Папка
 * «Отчёт 2024.финал» не создавалась («NO Command failed»), делалось пять
 * попыток с нарастающей паузой, после чего папка терялась целиком.
 * У Kerio такие имена обычны: «Проект v2.0», «ООО Ромашка. Договоры».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFolderMappings,
  sanitizeDestPath,
  sanitizeSegment,
  translatePath,
  MAILDIR_UNSAFE_CHARS,
} from '../folder-map.js';
import type { SourceFolder } from '../types.js';

const folder = (path: string, delimiter = '/'): SourceFolder => ({
  path,
  delimiter,
  noSelect: false,
});

describe('sanitizeSegment / sanitizeDestPath', () => {
  it('убирает точку из имени сегмента, сохраняя иерархию', () => {
    assert.equal(sanitizeSegment('Отчёт 2024.финал', MAILDIR_UNSAFE_CHARS), 'Отчёт 2024_финал');
    assert.equal(sanitizeSegment('Проект v2.0', MAILDIR_UNSAFE_CHARS), 'Проект v2_0');
  });

  it('иерархия по разделителю приёмника не трогается', () => {
    assert.equal(
      sanitizeDestPath('Клиенты/ООО Ромашка. Договоры', '/', MAILDIR_UNSAFE_CHARS),
      'Клиенты/ООО Ромашка_ Договоры',
    );
  });

  it('если разделитель приёмника сам точка — уровни сохраняются', () => {
    assert.equal(sanitizeDestPath('Проекты.2024', '.', MAILDIR_UNSAFE_CHARS), 'Проекты.2024');
  });
});

describe('translatePath: недопустимые символы приёмника', () => {
  it('по умолчанию поведение прежнее — заменяется только разделитель приёмника', () => {
    assert.equal(translatePath('Отчёт 2024.финал', '/', '/', false), 'Отчёт 2024.финал');
    assert.equal(translatePath('a/b', '.', '/', false), 'a_b');
  });

  it('со списком недопустимых символов точка заменяется', () => {
    assert.equal(
      translatePath('Отчёт 2024.финал', '/', '/', false, MAILDIR_UNSAFE_CHARS),
      'Отчёт 2024_финал',
    );
    assert.equal(
      translatePath('Клиенты/Проект v2.0', '/', '/', false, MAILDIR_UNSAFE_CHARS),
      'Клиенты/Проект v2_0',
    );
  });

  it('источник с точкой-разделителем: уровни остаются уровнями', () => {
    // Kerio отдаёт «Проекты.2024» как два уровня, разделитель источника «.»
    assert.equal(
      translatePath('Проекты.2024', '.', '/', false, MAILDIR_UNSAFE_CHARS),
      'Проекты/2024',
    );
  });
});

describe('buildFolderMappings: недопустимые символы приёмника', () => {
  it('план сопоставления учитывает список недопустимых символов', () => {
    const mappings = buildFolderMappings(
      [folder('Отчёт 2024.финал'), folder('ООО Ромашка. Договоры')],
      '/',
      {},
      {},
      MAILDIR_UNSAFE_CHARS,
    );
    assert.deepEqual(
      mappings.map((m) => m.destPath),
      ['Отчёт 2024_финал', 'ООО Ромашка_ Договоры'],
    );
  });

  it('без списка план прежний (совместимость)', () => {
    const mappings = buildFolderMappings([folder('Отчёт 2024.финал')], '/');
    assert.equal(mappings[0]?.destPath, 'Отчёт 2024.финал');
  });
});
