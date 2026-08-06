/**
 * Юнит-тесты пробы состояния.
 *
 * Закрепляется то, ради чего проба и появилась: отказ важной части обязан
 * покраснеть, отказ неважной — не обязан, и всё это не должно стоить
 * лишних обращений к службам.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import {
  brokenCriticalParts,
  HealthMonitor,
  IMAP_FAREWELL,
  probeTcpPort,
  SMTP_FAREWELL,
  statusOf,
  type HealthPart,
} from './health.js';

function part(
  id: string,
  critical: boolean,
  ok: boolean,
  onProbe?: () => void,
): HealthPart {
  return {
    id,
    title: id,
    critical,
    probe: async () => {
      onProbe?.();
      return { ok, detail: ok ? 'жив' : 'не отвечает' };
    },
  };
}

test('важная часть отказала — состояние fail', async () => {
  const monitor = new HealthMonitor({ ttlMs: 0 });
  monitor.register(part('redis', true, false));
  monitor.register(part('imap', true, true));

  const report = await monitor.report();
  assert.equal(report.status, 'fail');
  assert.deepEqual(
    brokenCriticalParts(report).map((p) => p.id),
    ['redis'],
  );
});

test('отказ неважной части не красит пробу контейнера', async () => {
  // Ровно то, из-за чего антиспам и отправка в пробу не входят: их отказ
  // не должен уводить сервер приложения в круг перезапусков.
  const monitor = new HealthMonitor({ ttlMs: 0 });
  monitor.register(part('imap', true, true));
  monitor.register(part('smtp', false, false));

  const report = await monitor.report();
  assert.equal(report.status, 'degraded');
  assert.deepEqual(brokenCriticalParts(report), []);
});

test('всё на месте — состояние ok', async () => {
  const monitor = new HealthMonitor({ ttlMs: 0 });
  monitor.register(part('redis', true, true));
  const report = await monitor.report();
  assert.equal(report.status, 'ok');
  assert.equal(report.parts[0]?.state, 'ok');
});

test('результат кэшируется: пробу дёргают каждые несколько секунд', async () => {
  let calls = 0;
  let clock = 1000;
  const monitor = new HealthMonitor({ ttlMs: 2000, now: () => clock });
  monitor.register(part('redis', true, true, () => (calls += 1)));

  await monitor.report();
  await monitor.report();
  await monitor.report();
  assert.equal(calls, 1, 'три вызова подряд — одно обращение к службе');

  clock += 2500;
  await monitor.report();
  assert.equal(calls, 2, 'после истечения кэша проверка повторяется');
});

test('одновременные вызовы делят одну проверку', async () => {
  let calls = 0;
  const monitor = new HealthMonitor({ ttlMs: 0 });
  monitor.register({
    id: 'slow',
    title: 'slow',
    critical: true,
    probe: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, detail: 'жив' };
    },
  });

  await Promise.all([monitor.report(), monitor.report(), monitor.report()]);
  assert.equal(calls, 1);
});

test('зависшая проверка отвечает отказом, а не висит', async () => {
  const monitor = new HealthMonitor({ ttlMs: 0, timeoutMs: 30 });
  monitor.register({
    id: 'postgres',
    title: 'Postgres',
    critical: true,
    // Обещание, которое не завершится никогда, — так ведёт себя
    // подвисшая база: соединение есть, ответа нет.
    probe: () => new Promise(() => undefined),
  });

  const report = await monitor.report();
  assert.equal(report.status, 'fail');
  assert.match(report.parts[0]?.detail ?? '', /нет ответа/);
});

test('исключение в проверке — отказ с текстом, а не падение пробы', async () => {
  const monitor = new HealthMonitor({ ttlMs: 0 });
  monitor.register({
    id: 'postgres',
    title: 'Postgres',
    critical: true,
    probe: () => Promise.reject(new Error('connection refused')),
  });

  const report = await monitor.report();
  assert.equal(report.parts[0]?.state, 'fail');
  assert.equal(report.parts[0]?.detail, 'connection refused');
});

test('часть, добавленная позже, попадает в ближайший ответ', async () => {
  // Postgres регистрирует админка, уже после первых запросов пробы.
  const clock = 0;
  const monitor = new HealthMonitor({ ttlMs: 60_000, now: () => clock });
  monitor.register(part('redis', true, true));
  assert.deepEqual((await monitor.report()).parts.map((p) => p.id), ['redis']);

  monitor.register(part('postgres', true, false));
  const report = await monitor.report();
  assert.deepEqual(report.parts.map((p) => p.id), ['redis', 'postgres']);
  assert.equal(report.status, 'fail');
});

test('statusOf: важное перевешивает неважное', () => {
  const p = (critical: boolean, state: 'ok' | 'fail') => ({
    id: 'x',
    title: 'x',
    critical,
    state,
    detail: '',
    latencyMs: 0,
  });
  assert.equal(statusOf([p(true, 'fail'), p(false, 'fail')]), 'fail');
  assert.equal(statusOf([p(true, 'ok'), p(false, 'fail')]), 'degraded');
  assert.equal(statusOf([p(true, 'ok'), p(false, 'ok')]), 'ok');
  assert.equal(statusOf([]), 'ok');
});

/**
 * Прощание пробы.
 *
 * Дефект, ради которого это появилось: проба рвала соединение сразу после
 * установки, Postfix писал `warning: lost connection after CONNECT` каждые
 * десять секунд, и журнал доставки в админке состоял из предупреждений,
 * которые сервер приложения порождал сам. Настоящий обрыв в этом потоке
 * было не отличить.
 */
