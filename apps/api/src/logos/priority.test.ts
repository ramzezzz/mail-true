/**
 * Что важнее чего, когда источников несколько.
 *
 * Проверяется тот самый порядок, ради которого хранилище ручных решений
 * вообще заведено отдельно:
 *
 *   запрет  >  ручная картинка  >  найденное автоматически
 *
 * Ошибка здесь выглядит как «настройка не работает»: администратор загрузил
 * логотип, а через сутки кэш обновился и молча вернул картинку из сети.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { loadLogoConfig } from './config.js';
import { SenderLogoService } from './service.js';
import { LogoStore, logoVersion } from './store.js';
import { overrideVersion, type LogoOverride } from './overrides.js';

const logger = {
  debug: () => undefined,
  warn: () => undefined,
  info: () => undefined,
} as unknown as Logger;

const config = loadLogoConfig({});

const AUTO = Buffer.from('автоматическая картинка');
const MANUAL = Buffer.from('картинка администратора');

/** Кэш с одной готовой записью и без похода в сеть. */
function cacheWith(bytes: Buffer | null): LogoStore {
  const entry = {
    domain: 'example.com',
    source: bytes ? ('bimi' as const) : null,
    mime: bytes ? 'image/png' : null,
    bytes,
    width: bytes ? 128 : null,
    height: bytes ? 128 : null,
    version: logoVersion('example.com', bytes),
    expiresAt: new Date(Date.now() + 3600_000),
  };
  return {
    read: async () => new Map([['example.com', entry]]),
    forget: () => undefined,
    ttlHoursFor: () => 1,
    write: async () => entry,
  } as unknown as LogoStore;
}

/** Хранилище ручных решений с заданным ответом. */
function overridesWith(decision: Partial<LogoOverride> | null) {
  const full: LogoOverride | null =
    decision === null
      ? null
      : {
          domain: 'example.com',
          blocked: false,
          mime: null,
          bytes: null,
          width: null,
          height: null,
          version: '',
          updatedAt: new Date(),
          updatedBy: 'admin',
          ...decision,
        };
  return {
    read: async () => (full ? new Map([['example.com', full]]) : new Map()),
    get: async () => full,
  } as never;
}

function serviceWith(cacheBytes: Buffer | null, decision: Partial<LogoOverride> | null) {
  return new SenderLogoService({
    config,
    logger,
    store: cacheWith(cacheBytes),
    overrides: overridesWith(decision),
  });
}

test('без ручного решения действует найденное автоматически', async () => {
  const service = serviceWith(AUTO, null);
  const state = (await service.resolve(['example.com'], 'a@mail.local')).get('example.com');
  assert.equal(state?.status, 'ready');
  assert.equal(state?.status === 'ready' && state.source, 'bimi');
});

test('ручная картинка сильнее найденной автоматически', async () => {
  /*
   * Иначе очередное обновление кэша молча вернуло бы картинку из сети, и
   * администратор решил бы, что загрузка не работает, — а она работает,
   * просто её перебивают.
   */
  const service = serviceWith(AUTO, {
    bytes: MANUAL,
    mime: 'image/png',
    width: 64,
    height: 64,
    version: overrideVersion('example.com', MANUAL),
  });
  const state = (await service.resolve(['example.com'], 'a@mail.local')).get('example.com');
  assert.equal(state?.status, 'ready');
  assert.equal(state?.status === 'ready' && state.source, 'manual');

  const image = await service.image('example.com');
  assert.deepEqual(image?.bytes, MANUAL);
});

test('запрет сильнее и ручной картинки, и найденной', async () => {
  const service = serviceWith(AUTO, {
    blocked: true,
    bytes: MANUAL,
    mime: 'image/png',
    width: 64,
    height: 64,
  });
  const state = (await service.resolve(['example.com'], 'a@mail.local')).get('example.com');
  assert.equal(state?.status, 'none', 'в кружке остаётся буква');
  assert.equal(await service.image('example.com'), null, 'байты наружу не отдаются');
});

test('запрещённый домен не ищется в сети вовсе', async () => {
  // Ходить за картинкой, которую всё равно не покажем, — это и трата
  // времени, и лишний след на чужом сервере.
  let readCache = false;
  const store = {
    read: async () => {
      readCache = true;
      return new Map();
    },
    forget: () => undefined,
    ttlHoursFor: () => 1,
    write: async () => {
      throw new Error('поиск не должен был запуститься');
    },
  } as unknown as LogoStore;

  const service = new SenderLogoService({
    config,
    logger,
    store,
    overrides: overridesWith({ blocked: true }),
  });
  await service.resolve(['example.com'], 'a@mail.local');
  assert.equal(readCache, false);
});

test('снятая ручная картинка возвращает домен к автоматической, а не к пустоте', async () => {
  // Строка ручных решений может остаться (например, из-за прежнего запрета),
  // но без картинки она не должна прятать найденное.
  const service = serviceWith(AUTO, { blocked: false, bytes: null, mime: null });
  const state = (await service.resolve(['example.com'], 'a@mail.local')).get('example.com');
  assert.equal(state?.status, 'ready');
  assert.equal(state?.status === 'ready' && state.source, 'bimi');
});

test('состояние домена для панели называет действующий источник', async () => {
  const manual = serviceWith(AUTO, {
    bytes: MANUAL,
    mime: 'image/png',
    width: 64,
    height: 64,
    version: overrideVersion('example.com', MANUAL),
  });
  assert.equal((await manual.adminState('example.com')).state, 'manual');
  assert.equal((await manual.adminState('example.com')).hasManual, true);

  const blocked = serviceWith(AUTO, { blocked: true });
  assert.equal((await blocked.adminState('example.com')).state, 'blocked');

  const auto = serviceWith(AUTO, null);
  assert.equal((await auto.adminState('example.com')).state, 'auto');
  assert.equal((await auto.adminState('example.com')).autoSource, 'bimi');

  const nothing = serviceWith(null, null);
  assert.equal((await nothing.adminState('example.com')).state, 'none');
});
