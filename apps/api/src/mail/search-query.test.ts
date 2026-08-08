/**
 * Язык поисковых запросов (packages/shared/src/search.ts).
 *
 * Проверки живут здесь, а не рядом с грамматикой, по прозаической причине:
 * в общем пакете нет запускалки проверок, а грамматику надо гонять на каждой
 * сборке API — именно API превращает её в условия IMAP SEARCH.
 *
 * Раньше вся поисковая строка целиком уходила в IMAP как поиск по тексту.
 * Поэтому `от:волкова` не находило ничего: сервер честно искал письмо, где
 * встречается сама подстрока «от:волкова». То есть попытка уточнить запрос
 * делала поиск хуже, чем его отсутствие: `волкова` находило письмо,
 * `от:волкова` — ноль.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeSearch,
  FTS_MIN_TERM,
  ftsSafeText,
  hasOperators,
  isFlagWord,
  isOperatorName,
  parseSearch,
  SEARCH_OPERATORS,
} from '@mail-true/shared';

test('оператор «от» вынимается из строки и не остаётся текстом', () => {
  const q = parseSearch('от:волкова');
  assert.equal(q.from, 'волкова');
  assert.equal(q.text, null, 'иначе сервер искал бы подстроку «от:волкова» в теле');
});

test('латинские названия операторов работают наравне с русскими', () => {
  assert.equal(parseSearch('from:ivanov').from, 'ivanov');
  assert.equal(parseSearch('to:sales').to, 'sales');
  assert.equal(parseSearch('subject:contract').subject, 'contract');
  assert.equal(parseSearch('cc:boss').cc, 'boss');
  assert.equal(parseSearch('filename:.pdf').filename, '.pdf');
  assert.equal(parseSearch('folder:Newsletters').folder, 'Newsletters');
});

test('операторы и свободные слова уживаются в одной строке', () => {
  const q = parseSearch('от:петрова договор аренды');
  assert.equal(q.from, 'петрова');
  assert.equal(q.text, 'договор аренды');
});

test('кавычки держат несколько слов вместе', () => {
  const q = parseSearch('тема:"годовой отчёт" срочно');
  assert.equal(q.subject, 'годовой отчёт');
  assert.equal(q.text, 'срочно');
});

test('незакрытая кавычка не отказ, а недопечатанная строка', () => {
  // Человек ещё печатает. Отказывать на полпути — значит требовать
  // дописать кавычку прежде, чем показать хоть что-нибудь.
  const q = parseSearch('тема:"годовой отчёт');
  assert.equal(q.subject, 'годовой отчёт');
  assert.equal(q.text, null);
});

test('слова-признаки узнаются без двоеточия', () => {
  assert.equal(parseSearch('непрочитанные').seen, false);
  assert.equal(parseSearch('важные').flagged, true);
  assert.equal(parseSearch('unread').seen, false);
  // и не остаются мусором в тексте поиска
  assert.equal(parseSearch('непрочитанные').text, null);
});

test('«есть:вложение» просит отбор по вложениям', () => {
  assert.equal(parseSearch('есть:вложение').hasAttachment, true);
  assert.equal(parseSearch('has:attachment').hasAttachment, true);
  assert.equal(
    parseSearch('есть:луна').hasAttachment,
    false,
    'неизвестное значение — это просто слова',
  );
  assert.equal(parseSearch('есть:луна').text, 'есть:луна');
});

test('имя файла подразумевает вложение', () => {
  // Иначе `файл:.pdf` вело бы себя как «письма, где где-то встречается .pdf».
  const q = parseSearch('файл:.pdf');
  assert.equal(q.filename, '.pdf');
  assert.equal(q.hasAttachment, true);
});

test('«папка:» разбирается, но условием поиска не становится', () => {
  // Применяет её вызывающий: у IMAP папка — это то, что открыто до поиска.
  // Здесь важно другое: она не должна уйти в полнотекстовый поиск словами.
  const q = parseSearch('папка:Рассылки скидки');
  assert.equal(q.folder, 'Рассылки');
  assert.equal(q.text, 'скидки');
});

test('даты разбираются в календарные границы', () => {
  const q = parseSearch('после:2026-01-15 до:2026-08-01');
  assert.equal(q.since?.toISOString(), '2026-01-15T00:00:00.000Z');
  assert.equal(q.before?.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('несуществующая дата не молчит, а остаётся словами поиска', () => {
  // «2026-02-31» при наивном разборе молча переехало бы на 3 марта, и человек
  // искал бы не тот месяц, ничего об этом не зная.
  const q = parseSearch('после:2026-02-31');
  assert.equal(q.since, null);
  assert.equal(q.text, 'после:2026-02-31');
});

test('срок «старше» и «новее» считается календарём', () => {
  const now = new Date('2026-08-06T12:34:56.000Z');
  assert.equal(parseSearch('старше:1г', now).before?.toISOString(), '2025-08-06T00:00:00.000Z');
  assert.equal(parseSearch('новее:7д', now).since?.toISOString(), '2026-07-30T00:00:00.000Z');
  assert.equal(parseSearch('новее:2нед', now).since?.toISOString(), '2026-07-23T00:00:00.000Z');
  assert.equal(parseSearch('старше:3мес', now).before?.toISOString(), '2026-05-06T00:00:00.000Z');
  assert.equal(parseSearch('older_than:2y', now).before?.toISOString(), '2024-08-06T00:00:00.000Z');
});

test('срок с непонятной единицей — это просто слова', () => {
  const q = parseSearch('старше:1попугая');
  assert.equal(q.before, null);
  assert.equal(q.text, 'старше:1попугая');
});

test('размер письма понимает килобайты и мегабайты', () => {
  assert.equal(parseSearch('больше:5м').larger, 5 * 1024 * 1024);
  assert.equal(parseSearch('меньше:100к').smaller, 100 * 1024);
  assert.equal(parseSearch('larger:1mb').larger, 1024 * 1024);
  assert.equal(parseSearch('больше:2048').larger, 2048);
  // Ноль и мусор размером не считаются
  assert.equal(parseSearch('больше:0').larger, null);
  assert.equal(parseSearch('больше:много').text, 'больше:много');
});

test('адрес с двоеточием не ломает разбор', () => {
  // Двоеточие встречается в обычном тексте не реже, чем в операторах:
  // время «14:30» в теме, «Re:» в начале. Объявлять такое ошибкой нельзя.
  const q = parseSearch('встреча 14:30');
  assert.equal(q.text, 'встреча 14:30');
  assert.equal(hasOperators(q), false);
});

test('запрос из разбора риска остаётся собой', () => {
  // Ровно тот пример, которым описан риск в docs/gaps.md, п. 7.
  const q = parseSearch('Договор № 452/26: правки');
  assert.equal(hasOperators(q), false);
  assert.equal(q.text, 'Договор № 452/26: правки');
});

/* ------------------------------------------------------------------ */
/* Обломки слов, которых в полнотекстовом индексе нет                  */
/* ------------------------------------------------------------------ */

