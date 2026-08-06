/**
 * Проверки разбора ящика.
 *
 * Здесь проверяется не «функция вернула массив», а два обещания, которые
 * продукт даёт человеку и нарушить не имеет права:
 *
 *   1. группа — это ВСЕ письма отправителя, даже если он шлёт с разных
 *      адресов, и число писем в ней настоящее;
 *   2. отбор на удаление никогда не берёт больше, чем сказано, и никогда
 *      не трогает корзину, черновики и «Отложенные».
 *
 * Второе — самое опасное место всей возможности, поэтому проверок на
 * него больше всего.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FolderRole } from '@mail-true/shared';
import {
  groupKeyOf,
  groupMailings,
  heaviestMessages,
  messagesOfGroup,
  parseListId,
  selectForSweep,
  summarizeSelection,
  type ScannedMessage,
} from './mailings.js';

let counter = 0;

interface MessageSpec {
  folderId?: string;
  folderRole?: FolderRole;
  size?: number;
  date?: string;
  seen?: boolean;
  flagged?: boolean;
  subject?: string;
  from?: string;
  fromName?: string | null;
  listId?: string | null;
  unsubscribe?: boolean;
  oneClick?: boolean;
}

function message(spec: MessageSpec = {}): ScannedMessage {
  counter += 1;
  const folderId = spec.folderId ?? 'inbox';
  return {
    id: `${folderId}:${String(counter)}`,
    folderId,
    folderRole: spec.folderRole ?? 'inbox',
    uid: counter,
    size: spec.size ?? 1000,
    date: spec.date ?? '2026-01-01T00:00:00.000Z',
    seen: spec.seen ?? true,
    flagged: spec.flagged ?? false,
    subject: spec.subject ?? 'Тема',
    from: { name: spec.fromName ?? null, address: spec.from ?? 'shop@example.com' },
    listId: spec.listId ?? null,
    listName: null,
    unsubscribe: spec.unsubscribe ?? false,
    oneClick: spec.oneClick ?? false,
  };
}

/* ------------------------------------------------------------------ */
/* List-Id                                                             */
/* ------------------------------------------------------------------ */

test('List-Id: идентификатор берётся из скобок, имя — из того, что перед ними', () => {
  assert.deepEqual(parseListId('Скидки <news.shop.example>'), {
    id: 'news.shop.example',
    name: 'Скидки',
  });
  assert.deepEqual(parseListId('"Погода" <weather.example.com>'), {
    id: 'weather.example.com',
    name: 'Погода',
  });
  // Скобки забыли — идентификатором становится всё значение
  assert.deepEqual(parseListId('news.shop.example'), {
    id: 'news.shop.example',
    name: null,
  });
  assert.equal(parseListId(''), null);
  assert.equal(parseListId(null), null);
});

test('List-Id приводится к нижнему регистру: иначе одна рассылка станет двумя', () => {
  assert.equal(parseListId('<News.Shop.Example>')?.id, 'news.shop.example');
});

/* ------------------------------------------------------------------ */
/* Группировка                                                         */
/* ------------------------------------------------------------------ */

