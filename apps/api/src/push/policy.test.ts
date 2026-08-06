/**
 * Правила уведомлений: о чём молчим, когда молчим и что пишем в окне.
 *
 * Каждое правило проверяется в обе стороны: не только «спам не уведомляет»,
 * но и «обычное письмо уведомляет». Проверка в одну сторону тут бесполезна —
 * функция, которая всегда отвечает «не уведомлять», прошла бы половину
 * этого файла, и получился бы продукт, который молчит всегда.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNotificationView,
  clip,
  inQuietHours,
  minutesOfDay,
  notificationTag,
  plural,
  senderLabel,
  shouldNotify,
  subjectLabel,
  type ArrivedMessage,
  type NotificationItem,
} from './policy.js';
import { defaultNotificationPrefs, levelAtMost, type NotificationPrefs } from './types.js';

const OWN = ['test@mail.local'];

function prefs(patch: Partial<NotificationPrefs> = {}): NotificationPrefs {
  return { ...defaultNotificationPrefs(), enabled: true, ...patch };
}

function arrived(patch: Partial<ArrivedMessage> = {}): ArrivedMessage {
  return {
    id: 'inbox:296',
    folderId: 'inbox',
    from: { name: 'Пётр', address: 'petr@example.com' },
    subject: 'Договор',
    date: '2026-08-06T11:20:00.000Z',
    seen: false,
    ...patch,
  };
}

const NOON = new Date('2026-08-06T09:00:00.000Z'); // 12:00 в Москве

/* ------------------------------------------------------------------ */
/* О чём уведомлять                                                     */
/* ------------------------------------------------------------------ */

test('обычное письмо во «Входящих» уведомление даёт', () => {
  const decision = shouldNotify(arrived(), { prefs: prefs(), ownAddresses: OWN, now: NOON });
  assert.deepEqual(decision, { notify: true, reason: null });
});

test('выключенные уведомления не показываются даже для обычного письма', () => {
  const decision = shouldNotify(arrived(), {
    prefs: prefs({ enabled: false }),
    ownAddresses: OWN,
    now: NOON,
  });
  assert.deepEqual(decision, { notify: false, reason: 'notifications-off' });
});

test('спам и разложенное фильтрами по папкам не уведомляют', () => {
  for (const folderId of ['spam', 'archive', 'f-0YHRh9C10YLQsA']) {
    const decision = shouldNotify(arrived({ folderId }), {
      prefs: prefs(),
      ownAddresses: OWN,
      now: NOON,
    });
    assert.deepEqual(decision, { notify: false, reason: 'not-inbox' }, folderId);
  }
  // Обратный ход: «Входящие» с тем же письмом уведомляют
  assert.equal(
    shouldNotify(arrived({ folderId: 'inbox' }), { prefs: prefs(), ownAddresses: OWN, now: NOON })
      .notify,
    true,
  );
});

test('собственное отправленное письмо уведомления не даёт', () => {
  // Копия себе или возврат через список рассылки: письмо во «Входящих»,
  // но отправил его сам человек.
  const decision = shouldNotify(arrived({ from: { name: 'Я', address: 'TEST@Mail.Local' } }), {
    prefs: prefs(),
    ownAddresses: OWN,
    now: NOON,
  });
  assert.deepEqual(decision, { notify: false, reason: 'own-message' });

  // Обратный ход: чужое письмо с похожим адресом проходит
  assert.equal(
    shouldNotify(arrived({ from: { name: null, address: 'test@mail.local.example.com' } }), {
      prefs: prefs(),
      ownAddresses: OWN,
      now: NOON,
    }).notify,
    true,
  );
});

test('письмо, помеченное фильтром как прочитанное, молчит — но только по настройке', () => {
  const seen = arrived({ seen: true });
  assert.deepEqual(shouldNotify(seen, { prefs: prefs(), ownAddresses: OWN, now: NOON }), {
    notify: false,
    reason: 'already-read',
  });
  assert.equal(
    shouldNotify(seen, {
      prefs: prefs({ skipFiltered: false }),
      ownAddresses: OWN,
      now: NOON,
    }).notify,
    true,
  );
});

