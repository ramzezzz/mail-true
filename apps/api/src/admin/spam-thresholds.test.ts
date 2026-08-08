/**
 * Пороги антиспама: порядок, объяснения и поиск противоречий.
 *
 * Проверки падают на прежнем поведении раздела, где пороги отдавались
 * голым словарём от контроллера:
 *
 *   1. Рубежи читаются по возрастанию строгости, а не в том порядке, в
 *      каком их вернул rspamd. Иначе «отказ» стоял перед «пометить», и
 *      понять, что с письмом произойдёт раньше, было нельзя.
 *   2. У каждого порога есть, что произойдёт с письмом и чем обернётся
 *      сдвиг в обе стороны. Число без этого настройкой не является.
 *   3. Противоречивый набор порогов называется вслух. Это единственное,
 *      что нельзя увидеть, глядя на числа по отдельности, а последствие —
 *      молча пропавшая почта.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeThresholds,
  findSpamAction,
  SPAM_ACTIONS,
  SPAM_ACTION_ORDER,
  thresholdProbeMessage,
  thresholdWarnings,
} from './spam-thresholds.js';

test('рубежи идут по возрастанию строгости, а не как их вернул контроллер', () => {
  // Ответ /actions приходит в своём порядке; читать пороги надо в том,
  // в каком письмо проходит рубежи.
  const items = describeThresholds({ reject: 15, greylist: 4, 'add header': 6 });
  assert.deepEqual(
    items.map((i) => i.id),
    ['greylist', 'add header', 'reject'],
  );
});

test('«ничего не делать» порогом не считается', () => {
  // Раньше «no action» стоял в списке как выключенная настройка, то есть
  // предлагал включить то, чего в rspamd не бывает.
  const items = describeThresholds({ 'no action': null, reject: 15 });
  assert.deepEqual(
    items.map((i) => i.id),
    ['reject'],
  );
});

test('незнакомое действие показывается, а не прячется', () => {
  // Спрятанный порог продолжает действовать на письма — молча.
  const items = describeThresholds({ 'quarantine mail': 9 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.value, 9);
  assert.match(items[0]?.effect ?? '', /после выпуска панели/u);
});

test('выключенный порог отдаётся как null и объясняет, что это значит', () => {
  const items = describeThresholds({ greylist: null });
  assert.equal(items[0]?.value, null);
  assert.ok((items[0]?.off ?? '').length > 20);
});

test('у каждого действия сказано, что произойдёт с письмом и кто это увидит', () => {
  for (const action of SPAM_ACTIONS) {
    assert.ok(action.effect.length > 40, `${action.id}: нет описания последствия`);
    assert.ok(action.visible.length > 10, `${action.id}: непонятно, кто это заметит`);
    assert.ok(action.off.length > 10, `${action.id}: непонятно, что значит «выключено»`);
  }
  // Порядок в каталоге и порядок показа обязаны совпадать: иначе один из
  // них однажды поправят, а другой забудут.
  assert.deepEqual(
    SPAM_ACTIONS.map((a) => a.id),
    [...SPAM_ACTION_ORDER],
  );
});

test('у порогов, которые двигают руками, есть куда двигать и чем это грозит', () => {
  // «Временный отказ» сюда не входит намеренно: его выставляют модули, а
  // не набранные баллы, и коридора значений у него нет.
  for (const id of ['greylist', 'add header', 'reject']) {
    const action = findSpamAction(id);
    assert.ok(action, `нет описания действия ${id}`);
    assert.ok(action.higher.length > 20, `${id}: не сказано, что будет при более мягком пороге`);
    assert.ok(action.lower.length > 20, `${id}: не сказано, что будет при более строгом пороге`);
  }
  assert.deepEqual(findSpamAction('add header')?.advice, [4, 8]);
  assert.equal(findSpamAction('soft reject')?.advice, null);
});

test('значение вне обычного коридора помечается, но не объявляется ошибкой', () => {
  const [item] = describeThresholds({ 'add header': 2 });
  assert.equal(item?.unusual, true);
  const [normal] = describeThresholds({ 'add header': 6 });
  assert.equal(normal?.unusual, false);
});

test('порог пометки не ниже порога отказа — папка «Спам» не наполнится никогда', () => {
  // Самое опасное сочетание: по числам всё выглядит настроенным, а
  // письма при этом либо проходят, либо теряются для получателя совсем.
  const warnings = thresholdWarnings({ 'add header': 15, reject: 15 });
  assert.ok(warnings.some((w) => /папка «Спам» не наполнится никогда/u.test(w)));
});

test('серый список выше пометки — задержка не сработает', () => {
  const warnings = thresholdWarnings({ greylist: 8, 'add header': 6, reject: 15 });
  assert.ok(warnings.some((w) => /задержка не сработает/u.test(w)));
});

test('выключенная пометка и выключенный отказ названы вслух', () => {
  const warnings = thresholdWarnings({ 'add header': null, reject: null });
  assert.ok(warnings.some((w) => /Пометка спама выключена/u.test(w)));
  assert.ok(warnings.some((w) => /Отказ в приёме выключен/u.test(w)));
});

test('согласованный набор порогов замечаний не даёт', () => {
  // Иначе список замечаний превратится в постоянный фон, который перестают
  // читать — и настоящее противоречие в нём потеряется.
  assert.deepEqual(thresholdWarnings({ greylist: null, 'add header': 6, reject: 15 }), []);
});

test('пробное письмо годится для конверта и не притворяется настоящим', () => {
  const message = thresholdProbeMessage('example.org');
  assert.match(message, /^From: postmaster@example\.org\r\n/u);
  assert.match(message, /Subject: Mail\.True/u);
  // Пустая строка отделяет заголовки от тела: без неё rspamd прочитал бы
  // всё письмо как одну шапку.
  assert.ok(message.includes('\r\n\r\n'));
  // Ни одной ссылки: измеряются пороги, а не оценка, и лишние сработавшие
  // правила тут только мешали бы.
  assert.ok(!/https?:\/\//u.test(message));
});