/*
 * Проверено живьём на стенде (Dovecot + dovecot-fts-xapian, partial=3):
 * письмо с темой «Договор № 452/26: правки» лежит в ящике и находится
 * запросами «Договор», «452», «правки» и «Договор 452 правки» — но НЕ
 * находится собственной темой. Причина одна: Xapian делит «452/26» на
 * «452» и «26» и требует обе части, а слова «26» в индексе нет — оно
 * короче трёх букв. Здесь закреплено то самое превращение, после
 * которого запрос становится выполнимым.
 */

test('обломок короче индексируемого слова из запроса убирается', () => {
  assert.equal(ftsSafeText('Договор № 452/26: правки'), 'Договор № 452 правки');
  assert.equal(FTS_MIN_TERM, 3, 'то же число стоит в настройке Dovecot partial=');
});

test('слово без разделителя внутри не трогают', () => {
  // Оно ищется целиком и прекрасно находится — делить нечего.
  assert.equal(ftsSafeText('щщщ26'), 'щщщ26');
  assert.equal(ftsSafeText('Договор 26'), 'Договор 26');
  assert.equal(ftsSafeText('счёт 2026 год'), 'счёт 2026 год');
});

test('слово, у которого годных обломков нет, остаётся собой', () => {
  // Выбросить его целиком значило бы молча РАСШИРИТЬ запрос: «встреча
  // 14:30» превратилась бы во «встреча» и показала бы все встречи.
  assert.equal(ftsSafeText('встреча 14:30'), 'встреча 14:30');
  assert.equal(ftsSafeText('из-за'), 'из-за');
  assert.equal(ftsSafeText('№'), '№');
});