test('письмо без отправителя не приравнивается к своему', () => {
  // Пустой адрес совпал бы с пустым адресом в списке своих — и все
  // письма без From молча перестали бы уведомлять.
  const decision = shouldNotify(arrived({ from: null }), {
    prefs: prefs(),
    ownAddresses: ['', 'test@mail.local'],
    now: NOON,
  });
  assert.equal(decision.notify, true);
});

/* ------------------------------------------------------------------ */
/* Тихие часы                                                           */
/* ------------------------------------------------------------------ */

test('окно тихих часов через полночь захватывает обе стороны', () => {
  const quiet = { enabled: true, fromMinutes: 23 * 60, toMinutes: 7 * 60 };
  const zone = 'Europe/Moscow';
  const at = (iso: string) => inQuietHours(new Date(iso), quiet, zone);

  assert.equal(at('2026-08-06T20:30:00Z'), true, '23:30 по Москве');
  assert.equal(at('2026-08-06T01:00:00Z'), true, '04:00 по Москве');
  assert.equal(at('2026-08-06T03:59:00Z'), true, '06:59 по Москве');
  assert.equal(at('2026-08-06T04:00:00Z'), false, '07:00 по Москве — уже нет');
  assert.equal(at('2026-08-06T09:00:00Z'), false, 'полдень');
});

test('дневное окно тихих часов не выворачивается наизнанку', () => {
  const quiet = { enabled: true, fromMinutes: 10 * 60, toMinutes: 18 * 60 };
  const at = (iso: string) => inQuietHours(new Date(iso), quiet, 'Europe/Moscow');
  assert.equal(at('2026-08-06T09:00:00Z'), true, '12:00 внутри');
  assert.equal(at('2026-08-06T06:00:00Z'), false, '09:00 снаружи');
  assert.equal(at('2026-08-06T16:00:00Z'), false, '19:00 снаружи');
});

test('выключенные и вырожденные тихие часы никого не глушат', () => {
  assert.equal(
    inQuietHours(
      new Date('2026-08-06T20:30:00Z'),
      { enabled: false, fromMinutes: 0, toMinutes: 1440 },
      'Europe/Moscow',
    ),
    false,
  );
  // «С 8:00 до 8:00» — окно нулевой длины, а не круглые сутки молчания
  assert.equal(
    inQuietHours(
      new Date('2026-08-06T20:30:00Z'),
      { enabled: true, fromMinutes: 480, toMinutes: 480 },
      'Europe/Moscow',
    ),
    false,
  );
});

test('неизвестный часовой пояс не превращается в круглосуточную тишину', () => {
  // Ошибиться можно в две стороны, и они неравноценны: молча пропустить
  // письмо хуже, чем показать уведомление ночью.
  const quiet = { enabled: true, fromMinutes: 23 * 60, toMinutes: 7 * 60 };
  assert.equal(inQuietHours(new Date('2026-08-06T20:30:00Z'), quiet, null), false);
  assert.equal(inQuietHours(new Date('2026-08-06T20:30:00Z'), quiet, 'Марс/Олимп'), false);
  assert.equal(minutesOfDay(new Date(), 'Марс/Олимп'), null);
});

test('пояс считается по местному времени, а не по времени сервера', () => {
  const moment = new Date('2026-08-06T20:30:00Z');
  assert.equal(minutesOfDay(moment, 'Europe/Moscow'), 23 * 60 + 30);
  assert.equal(minutesOfDay(moment, 'UTC'), 20 * 60 + 30);
  assert.equal(minutesOfDay(moment, 'Asia/Vladivostok'), 6 * 60 + 30);
});

test('тихие часы уводят решение в отказ, а вне их письмо уведомляет', () => {
  const quiet = { enabled: true, fromMinutes: 23 * 60, toMinutes: 7 * 60 };
  const ctx = (iso: string) => ({
    prefs: prefs({ quietHours: quiet, timeZone: 'Europe/Moscow' }),
    ownAddresses: OWN,
    now: new Date(iso),
  });
  assert.deepEqual(shouldNotify(arrived(), ctx('2026-08-06T01:00:00Z')), {
    notify: false,
    reason: 'quiet-hours',
  });
  assert.equal(shouldNotify(arrived(), ctx('2026-08-06T09:00:00Z')).notify, true);
});

