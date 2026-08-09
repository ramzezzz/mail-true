import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import { ImapPool, type ImapPoolOptions } from './pool.js';

/** Подставной IMAP-клиент: реализует ровно то, чем пользуется пул. */
class FakeClient extends EventEmitter {
  usable = false;
  closed = false;
  connectCalls = 0;
  connectDelayMs = 0;
  /** Только Error: подделка обязана вести себя как настоящий отказ. */
  connectError: Error | null = null;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    }
    if (this.connectError) throw this.connectError;
    this.usable = true;
  }

  async logout(): Promise<void> {
    this.usable = false;
    this.closed = true;
    this.emit('close');
  }

  close(): void {
    this.usable = false;
    this.closed = true;
  }
}

const silentLogger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

interface Harness {
  pool: ImapPool;
  created: FakeClient[];
}

function makePool(
  tune: (client: FakeClient) => void = () => undefined,
  extra: Partial<ImapPoolOptions> = {},
): Harness {
  const created: FakeClient[] = [];
  const pool = new ImapPool({
    host: '127.0.0.1',
    port: 143,
    secure: false,
    rejectUnauthorized: false,
    idleMs: 60_000,
    logger: silentLogger,
    createClient: () => {
      const client = new FakeClient();
      tune(client);
      created.push(client);
      return client as unknown as ImapFlow;
    },
    ...extra,
  });
  return { pool, created };
}

/**
 * Главный случай. Раньше проверка «есть ли соединение» и его открытие стояли
 * ДО очереди и не были защищены от гонки: 60 параллельных запросов видели
 * пустой пул одновременно и открывали 60 соединений. Стек упирался в
 * `mail_max_userip_connections` Dovecot (`doveadm who` показывал 51 соединение),
 * часть запросов падала с 401, а вход блокировался на пять минут.
 */
test('60 параллельных запросов открывают ровно одно соединение', async () => {
  // Задержка подключения — именно она раньше раскрывала окно гонки
  const { pool, created } = makePool((c) => {
    c.connectDelayMs = 20;
  });

  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) => pool.withClient('test@mail.local', 'pass', async () => i)),
  );

  assert.equal(results.length, 60);
  assert.equal(created.length, 1, 'соединение должно быть открыто ровно одно');
  assert.equal(created[0]?.connectCalls, 1);
  assert.equal(pool.openConnections, 1);
});

test('параллельные запросы разных пользователей не мешают друг другу', async () => {
  const { pool, created } = makePool();
  await Promise.all([
    pool.withClient('a@mail.local', 'p', async () => 1),
    pool.withClient('b@mail.local', 'p', async () => 2),
    pool.withClient('a@mail.local', 'p', async () => 3),
  ]);
  assert.equal(created.length, 2, 'по одному соединению на пользователя');
});

test('обращения одного пользователя не пересекаются во времени', async () => {
  const { pool } = makePool();
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      pool.withClient('test@mail.local', 'p', async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 1));
        inside -= 1;
      }),
    ),
  );
  assert.equal(maxInside, 1, 'соединение используется строго по очереди');
});

/**
 * Раньше отказ по пределу соединений приходил с полем `authenticationFailed`
 * и превращался в 401 «Неверный адрес или пароль».
 */
test('отказ по пределу соединений при входе — это 503, а не «неверный пароль»', async () => {
  const { pool } = makePool((c) => {
    c.connectError = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      response: '* BYE [ALERT] Maximum number of connections from user+IP exceeded',
    });
  });

  await assert.rejects(pool.verify('test@mail.local', 'верный-пароль'), (err: unknown) => {
    const e = err as { statusCode: number; code: string };
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, 'UPSTREAM_UNAVAILABLE');
    return true;
  });
});

test('настоящий неверный пароль при входе по-прежнему даёт 401 AUTH_FAILED', async () => {
  const { pool } = makePool((c) => {
    c.connectError = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
      response: 'NO [AUTHENTICATIONFAILED] Authentication failed.',
    });
  });
  await assert.rejects(pool.verify('test@mail.local', 'плохой'), (err: unknown) => {
    const e = err as { statusCode: number; code: string };
    assert.equal(e.statusCode, 401);
    assert.equal(e.code, 'AUTH_FAILED');
    return true;
  });
});

/**
 * Необработанное событие 'error' на источнике событий убивает процесс Node.
 * В verify слушателя не было вовсе.
 */
test('событие error на проверочном соединении не остаётся необработанным', async () => {
  const { pool, created } = makePool();
  await pool.verify('test@mail.local', 'p');
  const client = created[0];
  assert.ok(client);
  assert.ok(client.listenerCount('error') > 0, 'на клиента повешен слушатель ошибок');
  // Если бы слушателя не было, следующая строка выбросила бы ошибку наружу
  client.emit('error', new Error('обрыв после logout'));
});