function listen(onConnection: (socket: Socket) => void): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer(onConnection);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, server });
    });
  });
}

test('проба прощается по протоколу, а не рвёт соединение', async () => {
  let heard = '';
  const { port, server } = await listen((socket) => {
    socket.write('220 mail.local ESMTP Postfix\r\n');
    socket.on('data', (chunk) => {
      heard += chunk.toString('utf8');
      socket.end('221 2.0.0 Bye\r\n');
    });
  });
  try {
    assert.equal(await probeTcpPort('127.0.0.1', port, 2000, SMTP_FAREWELL), true);
    assert.equal(heard, 'QUIT\r\n');
  } finally {
    server.close();
  }
});

test('прощание не отправляется раньше приветствия', async () => {
  // `improper command pipelining after CONNECT` — то же предупреждение в
  // журнале, что и обрыв: по правилам SMTP клиент ждёт строки 220.
  let heardBeforeBanner = '';
  const { port, server } = await listen((socket) => {
    socket.on('data', (chunk) => {
      heardBeforeBanner += chunk.toString('utf8');
    });
    // Приветствие с задержкой — так ведёт себя занятый smtpd.
    setTimeout(() => socket.write('220 mail.local ESMTP Postfix\r\n'), 60);
  });
  try {
    assert.equal(await probeTcpPort('127.0.0.1', port, 2000, SMTP_FAREWELL), true);
    assert.equal(heardBeforeBanner, 'QUIT\r\n', 'команда должна прийти один раз и после 220');
  } finally {
    server.close();
  }
});

test('служба молчит — прощание не отправляется вовсе', async () => {
  let heard = '';
  const { port, server } = await listen((socket) => {
    socket.on('data', (chunk) => {
      heard += chunk.toString('utf8');
    });
  });
  try {
    assert.equal(await probeTcpPort('127.0.0.1', port, 3000, SMTP_FAREWELL), true);
    assert.equal(heard, '', 'говорить в тишину незачем');
  } finally {
    server.close();
  }
});

test('молчащая служба не задерживает пробу дольше четверти секунды', async () => {
  // Служба приняла соединение и не ответила ничего. Порт открыт — это и
  // есть предмет проверки, ждать ответа незачем.
  const { port, server } = await listen(() => undefined);
  try {
    const started = process.hrtime.bigint();
    assert.equal(await probeTcpPort('127.0.0.1', port, 5000, IMAP_FAREWELL), true);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1500, `проба заняла ${String(Math.round(elapsedMs))} мс`);
  } finally {
    server.close();
  }
});

test('обрыв во время прощания не превращает открытый порт в отказ', async () => {
  // Служба закрывает соединение по-живому, не дочитав QUIT. Так делает,
  // например, Postfix при исчерпании smtpd_client_connection_count_limit.
  const { port, server } = await listen((socket) => {
    socket.resetAndDestroy();
  });
  try {
    assert.equal(await probeTcpPort('127.0.0.1', port, 2000, SMTP_FAREWELL), true);
  } finally {
    server.close();
  }
});

test('закрытый порт остаётся отказом и с прощанием', async () => {
  const { port, server } = await listen(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await probeTcpPort('127.0.0.1', port, 1000, SMTP_FAREWELL), false);
});