/* ------------------------------------------------------------------ */
/* Тексты                                                               */
/* ------------------------------------------------------------------ */

test('склонение числа писем по-русски', () => {
  const say = (n: number) => `${String(n)} ${plural(n, 'письмо', 'письма', 'писем')}`;
  assert.equal(say(1), '1 письмо');
  assert.equal(say(2), '2 письма');
  assert.equal(say(5), '5 писем');
  assert.equal(say(11), '11 писем');
  assert.equal(say(21), '21 письмо');
  assert.equal(say(114), '114 писем');
  assert.equal(say(22), '22 письма');
});

test('отправитель: имя, иначе адрес, иначе честная замена', () => {
  assert.equal(senderLabel({ name: 'Пётр', address: 'p@e.com' }), 'Пётр');
  assert.equal(senderLabel({ name: '   ', address: 'p@e.com' }), 'p@e.com');
  assert.equal(senderLabel(null), 'Неизвестный отправитель');
  assert.equal(subjectLabel('   '), '(без темы)');
  assert.equal(subjectLabel(' Договор '), 'Договор');
});

test('обрезка не рвёт слово посередине и добавляет многоточие', () => {
  assert.equal(clip('короткая строка', 40), 'короткая строка');
  assert.equal(clip('   лишние    пробелы   ', 40), 'лишние пробелы');
  const long = clip('Договор поставки оборудования на третий квартал', 20);
  assert.ok(long.endsWith('…'), long);
  assert.ok(long.length <= 21, long);
  assert.ok(!long.includes('оборуд…'), `слово разорвано: ${long}`);
});

/* ------------------------------------------------------------------ */
/* Вид окна на каждом уровне                                            */
/* ------------------------------------------------------------------ */

function item(patch: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'inbox:296',
    folderId: 'inbox',
    from: { name: 'Пётр', address: 'petr@example.com' },
    subject: 'Договор поставки',
    date: '2026-08-06T11:20:00.000Z',
    preview: 'Добрый день! Направляю подписанный договор на согласование.',
    summary: 'Пётр прислал подписанный договор и ждёт согласования до пятницы.',
    logoUrl: '/api/sender-logos/example.com/image?v=abc',
    ...patch,
  };
}

const KEY = '0123456789abcdef';

test('«только факт» не выдаёт ни отправителя, ни темы', () => {
  const view = buildNotificationView({ items: [item()], level: 'minimal', accountKey: KEY });
  assert.equal(view.title, 'Новое письмо');
  const text = `${view.title} ${view.body}`;
  assert.ok(!text.includes('Пётр'), text);
  assert.ok(!text.includes('Договор'), text);
  assert.ok(!text.includes('petr@example.com'), text);
  // Значка отправителя тоже быть не должно: адрес логотипа выдаёт домен
  assert.equal(view.icon, '/brand/notification-icon.png');
  // Кнопок «прочитано» и «в архив» нет: решать вслепую нечестно
  assert.deepEqual(
    view.actions.map((a) => a.action),
    ['open'],
  );
});

test('«отправитель и тема» показывает ровно их', () => {
  const view = buildNotificationView({ items: [item()], level: 'sender-subject', accountKey: KEY });
  assert.equal(view.title, 'Пётр');
  assert.equal(view.body, 'Договор поставки');
  // Первых фраз на этом уровне быть не должно
  assert.ok(!view.body.includes('Добрый день'), view.body);
});

test('«первые фразы» добавляют начало письма отдельной строкой', () => {
  const view = buildNotificationView({ items: [item()], level: 'preview', accountKey: KEY });
  assert.equal(view.title, 'Пётр');
  assert.ok(view.body.startsWith('Договор поставки\n'), view.body);
  assert.ok(view.body.includes('Направляю подписанный договор'), view.body);
  // Сводка ИИ сюда не просачивается
  assert.ok(!view.body.includes('ждёт согласования'), view.body);
});