test('событие error на соединении пула не остаётся необработанным', async () => {
  const { pool, created } = makePool();
  await pool.withClient('test@mail.local', 'p', async () => 1);
  const client = created[0];
  assert.ok(client);
  assert.ok(client.listenerCount('error') > 0);
  client.emit('error', new Error('обрыв'));
  assert.equal(pool.openConnections, 0, 'сломанное соединение забыто');
});

/**
 * 30 запросов в полёте + `docker kill mail-dovecot` давали `{"200":5,"500":25}`
 * и `Error: Connection not available` в логе. Контракт — 503.
 */
test('обрыв соединения посреди запроса даёт 503, а не 500', async () => {
  const { pool } = makePool();
  await pool.withClient('test@mail.local', 'p', async () => 1);

  await assert.rejects(
    pool.withClient('test@mail.local', 'p', async () => {
      throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    }),
    (err: unknown) => {
      const e = err as { statusCode: number; code: string };
      assert.equal(e.statusCode, 503);
      assert.equal(e.code, 'UPSTREAM_UNAVAILABLE');
      return true;
    },
  );
});

test('после обрыва очередь получает новое соединение, а не мёртвое', async () => {
  const { pool, created } = makePool();

  const first = pool.withClient('test@mail.local', 'p', async () => {
    // Соединение умирает посреди работы первой задачи
    throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
  });
  // Вторая задача встаёт в очередь ДО того, как первая упала
  const second = pool.withClient('test@mail.local', 'p', async () => 'готово');

  await assert.rejects(first);
  assert.equal(await second, 'готово', 'очередь восстановилась');
  assert.equal(created.length, 2, 'для второй задачи открыто новое соединение');
});

test('прикладная ошибка внутри задачи не подменяется на 503', async () => {
  const { pool } = makePool();
  await assert.rejects(
    pool.withClient('test@mail.local', 'p', async () => {
      throw new Error('Папка не найдена');
    }),
    /Папка не найдена/,
  );
});

test('соединение переиспользуется между последовательными запросами', async () => {
  const { pool, created } = makePool();
  await pool.withClient('test@mail.local', 'p', async () => 1);
  await pool.withClient('test@mail.local', 'p', async () => 2);
  assert.equal(created.length, 1);
});

test('closeUser закрывает соединение пользователя', async () => {
  const { pool, created } = makePool();
  await pool.withClient('test@mail.local', 'p', async () => 1);
  await pool.closeUser('test@mail.local');
  assert.equal(created[0]?.closed, true);
  assert.equal(pool.openConnections, 0);
});

/*
 * Закрытие дорожки не отменяет её очередь — и раньше это стоило вечного
 * соединения.
 *
 * `closeUser` вынимал дорожку из карты, не глядя на задачи в очереди. Та,
 * что стояла следующей, доходила до `acquire` уже после этого, видела
 * `client === null` и открывала НОВОЕ соединение — в дорожку, которой в
 * карте больше нет. Закрыть его потом было нечем: сторож простоя первой
 * же строкой выходил (`lanes.get(email) !== lane`), повторный `closeUser`
 * этой дорожки не находил, `closeAll` при остановке сервера — тоже.
 * Соединение висело до собственного таймаута Dovecot, а у ящика на это
 * время оказывалось два живых соединения вместо одного — то есть команды
 * двух запросов переставали выстраиваться в общую очередь.
 *
 * Ждущая задача теперь получает отказ: закрытие означает, что сессии
 * больше нет — человек вышел, либо ему сменили пароль, либо ящик
 * заблокировали.
 */
test('задача, дождавшаяся закрытия дорожки, не открывает новое соединение', async () => {
  const { pool, created } = makePool();
  let releaseFirst = (): void => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    const first = pool.withClient('test@mail.local', 'p', async () => {
      resolve();
      await new Promise<void>((done) => {
        releaseFirst = done;
      });
      return 1;
    });
    void first.catch(() => undefined);
  });
  await firstStarted;

  // Вторая задача встаёт в очередь за первой и ждёт своей ветки.
  const second = pool.withClient('test@mail.local', 'p', async () => 2);
  const secondSettled = second.then(
    () => 'выполнилась',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );

  await pool.closeUser('test@mail.local');
  releaseFirst();

  assert.match(await secondSettled, /Сессия закрыта/);
  assert.equal(created.length, 1, 'после закрытия дорожки открылось лишнее соединение');
  assert.equal(pool.openConnections, 0);
});
