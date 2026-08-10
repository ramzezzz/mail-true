/**
 * Юнит-тесты представления сборщика в контракте веб-интерфейса.
 *
 * Отдельно проверяется хранение признаков, под которые в таблице нет
 * столбцов (leaveOnServer, applyFilters, protocol): они не должны
 * теряться между сохранением и чтением, иначе флажки в форме будут
 * «сами сбрасываться».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Folder } from '@mail-true/shared';
import { collectorNote, decodeLabel, encodeLabel, toWebCollector } from './collectorRoutes.js';
import type { ExternalAccount } from './types.js';

const FOLDERS: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: true,
    uidValidity: 1,
  },
];

function account(partial: Partial<ExternalAccount> = {}): ExternalAccount {
  return {
    id: 3,
    address: 'user@other.example',
    label: null,
    mode: 'collector',
    imap: { host: 'imap.other.example', port: 993, secure: true, user: 'user@other.example' },
    smtp: null,
    allowInsecureTls: false,
    targetFolder: 'INBOX',
    collectScope: 'inbox',
    intervalMinutes: 15,
    enabled: true,
    state: {
      lastRunAt: '2026-08-05T10:00:00.000Z',
      lastOkAt: '2026-08-05T10:00:05.000Z',
      status: 'ok',
      error: null,
      lastCopied: 4,
      lastSkipped: 1,
      lastFailed: 0,
      lastDurationMs: 900,
      totalCopied: 42,
      runs: 3,
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...partial,
  };
}

test('признаки без столбцов переживают оборот через метку', () => {
  for (const flags of [
    { label: null, leaveOnServer: true, applyFilters: false, protocol: 'imap' as const },
    { label: 'Рабочий', leaveOnServer: false, applyFilters: true, protocol: 'imap' as const },
    { label: null, leaveOnServer: false, applyFilters: false, protocol: 'pop3' as const },
  ]) {
    assert.deepEqual(decodeLabel(encodeLabel(flags)), flags);
  }
});

/**
 * Название подключения человек задаёт сам (POST /api/accounts/external
 * принимает `label` до 255 символов любого текста), а служебные признаки
 * живут в том же поле после разделителя `mt:`. Разделитель поэтому обязан
 * искаться с КОНЦА строки: иначе название с двоеточием разрезает метку
 * пополам, и настройки подключения молча меняются на чужие.
 */
test('название с «mt:» внутри не съедает служебные признаки', () => {
  const encoded = encodeLabel({
    label: 'Почта mt: рабочая',
    leaveOnServer: true,
    applyFilters: true,
    protocol: 'imap',
  });
  assert.deepEqual(decodeLabel(encoded), {
    label: 'Почта mt: рабочая',
    leaveOnServer: true,
    applyFilters: true,
    protocol: 'imap',
  });
});

test('метка без служебной части читается как обычное название', () => {
  assert.deepEqual(decodeLabel('Просто название'), {
    label: 'Просто название',
    leaveOnServer: true,
    applyFilters: false,
    protocol: 'imap',
  });
  assert.deepEqual(decodeLabel(null), {
    label: null,
    leaveOnServer: true,
    applyFilters: false,
    protocol: 'imap',
  });
});

test('подключение -> DTO интерфейса', () => {
  const dto = toWebCollector(
    account({
      label: encodeLabel({
        label: 'Рабочий',
        leaveOnServer: false,
        applyFilters: true,
        protocol: 'imap',
      }),
    }),
    FOLDERS,
  );
  assert.equal(dto.id, '3');
  assert.equal(dto.email, 'user@other.example');
  assert.equal(dto.host, 'imap.other.example');
  assert.equal(dto.port, 993);
  assert.equal(dto.secure, true);
  assert.equal(dto.login, 'user@other.example');
  assert.equal(dto.targetFolderId, 'inbox', 'папка отдаётся идентификатором, а не путём IMAP');
  assert.equal(dto.leaveOnServer, false);
  assert.equal(dto.applyFilters, true);
  assert.equal(dto.status, 'ok');
  assert.equal(dto.lastSyncAt, '2026-08-05T10:00:05.000Z');
  assert.equal(dto.error, null);
});

test('пароля в DTO нет ни в каком виде', () => {
  const dto = toWebCollector(account(), FOLDERS);
  assert.ok(!Object.keys(dto).some((k) => k.toLowerCase().includes('pass')));
});

test('идущий сбор и ошибка видны в состоянии', () => {
  const running = toWebCollector(
    account({
      state: { ...account().state, status: 'running', lastOkAt: null },
    }),
    FOLDERS,
  );
  assert.equal(running.status, 'syncing');
  assert.equal(running.lastSyncAt, '2026-08-05T10:00:00.000Z');

  const failed = toWebCollector(
    account({
      state: { ...account().state, status: 'error', error: 'Чужой сервер недоступен' },
    }),
    FOLDERS,
  );
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Чужой сервер недоступен');
});

/* ------------------------------------------------------------------ */
/* Незаконченный сбор                                                   */
/* ------------------------------------------------------------------ */

test('сбор, не уложившийся в отведённое время, не выдаётся за поломку', () => {
  const dto = toWebCollector(
    account({
      state: {
        ...account().state,
        status: 'partial',
        error: null,
        lastCopied: 1240,
        lastFailed: 0,
        lastOkAt: null,
      },
    }),
    FOLDERS,
  );
  assert.equal(dto.status, 'ok', 'ящик исправен, письма едут — красить красным нечего');
  assert.equal(dto.error, null);
  assert.match(dto.note ?? '', /1240/u, 'сколько уже перенесено — обязано быть видно');
  assert.equal(dto.lastSyncAt, '2026-08-05T10:00:00.000Z', 'время последнего захода не теряется');
});

test('часть писем не перенеслась — это ошибка, и она названа', () => {
  const acc = account({
    state: {
      ...account().state,
      status: 'partial',
      error: 'Не удалось перенести писем: 7',
      lastCopied: 30,
      lastFailed: 7,
    },
  });
  const dto = toWebCollector(acc, FOLDERS);
  assert.equal(dto.status, 'error');
  assert.equal(dto.error, 'Не удалось перенести писем: 7');
  assert.equal(collectorNote(acc), null, 'вторая строка про «ещё едет» тут только запутает');
});

test('у законченного сбора никакой второй строки нет', () => {
  assert.equal(collectorNote(account()), null);
});