test('«сводка ИИ» показывает сводку, а без неё честно откатывается к началу письма', () => {
  const withSummary = buildNotificationView({
    items: [item()],
    level: 'ai-summary',
    accountKey: KEY,
  });
  assert.ok(withSummary.body.includes('ждёт согласования'), withSummary.body);

  // Предел ИИ исчерпан — сводки нет. Пустое окно было бы хуже всего.
  const withoutSummary = buildNotificationView({
    items: [item({ summary: null })],
    level: 'ai-summary',
    accountKey: KEY,
    degraded: 'Предел расходов на ИИ исчерпан',
  });
  assert.ok(withoutSummary.body.includes('Направляю подписанный договор'), withoutSummary.body);
  assert.equal(withoutSummary.degraded, 'Предел расходов на ИИ исчерпан');

  // Ни сводки, ни текста — остаётся хотя бы тема
  const bare = buildNotificationView({
    items: [item({ summary: null, preview: null })],
    level: 'ai-summary',
    accountKey: KEY,
  });
  assert.equal(bare.body, 'Договор поставки');
});

test('щелчок ведёт в конкретное письмо, а не в почту вообще', () => {
  const view = buildNotificationView({ items: [item()], level: 'sender-subject', accountKey: KEY });
  assert.equal(view.url, '/inbox/inbox%3A296');
});

test('значок — логотип отправителя, запасной — наш', () => {
  const withLogo = buildNotificationView({
    items: [item()],
    level: 'sender-subject',
    accountKey: KEY,
  });
  assert.equal(withLogo.icon, '/api/sender-logos/example.com/image?v=abc');

  const withoutLogo = buildNotificationView({
    items: [item({ logoUrl: null })],
    level: 'sender-subject',
    accountKey: KEY,
  });
  assert.equal(withoutLogo.icon, '/brand/notification-icon.png');
  assert.equal(withoutLogo.badge, '/brand/notification-badge.png');
});

test('десять писем подряд дают одно окно, а не десять', () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    item({
      id: `inbox:${String(300 + i)}`,
      from: { name: `Отправитель ${String(i + 1)}`, address: `a${String(i)}@example.com` },
      subject: `Тема ${String(i + 1)}`,
    }),
  );
  const view = buildNotificationView({ items, level: 'sender-subject', accountKey: KEY });

  assert.equal(view.title, '10 новых писем');
  assert.ok(view.body.includes('Отправитель 1: Тема 1'), view.body);
  assert.ok(view.body.includes('и ещё 7 писем'), view.body);
  // Ярлык один и тот же — на нём и держится замена окна
  assert.equal(view.tag, notificationTag(KEY));
  assert.equal(
    buildNotificationView({ items: [items[0]!], level: 'sender-subject', accountKey: KEY }).tag,
    view.tag,
  );
  // В группе перечисляем не всех, но и не забываем ни одного письма
  assert.equal(view.ids.length, 10);
  assert.equal(view.url, '/inbox/');
  assert.deepEqual(
    view.actions.map((a) => a.action),
    ['open'],
  );
});

test('ярлык у разных ящиков разный: письма второго не затирают первый', () => {
  assert.notEqual(notificationTag('первый'), notificationTag('второй'));
});

test('группа на уровне «только факт» отправителей не перечисляет', () => {
  const items = [item(), item({ id: 'inbox:297', subject: 'Второе' })];
  const view = buildNotificationView({ items, level: 'minimal', accountKey: KEY });
  assert.equal(view.title, '2 новых письма');
  assert.ok(!view.body.includes('Пётр'), view.body);
});

test('пустой список не превращается в пустое окно', () => {
  // Chrome требует показать уведомление на каждое push-сообщение; молчание
  // он заменяет своим текстом «сайт обновился в фоне».
  const view = buildNotificationView({ items: [], level: 'preview', accountKey: KEY });
  assert.equal(view.title, 'Новое письмо');
  assert.ok(view.body.length > 0);
});

/* ------------------------------------------------------------------ */
/* Понижение уровня                                                     */
/* ------------------------------------------------------------------ */

test('уровень понижается до потолка и не поднимается выше выбранного', () => {
  assert.equal(levelAtMost('ai-summary', 'preview'), 'preview');
  assert.equal(levelAtMost('sender-subject', 'preview'), 'sender-subject');
  assert.equal(levelAtMost('minimal', 'ai-summary'), 'minimal');
  assert.equal(levelAtMost('ai-summary', 'ai-summary'), 'ai-summary');
});
