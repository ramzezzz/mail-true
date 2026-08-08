/**
 * Память о собственных адресах сервера приложения.
 *
 * Проверяется то, ради чего она заведена: адрес ПРЕЖНЕГО контейнера
 * остаётся нашим и после пересборки. На старом коде (сравнение только с
 * `os.networkInterfaces()` текущего процесса) вчерашние служебные
 * подключения веб-интерфейса превращались в разделе «Вход и действия» в
 * обычные входы по IMAP из локальной сети.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markService, ownAddresses, type AccessEvent } from './access-log.js';
import { ServiceAddressBook, type ServiceAddressStore } from './service-addresses.js';

/** Хранилище в памяти — ведёт себя как таблица api_service_addresses. */
class FakeStore implements ServiceAddressStore {
  readonly rows = new Map<string, Date>();
  constructor(
    private readonly ready: boolean,
    seed: readonly string[] = [],
  ) {
    for (const ip of seed) this.rows.set(ip, new Date('2026-08-01T00:00:00Z'));
  }
  serviceAddressesReady(): Promise<boolean> {
    return Promise.resolve(this.ready);
  }
  rememberServiceAddresses(ips: readonly string[]): Promise<void> {
    for (const ip of ips) this.rows.set(ip, new Date());
    return Promise.resolve();
  }
  listServiceAddresses(): Promise<string[]> {
    return Promise.resolve([...this.rows.keys()]);
  }
  purgeServiceAddresses(olderThan: Date): Promise<number> {
    let removed = 0;
    for (const [ip, seen] of this.rows) {
      if (seen < olderThan) {
        this.rows.delete(ip);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

/** Событие входа по IMAP с заданного адреса — как его отдаёт разбор журнала. */
function imapLogin(ip: string): AccessEvent {
  return {
    at: '2026-08-06T10:00:00.000Z',
    channel: 'imap',
    success: true,
    ip,
    userAgent: null,
    service: false,
    detail: 'Вход по паролю',
    origin: 'dovecot',
  };
}

test('адрес прежнего контейнера помнится и после пересборки', async () => {
  // 172.28.0.2 — адрес контейнера ДО пересборки: сейчас он не наш ни по
  // одному сетевому интерфейсу, но вчерашние строки журнала — про него.
  const store = new FakeStore(true, ['172.28.0.2']);
  const book = new ServiceAddressBook();
  assert.equal(await book.attach(store), true);

  assert.equal(book.known.has('172.28.0.2'), true, 'прежний адрес забыт — история соврёт');
  assert.equal(markService(imapLogin('172.28.0.2'), book.known).service, true);

  // Обратный ход: чужая машина из той же подсети служебной не становится
  assert.equal(markService(imapLogin('172.28.0.55'), book.known).service, false);
});

test('текущие адреса записываются в память при первом же обращении', async () => {
  const store = new FakeStore(true);
  const book = new ServiceAddressBook();
  await book.attach(store);

  // Ровно то, что сделает следующий контейнер для этих строк журнала
  for (const ip of ownAddresses()) {
    if (ip === '') continue;
    assert.equal(store.rows.has(ip), true, `свой адрес ${ip} не записан`);
    assert.equal(book.known.has(ip), true);
  }
});

test('без таблицы работает как раньше — на текущих адресах', async () => {
  // Миграция не применена. Это не авария: раздел обязан остаться рабочим,
  // просто без памяти о прежних контейнерах.
  const book = new ServiceAddressBook();
  assert.equal(await book.attach(new FakeStore(false)), false);
  assert.equal(book.persistent, false);
  assert.equal(book.known.has('127.0.0.1'), true, 'своя петля известна всегда');
  assert.equal(markService(imapLogin('127.0.0.1'), book.known).service, true);
});

test('отказ базы не оставляет раздел без адресов вовсе', async () => {
  const store = new FakeStore(true);
  const book = new ServiceAddressBook();
  await book.attach(store);
  const before = new Set(book.known);

  store.listServiceAddresses = () => Promise.reject(new Error('база недоступна'));
  await book.sync();

  assert.deepEqual(new Set(book.known), before, 'известное забывать нельзя');
});

test('адрес, которого давно не видели, забывается вместе с историей', async () => {
  /*
   * Держать адрес вечно нельзя: Docker однажды отдаст его чужой машине, и
   * настоящий вход человека станет «служебным подключением». Срок тот же,
   * что у истории входов, — объяснять эти строки всё равно больше нечего.
   */
  const store = new FakeStore(true, ['172.28.0.2']);
  const book = new ServiceAddressBook();
  await book.attach(store);
  assert.equal(book.known.has('172.28.0.2'), true);

  await book.purge(new Date('2026-08-05T00:00:00Z'));
  await book.sync();

  assert.equal(book.known.has('172.28.0.2'), false, 'забытый адрес остался в памяти');
  assert.equal(book.known.has('127.0.0.1'), true, 'свои сегодняшние адреса при этом на месте');
});
