/**
 * Юнит-тесты сопоставления папок для сборщика.
 *
 * Ошибка здесь стоит дорого: неверное сопоставление либо утащит к нам
 * чужую «Корзину», либо создаст папку «Собранное/INBOX/Проекты».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderOverrides, sourceEndpoint } from './collector.js';
import type { ExternalAccount } from './types.js';

const SOURCE_PATHS = ['INBOX', 'INBOX/Проекты', 'Sent', 'Trash', 'Архив/2024'];

test('охват «только Входящие»: остальное явно исключается', () => {
  const { overrides, exclude } = buildFolderOverrides(SOURCE_PATHS, 'Собранное', 'inbox');
  assert.deepEqual(overrides, { INBOX: 'Собранное' });
  assert.deepEqual(exclude.sort(), ['INBOX/Проекты', 'Sent', 'Trash', 'Архив/2024'].sort());
});

test('охват «все папки»: вложенность сохраняется, приставка INBOX убирается', () => {
  const { overrides, exclude } = buildFolderOverrides(SOURCE_PATHS, 'Собранное', 'all');
  assert.deepEqual(overrides, {
    INBOX: 'Собранное',
    'INBOX/Проекты': 'Собранное/Проекты',
    Sent: 'Собранное/Sent',
    Trash: 'Собранное/Trash',
    'Архив/2024': 'Собранное/Архив/2024',
  });
  assert.deepEqual(exclude, []);
});

test('приёмник INBOX: подпапки ложатся в корень, а не в INBOX/…', () => {
  const { overrides } = buildFolderOverrides(SOURCE_PATHS, 'INBOX', 'all');
  assert.equal(overrides['INBOX'], 'INBOX');
  assert.equal(overrides['INBOX/Проекты'], 'Проекты');
  assert.equal(overrides['Архив/2024'], 'Архив/2024');
});

test('регистр имени INBOX не важен', () => {
  const { overrides, exclude } = buildFolderOverrides(['inbox', 'Junk'], 'Собранное', 'inbox');
  assert.deepEqual(overrides, { inbox: 'Собранное' });
  assert.deepEqual(exclude, ['Junk']);
});

test('sourceEndpoint: параметры подключения к чужому серверу', () => {
  const account = {
    id: 1,
    address: 'user@other.example',
    label: null,
    mode: 'collector',
    imap: { host: 'imap.other.example', port: 993, secure: true, user: 'user@other.example' },
    smtp: null,
    allowInsecureTls: true,
    targetFolder: 'Собранное',
    collectScope: 'inbox',
    intervalMinutes: 15,
    enabled: true,
    state: {
      lastRunAt: null,
      lastOkAt: null,
      status: 'never',
      error: null,
      lastCopied: 0,
      lastSkipped: 0,
      lastFailed: 0,
      lastDurationMs: 0,
      totalCopied: 0,
      runs: 0,
    },
    createdAt: new Date(0).toISOString(),
  } satisfies ExternalAccount;

  assert.deepEqual(sourceEndpoint(account, 'пароль'), {
    host: 'imap.other.example',
    port: 993,
    secure: true,
    user: 'user@other.example',
    pass: 'пароль',
    allowInsecureTls: true,
  });
});