test('рассылка с разных адресов — ОДНА группа, если List-Id общий', () => {
  const groups = groupMailings([
    message({ from: 'news-01@shop.example', listId: 'news.shop.example' }),
    message({ from: 'news-02@shop.example', listId: 'news.shop.example' }),
    message({ from: 'bounce+abc@shop.example', listId: 'news.shop.example' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.count, 3);
  assert.equal(groups[0]?.kind, 'list');
});

test('без List-Id группа собирается по адресу и регистр адреса не важен', () => {
  const groups = groupMailings([
    message({ from: 'Ivan@Example.com' }),
    message({ from: 'ivan@example.com' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.count, 2);
  assert.equal(groups[0]?.kind, 'sender');
  assert.equal(groups[0]?.address, 'ivan@example.com');
});

test('порядок групп — по числу писем: главный источник шума первой строкой', () => {
  const groups = groupMailings([
    message({ from: 'rare@example.com' }),
    ...Array.from({ length: 5 }, () => message({ from: 'loud@example.com' })),
    message({ from: 'rare@example.com' }),
  ]);
  assert.equal(groups[0]?.address, 'loud@example.com');
  assert.equal(groups[0]?.count, 5);
  assert.equal(groups[1]?.count, 2);
});

test('переписка рассылкой не считается, а магазин без List-Id — считается', () => {
  const groups = groupMailings([
    message({ from: 'kolya@example.com' }),
    message({ from: 'shop@example.com', unsubscribe: true }),
    message({ from: 'list@example.com', listId: 'l.example.com' }),
  ]);
  const byAddress = new Map(groups.map((g) => [g.address, g]));
  assert.equal(byAddress.get('kolya@example.com')?.mailing, false);
  assert.equal(byAddress.get('shop@example.com')?.mailing, true);
  assert.equal(byAddress.get('list@example.com')?.mailing, true);
});

test('отписка назначается по самому свежему письму с адресом отписки', () => {
  const old = message({
    from: 'shop@example.com',
    date: '2025-01-01T00:00:00.000Z',
    unsubscribe: true,
  });
  const fresh = message({
    from: 'shop@example.com',
    date: '2026-01-01T00:00:00.000Z',
    unsubscribe: true,
    oneClick: true,
  });
  // Самое свежее письмо группы АДРЕСА ОТПИСКИ НЕ НЕСЁТ — и это не должно
  // мешать выбрать лучшее из тех, что несут.
  const newest = message({ from: 'shop@example.com', date: '2026-02-01T00:00:00.000Z' });

  const groups = groupMailings([old, fresh, newest]);
  assert.equal(groups[0]?.unsubscribeMessageId, fresh.id);
  assert.equal(groups[0]?.oneClick, true);
  assert.equal(groups[0]?.canUnsubscribe, true);
  assert.equal(groups[0]?.lastDate, newest.date);
});

test('группа без единого адреса отписки честно говорит, что отписаться нечем', () => {
  const groups = groupMailings([message({ from: 'shop@example.com' })]);
  assert.equal(groups[0]?.canUnsubscribe, false);
  assert.equal(groups[0]?.unsubscribeMessageId, null);
});

test('свои отправленные и черновики в группы отправителей не попадают', () => {
  const groups = groupMailings([
    message({ from: 'me@mail.local', folderId: 'sent', folderRole: 'sent' }),
    message({ from: 'me@mail.local', folderId: 'drafts', folderRole: 'drafts' }),
    message({ from: 'shop@example.com' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.address, 'shop@example.com');
});

test('в группе считаются письма, место, непрочитанные и папки', () => {
  const groups = groupMailings([
    message({ from: 'shop@example.com', size: 1500, seen: false }),
    message({ from: 'shop@example.com', size: 2500, seen: true, folderId: 'archive', folderRole: 'archive' }),
    message({ from: 'shop@example.com', size: 1000, seen: false }),
  ]);
  const group = groups[0];
  assert.equal(group?.count, 3);
  assert.equal(group?.bytes, 5000);
  assert.equal(group?.unread, 2);
  assert.deepEqual(group?.folders, [
    { folderId: 'inbox', count: 2 },
    { folderId: 'archive', count: 1 },
  ]);
});

test('имя группы берётся у самого свежего письма', () => {
  const groups = groupMailings([
    message({ from: 'shop@example.com', fromName: 'Магазин', date: '2025-01-01T00:00:00.000Z' }),
    message({ from: 'shop@example.com', fromName: 'Магазин и Ко', date: '2026-01-01T00:00:00.000Z' }),
  ]);
  assert.equal(groups[0]?.title, 'Магазин и Ко');
});

test('письма группы отбираются тем же ключом, что и сама группа', () => {
  const mine = message({ from: 'news@shop.example', listId: 'news.shop.example' });
  const other = message({ from: 'kolya@example.com' });
  const key = groupKeyOf(mine);
  assert.deepEqual(
    messagesOfGroup([mine, other], key).map((m) => m.id),
    [mine.id],
  );
});

/* ------------------------------------------------------------------ */
/* Отбор на уборку — самое опасное место                               */
/* ------------------------------------------------------------------ */

const NOW = new Date('2026-08-06T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

test('корзина, черновики и «Отложенные» не убираются никогда', () => {
  const chosen = selectForSweep(
    [
      message({ folderId: 'trash', folderRole: 'trash', date: daysAgo(400) }),
      message({ folderId: 'drafts', folderRole: 'drafts', date: daysAgo(400) }),
      message({ folderId: 'snoozed', folderRole: 'snoozed', date: daysAgo(400) }),
      message({ folderId: 'inbox', folderRole: 'inbox', date: daysAgo(400) }),
    ],
    { olderThanDays: 30 },
    NOW,
  );
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0]?.folderId, 'inbox');
});

test('«старше N дней» отсчитывается от заданного момента, а не от часов машины', () => {
  const messages = [
    message({ date: daysAgo(31) }),
    message({ date: daysAgo(29) }),
    message({ date: daysAgo(30.5) }),
  ];
  const chosen = selectForSweep(messages, { olderThanDays: 30 }, NOW);
  assert.equal(chosen.length, 2);
  assert.ok(chosen.every((m) => m.date < daysAgo(30)));
});

test('защита непрочитанного и помеченного сужает отбор, а не расширяет', () => {
  const messages = [
    message({ date: daysAgo(100), seen: false }),
    message({ date: daysAgo(100), flagged: true }),
    message({ date: daysAgo(100) }),
  ];
  assert.equal(selectForSweep(messages, { olderThanDays: 30 }, NOW).length, 3);
  assert.equal(
    selectForSweep(messages, { olderThanDays: 30, keepUnread: true }, NOW).length,
    2,
  );
  assert.equal(
    selectForSweep(
      messages,
      { olderThanDays: 30, keepUnread: true, keepFlagged: true },
      NOW,
    ).length,
    1,
  );
});

test('без условий уборка берёт всё, кроме защищённых папок: это осознанный выбор вызывающего', () => {
  const messages = [message(), message({ folderRole: 'trash', folderId: 'trash' })];
  assert.equal(selectForSweep(messages, {}, NOW).length, 1);
});

test('отбор по группе не задевает других отправителей', () => {
  const mine = message({ from: 'shop@example.com', date: daysAgo(100) });
  const other = message({ from: 'kolya@example.com', date: daysAgo(100) });
  const chosen = selectForSweep(
    [mine, other],
    { groupKey: groupKeyOf(mine), olderThanDays: 30 },
    NOW,
  );
  assert.deepEqual(
    chosen.map((m) => m.id),
    [mine.id],
  );
});

test('«оставить последние N» щадит самые свежие письма ИЗ ОТБОРА', () => {
  const messages = [
    message({ from: 'shop@example.com', date: daysAgo(400) }),
    message({ from: 'shop@example.com', date: daysAgo(300) }),
    message({ from: 'shop@example.com', date: daysAgo(200) }),
    // Свежее письмо в отбор не попадает по возрасту — и не должно
    // «съедать» право старых остаться.
    message({ from: 'shop@example.com', date: daysAgo(1) }),
  ];
  const chosen = selectForSweep(
    messages,
    { groupKey: groupKeyOf(messages[0] as ScannedMessage), olderThanDays: 30, keepLatest: 1 },
    NOW,
  );
  assert.equal(chosen.length, 2);
  assert.ok(!chosen.some((m) => m.date === daysAgo(200)));
});

test('отбор по размеру берёт только письма не легче порога', () => {
  const messages = [message({ size: 100 }), message({ size: 5000 }), message({ size: 5001 })];
  const chosen = selectForSweep(messages, { largerThanBytes: 5000 }, NOW);
  assert.equal(chosen.length, 2);
});

test('отбор по папке ограничивает уборку одной папкой', () => {
  const messages = [
    message({ folderId: 'inbox', folderRole: 'inbox' }),
    message({ folderId: 'archive', folderRole: 'archive' }),
  ];
  const chosen = selectForSweep(messages, { folderId: 'archive' }, NOW);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0]?.folderId, 'archive');
});

test('предпросмотр называет те же письма, что уедут: числа считаются по отбору', () => {
  const messages = [
    message({ size: 1000, date: daysAgo(100), seen: false }),
    message({ size: 3000, date: daysAgo(50), flagged: true }),
  ];
  const chosen = selectForSweep(messages, { olderThanDays: 30 }, NOW);
  const preview = summarizeSelection(chosen);
  assert.equal(preview.count, 2);
  assert.equal(preview.bytes, 4000);
  assert.equal(preview.unread, 1);
  assert.equal(preview.flagged, 1);
  assert.equal(preview.oldest, daysAgo(100));
  assert.equal(preview.newest, daysAgo(50));
});

test('пустой отбор — это нули, а не выдуманные даты', () => {
  const preview = summarizeSelection([]);
  assert.deepEqual(preview, { count: 0, bytes: 0, oldest: null, newest: null, unread: 0, flagged: 0 });
});

test('самые тяжёлые письма идут по убыванию размера', () => {
  const messages = [message({ size: 10 }), message({ size: 900 }), message({ size: 50 })];
  assert.deepEqual(
    heaviestMessages(messages, 2).map((m) => m.size),
    [900, 50],
  );
});
