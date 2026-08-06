/**
 * Проверки правил именования меток и — главное — отделения пользовательских
 * меток от служебных ключевых слов продукта.
 *
 * Каждая проверка идёт обратным ходом: мало убедиться, что своя метка
 * прошла, — нужно убедиться, что служебное слово НЕ прошло, и что оно не
 * прошло ни в каком написании.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLabelKey,
  isServiceKeyword,
  isUserLabelKey,
  LABEL_KEY_PREFIX,
  normalizeLabelName,
  RESERVED_KEYWORDS,
  slugifyLabelName,
  userLabelsOf,
  type UserLabel,
} from './labels.js';

const label = (key: string, name: string, position = 0): UserLabel => ({
  key,
  name,
  color: 'blue',
  position,
});

/* ------------------------------------------------------------------ */
/* Ключ метки                                                          */
/* ------------------------------------------------------------------ */

test('имя по-русски превращается в латинский ключ', () => {
  assert.equal(slugifyLabelName('Оплатить'), 'oplatit');
  assert.equal(slugifyLabelName('Спросить у юриста'), 'sprosit-u-yurista');
  // Обратный ход: в ключе не остаётся ни пробелов, ни кириллицы — иначе
  // ключевое слово IMAP было бы недопустимым атомом.
  assert.match(slugifyLabelName('Счёт №5 (срочно!)'), /^[a-z0-9-]+$/);
});

test('имя без букв всё равно даёт непустой ключ', () => {
  // Ключевого слова длины ноль не бывает; без запасного имени метка
  // с именем из одних смайликов уронила бы создание.
  assert.equal(slugifyLabelName('!!! ???'), 'label');
  assert.equal(slugifyLabelName(''), 'label');
});

test('ключ уникален в пределах ящика', () => {
  const first = buildLabelKey('Счета', []);
  const second = buildLabelKey('Счёта', [first]);
  assert.equal(first, `${LABEL_KEY_PREFIX}scheta`);
  assert.equal(second, `${LABEL_KEY_PREFIX}scheta-2`);
  assert.notEqual(first, second);
});

test('ключ метки всегда с приставкой и всегда пользовательский', () => {
  const key = buildLabelKey('Финансы', []);
  assert.ok(key.startsWith(LABEL_KEY_PREFIX));
  assert.ok(isUserLabelKey(key));
  assert.equal(isServiceKeyword(key), false);
});

test('имя, совпадающее с категорией продукта, ключом с ней не сталкивается', () => {
  // Метка с именем «finance» получает `mt-finance`, а чип категории живёт
  // словом `finance`. Приставка нужна именно для этого: чтобы категория,
  // заведённая продуктом ЗАВТРА, не отобрала пометку у человека.
  const key = buildLabelKey('finance', []);
  assert.equal(key, `${LABEL_KEY_PREFIX}finance`);
  assert.equal(isServiceKeyword(key), false);
  assert.equal(isServiceKeyword('finance'), true);
});

test('имя схлопывает пробелы и обрезается по длине', () => {
  assert.equal(normalizeLabelName('  Оплатить   срочно  '), 'Оплатить срочно');
  assert.equal(normalizeLabelName('я'.repeat(200)).length, 64);
});

/* ------------------------------------------------------------------ */
/* Служебные слова                                                     */
/* ------------------------------------------------------------------ */

test('все служебные слова продукта опознаются служебными', () => {
  for (const keyword of RESERVED_KEYWORDS) {
    assert.equal(isServiceKeyword(keyword), true, `не опознано служебным: ${keyword}`);
    assert.equal(isUserLabelKey(keyword), false, `прошло как метка: ${keyword}`);
  }
});

test('системные флаги IMAP не метки', () => {
  for (const flag of ['\\Seen', '\\Flagged', '\\Deleted', '\\Draft', '\\Answered']) {
    assert.equal(isServiceKeyword(flag), true, flag);
    assert.equal(isUserLabelKey(flag), false, flag);
  }
});

test('регистр не помогает выдать служебное слово за метку', () => {
  // Dovecot сравнивает ключевые слова без учёта регистра: если бы проверка
  // была чувствительна к нему, запрет обходился бы одной заглавной буквой,
  // и `$snoozed` снял бы пометку возврата из «Отложенных».
  for (const written of ['$snoozed', '$SNOOZED', '$Snoozed', 'Reliable', 'FINANCE']) {
    assert.equal(isServiceKeyword(written), true, written);
  }
});

test('чужое ключевое слово без нашей приставки меткой не считается', () => {
  // Слово, которое поставила другая почтовая программа. Показать его
  // пилюлей нельзя — у нас нет ни имени для него, ни цвета.
  assert.equal(isUserLabelKey('important'), false);
  assert.equal(isUserLabelKey('$label1'), false);
  // И править его наши маршруты тоже не станут.
  assert.equal(isUserLabelKey('mt-Оплатить'), false, 'кириллица в ключе недопустима');
  assert.equal(isUserLabelKey('mt-с пробелом'), false);
});

/* ------------------------------------------------------------------ */
/* Отбор меток письма                                                  */
/* ------------------------------------------------------------------ */

test('из ключевых слов письма берутся только заведённые метки', () => {
  const dictionary = [label('mt-oplatit', 'Оплатить', 1), label('mt-yurist', 'Юрист', 0)];
  const found = userLabelsOf(
    // В письме вперемешку: служебная пометка возврата, чип категории,
    // признак надёжного отправителя, чужое слово и две наши метки.
    ['$Snoozed', 'finance', 'reliable', 'mt-oplatit', 'chuzhoe-slovo', 'mt-yurist'],
    dictionary,
  );
  assert.deepEqual(
    found.map((l) => l.key),
    ['mt-yurist', 'mt-oplatit'],
    'порядок должен быть по position, а не по порядку в письме',
  );
});

test('метка, удалённая из справочника, в письме не показывается', () => {
  // Обратный ход к удалению без снятия с писем: ключевое слово в письме
  // осталось, но имени и цвета у него больше нет — рисовать нечего.
  const found = userLabelsOf(['mt-oplatit'], []);
  assert.deepEqual(found, []);
});
