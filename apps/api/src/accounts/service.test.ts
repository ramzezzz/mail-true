/**
 * Тесты живучести сборщика.
 *
 * Проверяется не «удачный сбор» (для него нужен чужой IMAP-сервер),
 * а поведение при отказах — то, из-за чего возможность подключить чужой
 * ящик выглядела сломанной на живом стенде:
 *
 *   - подключение с паролем от другого EXTERNAL_ACCOUNTS_KEY навсегда
 *     застревало в состоянии «идёт сбор» и молчало о причине;
 *   - одно такое подключение обрывало весь проход планировщика, и почта
 *     переставала собираться у ВСЕХ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { loadAccountsConfig } from './config.js';
import { AccountsService } from './service.js';
import { ExternalSecretBox } from './secret.js';
import type { AccountsDb } from './db.js';
import type { AppConfig } from '../config.js';
import type { ExternalAccount } from './types.js';

const logger = pino({ level: 'silent' });

const KEY = 'ключ-шифрования-паролей-минимум-32-символа';
const OTHER_KEY = 'совсем-другой-ключ-минимум-32-символа-длиной';

function account(id: number, address: string): ExternalAccount {
  return {
    id,
    address,
    label: null,
    mode: 'collector',
    imap: { host: 'imap.invalid', port: 993, secure: true, user: address },
    smtp: null,
    allowInsecureTls: false,
    targetFolder: 'INBOX',
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
  };
}

/** Подставная база: помнит, что ей велели записать. */
interface DoneCall {
  id: number;
  status: string;
  error: string | null;
}

function fakeDb(due: { ownerEmail: string; account: ExternalAccount; passwordEnc: string }[]) {
  const started: number[] = [];
  const done: DoneCall[] = [];
  const db = {
    listDueCollectors: () => Promise.resolve(due),
    markCollectorStart: (id: number) => {
      started.push(id);
      return Promise.resolve(true);
    },
    markCollectorDone: (id: number, r: { status: string; error: string | null }) => {
      done.push({ id, status: r.status, error: r.error });
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  } as unknown as AccountsDb;
  return { db, started, done };
}

function service(db: AccountsDb, secret: string) {
  const config = loadAccountsConfig({
    DATABASE_URL: 'postgres://x/y',
    EXTERNAL_ACCOUNTS_KEY: secret,
    DOVECOT_MASTER_USER: 'mtadmin',
    DOVECOT_MASTER_PASSWORD: 'пароль',
    COLLECTOR_SCHEDULER: 'false',
  } as NodeJS.ProcessEnv);
  const appConfig = {
    IMAP_HOST: '127.0.0.1',
    IMAP_PORT: 143,
    IMAP_SECURE: false,
    IMAP_POOL_IDLE_MS: 1000,
    TLS_REJECT_UNAUTHORIZED: false,
  } as AppConfig;
  return new AccountsService({
    config,
    appConfig,
    db,
    secretBox: new ExternalSecretBox(secret),
    secretBoxReason: null,
    logger,
  });
}

test('чужой ключ шифрования: отказ доезжает в состояние, а не вешает подключение', async () => {
  // Пароль зашифрован ДРУГИМ ключом — расшифровать нечем.
  const passwordEnc = new ExternalSecretBox(OTHER_KEY).encrypt('пароль-от-чужого-ящика');
  const { db, started, done } = fakeDb([]);
  const svc = service(db, KEY);

  const result = await svc.collect(
    'owner@mail.local',
    account(1, 'ext@other.example'),
    passwordEnc,
  );

  assert.deepEqual(started, [1], 'начало сбора должно быть отмечено');
  assert.equal(result?.status, 'error');
  assert.equal(done.length, 1, 'итог обязан быть записан даже при отказе подготовки');
  assert.equal(done[0]?.status, 'error', 'подключение не должно остаться «идёт сбор»');
  assert.match(String(done[0]?.error), /EXTERNAL_ACCOUNTS_KEY/, 'причина должна быть названа');
  await svc.close();
});

test('одно сломанное подключение не обрывает проход планировщика', async () => {
  const badEnc = new ExternalSecretBox(OTHER_KEY).encrypt('пароль');
  const goodEnc = new ExternalSecretBox(KEY).encrypt('пароль');
  const { db, started, done } = fakeDb([
    { ownerEmail: 'a@mail.local', account: account(1, 'bad@other.example'), passwordEnc: badEnc },
    { ownerEmail: 'b@mail.local', account: account(2, 'good@other.example'), passwordEnc: goodEnc },
  ]);
  const svc = service(db, KEY);

  await svc.tick();

  assert.deepEqual(started, [1, 2], 'до второго подключения проход обязан дойти');
  assert.equal(done.length, 2, 'итог записан по обоим подключениям');
  assert.equal(done[0]?.status, 'error');
  // Второе подключение смотрит на несуществующий сервер — тоже отказ,
  // но СВОЙ, а не «нас не спросили».
  assert.equal(done[1]?.id, 2);
  assert.equal(done[1]?.status, 'error');
  assert.equal(/EXTERNAL_ACCOUNTS_KEY/.test(String(done[1]?.error)), false);
  await svc.close();
});

test('без служебного доступа Dovecot причина видна в состоянии подключения', async () => {
  const passwordEnc = new ExternalSecretBox(KEY).encrypt('пароль');
  const { db, done } = fakeDb([]);
  const config = loadAccountsConfig({
    DATABASE_URL: 'postgres://x/y',
    EXTERNAL_ACCOUNTS_KEY: KEY,
    COLLECTOR_SCHEDULER: 'false',
  } as NodeJS.ProcessEnv);
  const svc = new AccountsService({
    config,
    appConfig: {
      IMAP_HOST: '127.0.0.1',
      IMAP_PORT: 143,
      IMAP_SECURE: false,
      IMAP_POOL_IDLE_MS: 1000,
      TLS_REJECT_UNAUTHORIZED: false,
    } as AppConfig,
    db,
    secretBox: new ExternalSecretBox(KEY),
    secretBoxReason: null,
    logger,
  });

  // Планировщик пароля владельца не знает — без служебного входа сбор невозможен.
  const result = await svc.collect(
    'owner@mail.local',
    account(3, 'ext@other.example'),
    passwordEnc,
  );

  assert.equal(result?.status, 'error');
  assert.match(String(done[0]?.error), /DOVECOT_MASTER_USER/);
  await svc.close();
});