test('слово, где все обломки годные, тоже остаётся собой', () => {
  // Такое движок разбирает правильно сам — вмешиваться незачем.
  assert.equal(ftsSafeText('test@mail.local'), 'test@mail.local');
  assert.equal(ftsSafeText('отчёт-2026.pdf'), 'отчёт-2026.pdf');
});

test('неизвестный оператор — это просто слова', () => {
  const q = parseSearch('приоритет:высокий смета');
  assert.equal(hasOperators(q), false);
  assert.equal(q.text, 'приоритет:высокий смета');
});

test('оператор без значения — это просто слово', () => {
  const q = parseSearch('от:');
  assert.equal(q.from, null);
  assert.equal(q.text, 'от:');
});

test('повторный оператор уточняет, а не заменяет', () => {
  assert.equal(parseSearch('от:иван от:петров').from, 'иван петров');
});

test('пустой запрос ничего не просит', () => {
  const q = parseSearch('   ');
  assert.equal(q.text, null);
  assert.equal(hasOperators(q), false);
});

test('регистр названия оператора не важен', () => {
  assert.equal(parseSearch('От:Волкова').from, 'Волкова');
  assert.equal(parseSearch('FROM:Ivanov').from, 'Ivanov');
});

test('чипы показывают, во что превратился запрос', () => {
  const chips = describeSearch(parseSearch('от:волкова есть:вложение договор'));
  assert.deepEqual(
    chips.map((c) => `${c.title}: ${c.value}`),
    ['Отправитель: волкова', 'Вложения: есть', 'Слова: договор'],
  );
});

test('подсказка обещает только те операторы, которые разбираются', () => {
  /*
   * Подсказка, обещающая оператор, которого разборщик не знает, — это ложь
   * интерфейса, и заметить её можно только руками. Здесь она заметна сама.
   */
  for (const item of SEARCH_OPERATORS) {
    const colon = item.sample.indexOf(':');
    if (colon < 0) {
      // Слово-признак: должно разбираться без двоеточия
      assert.equal(
        isFlagWord(item.sample),
        true,
        `слово-признак «${item.sample}» из подсказки не разбирается`,
      );
      assert.equal(
        hasOperators(parseSearch(item.sample)),
        true,
        `слово-признак «${item.sample}» из подсказки ничего не даёт`,
      );
      continue;
    }
    assert.equal(
      isOperatorName(item.sample.slice(0, colon)),
      true,
      `оператор «${item.sample}» из подсказки не разбирается`,
    );
    assert.equal(
      hasOperators(parseSearch(item.sample)),
      true,
      `пример «${item.sample}» из подсказки ничего не даёт`,
    );
    // Латинский синоним из подсказки тоже обязан работать
    const latin = item.latin.replace(/:$/u, '');
    if (item.latin.endsWith(':')) {
      assert.equal(isOperatorName(latin), true, `синоним «${item.latin}» не разбирается`);
    }
  }
});
