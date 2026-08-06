/**
 * Порядок подсказок — то единственное, что отличает полезную подсказку от
 * раздражающей.
 *
 * Каждое правило проверяется в обе стороны: не только «тот, кому писали
 * сами, выше», но и «при равном весе выше тот, с кем переписывались
 * недавнее». Проверка в одну сторону тут не значит ничего — функция,
 * возвращающая постоянную оценку, прошла бы половину файла, и получился
 * бы алфавитный список, ради ухода от которого всё и затевалось.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contactScore,
  correspondenceWeight,
  HALF_LIFE_DAYS,
  rankContacts,
  recencyFactor,
  SUGGEST_LIMIT,
  type ContactRow,
} from './rank.js';
import { contactTokens } from './tokens.js';

const NOW = new Date('2026-08-06T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function row(patch: Partial<ContactRow> & { address: string }): ContactRow {
  const name = patch.name ?? null;
  return {
    name,
    sentCount: 0,
    recvCount: 0,
    lastSeenAt: daysAgo(1),
    tokens: contactTokens(name, patch.address),
    ...patch,
  };
}

test('отправленное письмо весит больше полученного', () => {
  assert.ok(
    correspondenceWeight({ sentCount: 1, recvCount: 0 }) >
      correspondenceWeight({ sentCount: 0, recvCount: 1 }),
  );
  // Обратный ход: полученные письма всё же считаются, а не отбрасываются
  assert.ok(correspondenceWeight({ sentCount: 0, recvCount: 5 }) > 0);
});

test('свежесть падает вдвое за период полураспада', () => {
  assert.equal(recencyFactor(NOW, NOW), 1);
  const half = recencyFactor(daysAgo(HALF_LIFE_DAYS), NOW);
  assert.ok(Math.abs(half - 0.5) < 1e-9, `ожидалось 0.5, получено ${String(half)}`);
  // Обратный ход: старое действительно легче свежего
  assert.ok(recencyFactor(daysAgo(400), NOW) < recencyFactor(daysAgo(10), NOW));
});

test('дата из будущего не даёт преимущества', () => {
  // Заголовок Date пишет отправитель; письмо «из 2037 года» иначе стояло
  // бы первым в подсказке вечно.
  assert.equal(recencyFactor(new Date(NOW.getTime() + 10 * 86_400_000), NOW), 1);
});

test('кому писали сами — выше того, от кого только получали', () => {
  // Рассылка с тридцатью письмами не должна обходить человека, которому
  // человек писал сам четыре раза: её адрес не проверен ничем, а его —
  // проверен доставкой.
  const ranked = rankContacts(
    [
      row({ address: 'newsletter@shop.example', recvCount: 30, name: 'Магазин' }),
      row({ address: 'ivan@example.com', sentCount: 4, recvCount: 4, name: 'Иван' }),
    ],
    'e',
    NOW,
  );
  assert.equal(ranked[0]?.address, 'ivan@example.com');
});

test('надбавка «писал сам» не воскрешает мёртвый адрес', () => {
  // Обратный ход к предыдущей проверке: если бы надбавка была
  // безусловной, адрес, которым не пользовались три года, вечно стоял бы
  // выше живой переписки.
  const ranked = rankContacts(
    [
      row({ address: 'dead@example.com', sentCount: 5, lastSeenAt: daysAgo(1100) }),
      row({ address: 'alive@example.com', recvCount: 12, lastSeenAt: daysAgo(2) }),
    ],
    'e',
    NOW,
  );
  assert.equal(ranked[0]?.address, 'alive@example.com');
});

test('давняя частая переписка не перебивает свежую', () => {
  // Здесь и виден смысл произведения вместо суммы: сто писем трёхлетней
  // давности — это мёртвый адрес, и он не должен стоять выше живого.
  const ranked = rankContacts(
    [
      row({ address: 'old@example.com', sentCount: 100, lastSeenAt: daysAgo(1100) }),
      row({ address: 'fresh@example.com', sentCount: 2, lastSeenAt: daysAgo(2) }),
    ],
    'e',
    NOW,
  );
  assert.equal(ranked[0]?.address, 'fresh@example.com');
});

test('при равной свежести выше тот, с кем переписывались чаще', () => {
  const ranked = rankContacts(
    [
      row({ address: 'rare@example.com', sentCount: 1, lastSeenAt: daysAgo(3) }),
      row({ address: 'often@example.com', sentCount: 20, lastSeenAt: daysAgo(3) }),
    ],
    'e',
    NOW,
  );
  assert.equal(ranked[0]?.address, 'often@example.com');
  // Обратный ход: поменяем местами вес — поменяется и порядок
  const flipped = rankContacts(
    [
      row({ address: 'rare@example.com', sentCount: 20, lastSeenAt: daysAgo(3) }),
      row({ address: 'often@example.com', sentCount: 1, lastSeenAt: daysAgo(3) }),
    ],
    'e',
    NOW,
  );
  assert.equal(flipped[0]?.address, 'rare@example.com');
});

test('совпадение с начала записи ценится выше совпадения внутри', () => {
  const head = row({ address: 'ivan@example.com', name: 'Иван', sentCount: 2 });
  const inside = row({ address: 'petr@ivanovo.example.com', name: 'Пётр', sentCount: 2 });
  const ranked = rankContacts([inside, head], 'ива', NOW);
  assert.equal(ranked[0]?.address, 'ivan@example.com');
  // Обратный ход: надбавка не всесильна — давняя и частая переписка
  // остаётся впереди случайного свежего совпадения с начала
  const strong = row({ address: 'petr@ivanovo.example.com', name: 'Пётр', sentCount: 50 });
  const weak = row({ address: 'ivan@example.com', name: 'Иван', sentCount: 1 });
  assert.equal(rankContacts([weak, strong], 'ива', NOW)[0]?.address, 'petr@ivanovo.example.com');
});

test('порядок не зависит от порядка строк, пришедших из базы', () => {
  // Прыгающая подсказка опаснее бесполезной: человек целится в строку,
  // а она уезжает под курсором.
  const rows = [
    row({ address: 'a@example.com', sentCount: 1, lastSeenAt: daysAgo(5) }),
    row({ address: 'b@example.com', sentCount: 1, lastSeenAt: daysAgo(5) }),
    row({ address: 'c@example.com', sentCount: 1, lastSeenAt: daysAgo(5) }),
  ];
  const first = rankContacts(rows, 'e', NOW).map((r) => r.address);
  const second = rankContacts([...rows].reverse(), 'e', NOW).map((r) => r.address);
  assert.deepEqual(first, second);
});

test('список обрезается по пределу', () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    row({ address: `user${String(i)}@example.com`, sentCount: i }),
  );
  assert.equal(rankContacts(rows, 'user', NOW).length, SUGGEST_LIMIT);
  assert.equal(rankContacts(rows, 'user', NOW, 3).length, 3);
  assert.equal(rankContacts(rows, 'user', NOW, 0).length, 0);
});

test('контакт без счётчиков не пропадает из выдачи', () => {
  // Счётчики могли не проставиться при частичном сборе; показать адрес,
  // с которым переписка была, всё равно надо.
  const score = contactScore(row({ address: 'x@example.com' }), 'x', NOW);
  assert.ok(score > 0);
});
