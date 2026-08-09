/**
 * Дашборд: разбор постраничности и счёт молчащих ящиков.
 *
 * Здесь закрыты два дефекта, и оба из тех, что видны только на живом
 * сервере:
 *
 *   1. ДРОБНЫЙ ПРЕДЕЛ УЕЗЖАЛ В LIMIT. Смещение округлялось, предел — нет,
 *      и «?limit=12.5» из чьей-нибудь закладки означал не пустой список,
 *      а «Внутренняя ошибка сервера»: Postgres на «LIMIT 12.5» отвечает
 *      ошибкой синтаксиса.
 *
 *   2. МОЛЧАВШИХ СЧИТАЛА ПАНЕЛЬ — по показанной странице. Страница
 *      отсортирована сервером по трафику по убыванию, молчащие ящики
 *      стоят в её хвосте и в первые 25 строк не попадают никогда. На
 *      сервере со 143 ящиками подпись под таблицей всегда сообщала
 *      «Молчали за период: 0» и выглядела при этом измеренной. Считать
 *      обязана база — по всем ящикам разом, тем же запросом.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminDb } from './db.js';
import { MetricsStore } from './metrics-store.js';
import { pageLimit } from './routes/overview.js';

/* ------------------------------------------------------------------ */
/* Предел строк                                                        */
/* ------------------------------------------------------------------ */

void test('дробный предел округляется, а не уезжает в LIMIT', () => {
  assert.equal(pageLimit('12.5', 25), 12);
  assert.equal(pageLimit(3.9, 25), 3);
  assert.ok(Number.isInteger(pageLimit('7.0001', 25)));
});

void test('предел держится в границах и падает на умолчание', () => {
  assert.equal(pageLimit(undefined, 25), 25, 'предела не прислали — берём умолчание');
  assert.equal(pageLimit('чепуха', 20), 20, 'нечисло — тоже умолчание, а не ноль');
  assert.equal(pageLimit('0', 25), 1, 'ноль строк — это не страница');
  assert.equal(pageLimit('-5', 25), 1);
  assert.equal(pageLimit('100000', 25), 200, 'потолок обязан держать');
});

/* ------------------------------------------------------------------ */
/* Молчащие ящики                                                      */
/* ------------------------------------------------------------------ */

/** Подделка базы: запоминает запрос и отдаёт одну готовую строку. */
function fakeDb(row: Record<string, unknown>): { db: AdminDb; sql: () => string } {
  let seen = '';
  const db = {
    async query<T>(text: string): Promise<T[]> {
      seen = text;
      return [row] as unknown as T[];
    },
  };
  return { db: db as unknown as AdminDb, sql: () => seen };
}

void test('молчащих считает база — по всем ящикам, а не по странице', async () => {
  // 143 ящика всего, 118 из них молчали. В странице — один разговорчивый:
  // ровно так и выглядит первая страница, отсортированная по трафику.
  const { db, sql } = fakeDb({
    id: 1,
    email: 'ivan@mail.local',
    active: true,
    quota_bytes: '1073741824',
    sent_messages: '12',
    sent_bytes: '240000',
    recv_messages: '30',
    recv_bytes: '900000',
    total_count: '143',
    silent_count: '118',
  });
  const store = new MetricsStore(db);
  const page = await store.userTraffic(new Date(0), new Date(), 'totalMessages', 25, 0);

  assert.equal(page.total, 143);
  assert.equal(page.silent, 118, 'молчащие потерялись по дороге из базы');
  assert.equal(page.rows.length, 1, 'страница как страница — счёт от неё не зависит');

  // Считать надо ОКНОМ по всей выборке, а не по отданным строкам: без
  // OVER () число снова стало бы «сколько молчащих попало на страницу».
  assert.match(
    sql().replace(/\s+/gu, ' '),
    /count\(\*\) FILTER \( WHERE sent_messages = 0 AND recv_messages = 0 \) OVER \(\)/u,
    'молчащие обязаны считаться оконной функцией по всей выборке',
  );
});

void test('пустая выборка даёт ноль молчащих, а не отсутствие числа', async () => {
  const db = {
    async query<T>(): Promise<T[]> {
      return [] as unknown as T[];
    },
  };
  const store = new MetricsStore(db as unknown as AdminDb);
  const page = await store.userTraffic(new Date(0), new Date(), 'totalMessages', 25, 0);
  assert.equal(page.total, 0);
  assert.equal(page.silent, 0);
});
