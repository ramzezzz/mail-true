/**
 * Юнит-тесты перевода правил фильтрации в Sieve и обратного разбора.
 *
 * Проверяется то, что ломается молча: экранирование (кавычка в теме
 * письма не должна разваливать файл правил), порядок правил и команд,
 * защита от спама и полный оборот «правило → Sieve → правило».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsToCommands,
  buildSieveScript,
  conditionToTest,
  needsRegexMatch,
  parseSieveScript,
  quoteSieveString,
  requiredExtensions,
  ruleToTest,
  tokenizeSieve,
  valueToRegex,
} from './sieve.js';
import { DEFAULT_ACTIONS, defaultMailSettings, type FilterActions, type FilterRule } from './types.js';

function rule(partial: Partial<FilterRule> & { id: number }): FilterRule {
  return {
    name: '',
    position: 0,
    enabled: true,
    auto: false,
    matchMode: 'all',
    conditions: [],
    actions: { ...DEFAULT_ACTIONS, forwardTo: [] },
    ...partial,
  };
}

function actions(partial: Partial<FilterActions>): FilterActions {
  return { ...DEFAULT_ACTIONS, forwardTo: [], ...partial };
}

/* ---------------------------------------------------------------- */
/* Экранирование                                                     */
/* ---------------------------------------------------------------- */

test('quoteSieveString: кавычка и обратная косая экранируются', () => {
  assert.equal(quoteSieveString('обычный'), '"обычный"');
  assert.equal(quoteSieveString('он сказал "да"'), '"он сказал \\"да\\""');
  assert.equal(quoteSieveString('C:\\temp'), '"C:\\\\temp"');
  assert.equal(quoteSieveString('и "то" и \\это\\'), '"и \\"то\\" и \\\\это\\\\"');
});

test('quoteSieveString: управляющие символы удаляются, перевод строки остаётся', () => {
  const nul = String.fromCharCode(0);
  const cr = String.fromCharCode(13);
  assert.equal(quoteSieveString(`а${nul}б${cr}в`), '"абв"');
  assert.equal(quoteSieveString('строка\nвторая'), '"строка\nвторая"');
});

test('экранирование не даёт закрыть строку и подставить команду', () => {
  const injected = '"; discard; #';
  const built = conditionToTest({ field: 'subject', op: 'contains', value: injected });
  assert.equal(built, 'header :contains "subject" "\\"; discard; #"');
  // Разбор возвращает исходное значение целиком, а не обрывок.
  const tokens = tokenizeSieve(built);
  const last = tokens[tokens.length - 1];
  assert.equal(last?.kind, 'string');
  assert.equal(last?.kind === 'string' ? last.value : '', injected);
});

/* ---------------------------------------------------------------- */
/* Условия                                                           */
/* ---------------------------------------------------------------- */

test('conditionToTest: поля и операторы', () => {
  assert.equal(
    conditionToTest({ field: 'from', op: 'contains', value: 'boss@example.com' }),
    'header :contains "from" "boss@example.com"',
  );
  assert.equal(
    conditionToTest({ field: 'cc', op: 'is', value: 'a@b' }),
    'header :is "cc" "a@b"',
  );
  // Кириллица переводится в :regex: компаратор по умолчанию сворачивает
  // регистр только латиницы (см. valueToRegex и тесты ниже)
  assert.equal(
    conditionToTest({ field: 'subject', op: 'not-contains', value: 'реклама' }),
    'not header :regex "subject" "(р|Р)(е|Е)(к|К)(л|Л)(а|А)(м|М)(а|А)"',
  );
  assert.equal(
    conditionToTest({ field: 'resent-from', op: 'matches', value: '*@old.example' }),
    'header :matches "resent-from" "*@old.example"',
  );
  assert.equal(
    conditionToTest({ field: 'resent-to', op: 'contains', value: 'list@x' }),
    'header :contains "resent-to" "list@x"',
  );
});

test('conditionToTest: размер переводится в :over/:under килобайт', () => {
  assert.equal(conditionToTest({ field: 'size', op: 'greater', value: '500' }), 'size :over 500K');
  assert.equal(conditionToTest({ field: 'size', op: 'less', value: '100' }), 'size :under 100K');
});

test('ruleToTest: защита от спама добавляется, если не «применять к спаму»', () => {
  const r = rule({
    id: 1,
    conditions: [{ field: 'from', op: 'contains', value: 'a@b' }],
  });
  assert.equal(
    ruleToTest(r),
    'allof (not header :is "X-Spam" "Yes", header :contains "from" "a@b")',
  );

  const spam = rule({
    id: 2,
    conditions: [{ field: 'from', op: 'contains', value: 'a@b' }],
    actions: actions({ applyToSpam: true }),
  });
  assert.equal(ruleToTest(spam), 'header :contains "from" "a@b"');
});

test('ruleToTest: режим «любое условие» даёт anyof внутри allof', () => {
  const r = rule({
    id: 3,
    matchMode: 'any',
    conditions: [
      { field: 'from', op: 'contains', value: 'a@b' },
      { field: 'subject', op: 'contains', value: 'счёт' },
    ],
  });
  assert.equal(
    ruleToTest(r),
    'allof (not header :is "X-Spam" "Yes", anyof (header :contains "from" "a@b", ' +
      'header :regex "subject" "(с|С)(ч|Ч)(ё|Ё)(т|Т)"))',
  );
});

test('ruleToTest: правило без условий применяется ко всем письмам', () => {
  const all = rule({ id: 4, actions: actions({ applyToSpam: true }) });
  assert.equal(ruleToTest(all), 'true');
  const notSpam = rule({ id: 5 });
  assert.equal(ruleToTest(notSpam), 'not header :is "X-Spam" "Yes"');
});

/* ---------------------------------------------------------------- */
/* Действия                                                          */
/* ---------------------------------------------------------------- */

test('actionsToCommands: порядок команд — флаги, пересылка, автоответ, папка, stop', () => {
  const cmds = actionsToCommands(
    actions({
      folder: 'Работа',
      markRead: true,
      flag: true,
      forwardTo: ['copy@example.com'],
      autoReply: { subject: 'Меня нет', text: 'Вернусь в понедельник', days: 3 },
      continueFiltering: false,
    }),
  );
  assert.deepEqual(cmds, [
    'addflag "\\\\Seen";',
    'addflag "\\\\Flagged";',
    'redirect :copy "copy@example.com";',
    'vacation :days 3 :subject "Меня нет" "Вернусь в понедельник";',
    'fileinto :create "Работа";',
    'stop;',
  ]);
});

test('actionsToCommands: «продолжать другие фильтры» означает отсутствие stop', () => {
  const cmds = actionsToCommands(actions({ folder: 'Счета', continueFiltering: true }));
  assert.deepEqual(cmds, ['fileinto :create "Счета";']);
});

test('requiredExtensions: используемое правилами плюс обязательные fileinto/mailbox', () => {
  // fileinto и mailbox стоят всегда: их использует блок раскладки спама,
  // который дописывается в КАЖДЫЙ личный скрипт.
  assert.deepEqual(requiredExtensions([rule({ id: 1, actions: actions({ folder: 'X' }) })]), [
    'fileinto',
    'mailbox',
  ]);
  assert.deepEqual(
    requiredExtensions([
      rule({ id: 1, actions: actions({ markRead: true, forwardTo: ['a@b'] }) }),
    ]),
    ['fileinto', 'mailbox', 'imap4flags', 'copy'],
  );
  const settings = defaultMailSettings('u@mail.local');
  settings.autoReply = { ...settings.autoReply, enabled: true, until: '2026-09-01T00:00:00Z' };
  assert.deepEqual(requiredExtensions([], settings), [
    'fileinto',
    'mailbox',
    'vacation',
    'date',
    'relational',
  ]);
});

/*
 * Ящик, у которого включён ОДИН автоответчик и нет ни одного правила.
 * Именно на нём ломалось всё: require без fileinto, а блок раскладки спама
 * с `fileinto :create "Spam"` в конце — Pigeonhole отказывался от скрипта
 * целиком, и спам с оценкой 9.40 при пороге 6 ложился во «Входящие».
 */
test('buildSieveScript: скрипт с одним автоответчиком объявляет fileinto для блока спама', () => {
  const settings = defaultMailSettings('u@mail.local');
  settings.autoReply = { ...settings.autoReply, enabled: true, text: 'В отпуске' };
  const script = buildSieveScript([], { accountEmail: 'u@mail.local', settings });

  assert.ok(script.includes('fileinto :create "Spam";'), 'блок раскладки спама на месте');
  const requireLine = script.split('\n').find((l) => l.startsWith('require ['));
  assert.ok(requireLine, 'в скрипте есть строка require');
  for (const used of ['fileinto', 'mailbox', 'vacation']) {
    assert.ok(requireLine.includes(`"${used}"`), `require объявляет ${used}`);
  }
});

/*
 * Общая проверка, а не частный случай: каждая команда, которую мы пишем
 * в файл, должна быть объявлена в require. Иначе скрипт не собирается,
 * а Dovecot молча остаётся без раскладки почты у этого ящика.
 */
test('buildSieveScript: любая использованная команда объявлена в require', () => {
  const settings = defaultMailSettings('u@mail.local');
  settings.autoReply = { ...settings.autoReply, enabled: true, text: 'Ответ' };
  const variants = [
    buildSieveScript([]),
    buildSieveScript([], { settings }),
    buildSieveScript([rule({ id: 1, actions: actions({ markRead: true }) })]),
    buildSieveScript([rule({ id: 1, actions: actions({ forwardTo: ['a@b'] }) })]),
    buildSieveScript([rule({ id: 1, actions: actions({ folder: 'Счета' }) })], { settings }),
  ];
  // Команда -> расширение, которое её вводит (RFC 5228 §2.10.5).
  const needs: Record<string, string> = {
    fileinto: 'fileinto',
    addflag: 'imap4flags',
    setflag: 'imap4flags',
    vacation: 'vacation',
  };
  for (const script of variants) {
    const declared = /require \[(.*)\];/.exec(script)?.[1] ?? '';
    for (const [command, extension] of Object.entries(needs)) {
      if (!new RegExp(`(^|\\s)${command}\\b`, 'm').test(script)) continue;
      assert.ok(
        declared.includes(`"${extension}"`),
        `команда ${command} использована, но расширение ${extension} не объявлено: ${declared}`,
      );
    }
    // :create у fileinto вводится расширением mailbox
    if (script.includes('fileinto :create')) {
      assert.ok(declared.includes('"mailbox"'), `:create без расширения mailbox: ${declared}`);
    }
  }
});

/* ---------------------------------------------------------------- */
/* Сборка файла                                                      */
/* ---------------------------------------------------------------- */

test('buildSieveScript: порядок правил соответствует position', () => {
  const script = buildSieveScript([
    rule({ id: 1, name: 'Третье', position: 2, conditions: [{ field: 'from', op: 'contains', value: 'c' }], actions: actions({ folder: 'C' }) }),
    rule({ id: 2, name: 'Первое', position: 0, conditions: [{ field: 'from', op: 'contains', value: 'a' }], actions: actions({ folder: 'A' }) }),
    rule({ id: 3, name: 'Второе', position: 1, conditions: [{ field: 'from', op: 'contains', value: 'b' }], actions: actions({ folder: 'B' }) }),
  ]);
  const order = [...script.matchAll(/# === Правило: (.+?) ===/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Первое', 'Второе', 'Третье']);
  // Порядок внутри файла — это и есть порядок применения.
  assert.ok(script.indexOf('"A"') < script.indexOf('"B"'));
  assert.ok(script.indexOf('"B"') < script.indexOf('"C"'));
});

test('buildSieveScript: выключенное правило в файл не попадает', () => {
  const script = buildSieveScript([
    rule({ id: 1, name: 'Включено', actions: actions({ folder: 'A' }) }),
    rule({ id: 2, name: 'Выключено', enabled: false, position: 1, actions: actions({ folder: 'B' }) }),
  ]);
  assert.match(script, /Включено/);
  assert.doesNotMatch(script, /Выключено/);
  assert.doesNotMatch(script, /"B"/);
});

test('buildSieveScript: require перечисляет расширения один раз и в фиксированном порядке', () => {
  const script = buildSieveScript([
    rule({ id: 1, actions: actions({ folder: 'A', markRead: true }) }),
    rule({ id: 2, position: 1, actions: actions({ folder: 'B', flag: true }) }),
  ]);
  const requires = script.match(/^require \[.*\];$/m);
  assert.ok(requires);
  assert.equal(requires[0], 'require ["fileinto", "mailbox", "imap4flags"];');
});

test('buildSieveScript: одинаковые правила дают побайтово одинаковый файл', () => {
  const rules = [
    rule({ id: 1, name: 'Р', conditions: [{ field: 'to', op: 'is', value: 'me@x' }], actions: actions({ folder: 'F' }) }),
  ];
  assert.equal(buildSieveScript(rules), buildSieveScript(rules));
});

test('buildSieveScript: автоответчик выносится отдельным блоком со сроком действия', () => {
  const settings = defaultMailSettings('u@mail.local');
  settings.autoReply = {
    enabled: true,
    subject: 'В отпуске',
    text: 'Отвечу после 20 августа',
    from: '2026-08-01T00:00:00Z',
    until: '2026-08-20T00:00:00Z',
    days: 5,
  };
  const script = buildSieveScript([], { settings });
  assert.match(script, /# === Автоответчик ===/);
  assert.match(script, /currentdate :value "ge" "date" "2026-08-01"/);
  assert.match(script, /currentdate :value "le" "date" "2026-08-20"/);
  assert.match(script, /vacation :days 5 :subject "В отпуске" "Отвечу после 20 августа";/);
});

/* ---------------------------------------------------------------- */
/* Обратный разбор                                                   */
/* ---------------------------------------------------------------- */

test('parseSieveScript: полный оборот правило -> Sieve -> правило', () => {
  const source = [
    rule({
      id: 1,
      name: 'Счета от бухгалтерии',
      position: 0,
      conditions: [
        { field: 'from', op: 'contains', value: 'buh@example.com' },
        { field: 'subject', op: 'not-contains', value: 'черновик' },
      ],
      actions: actions({
        folder: 'Счета',
        markRead: true,
        flag: true,
        forwardTo: ['boss@example.com'],
        continueFiltering: false,
      }),
    }),
    rule({
      id: 2,
      name: 'Крупные письма',
      position: 1,
      matchMode: 'any',
      conditions: [
        { field: 'size', op: 'greater', value: '2048' },
        { field: 'cc', op: 'is', value: 'all@example.com' },
      ],
      actions: actions({ folder: 'Большие', applyToSpam: true }),
    }),
  ];
  const parsed = parseSieveScript(buildSieveScript(source));
  assert.equal(parsed.length, 2);

  assert.equal(parsed[0]?.name, 'Счета от бухгалтерии');
  assert.equal(parsed[0]?.matchMode, 'all');
  assert.deepEqual(parsed[0]?.conditions, source[0]?.conditions);
  assert.deepEqual(parsed[0]?.actions, source[0]?.actions);

  assert.equal(parsed[1]?.name, 'Крупные письма');
  assert.equal(parsed[1]?.matchMode, 'any');
  assert.deepEqual(parsed[1]?.conditions, source[1]?.conditions);
  assert.deepEqual(parsed[1]?.actions, source[1]?.actions);
});

test('parseSieveScript: значения с кавычками переживают оборот', () => {
  const source = [
    rule({
      id: 7,
      name: 'Кавычки',
      conditions: [{ field: 'subject', op: 'contains', value: 'счёт № "42" \\ итог' }],
      actions: actions({ folder: 'Папка "важное"' }),
    }),
  ];
  const parsed = parseSieveScript(buildSieveScript(source));
  assert.equal(parsed[0]?.conditions[0]?.value, 'счёт № "42" \\ итог');
  assert.equal(parsed[0]?.actions.folder, 'Папка "важное"');
});

test('parseSieveScript: автоответ правила восстанавливается', () => {
  const source = [
    rule({
      id: 8,
      name: 'Автоответ',
      conditions: [{ field: 'to', op: 'is', value: 'support@mail.local' }],
      actions: actions({ autoReply: { subject: 'Принято', text: 'Ответим в течение дня', days: 2 } }),
    }),
  ];
  const parsed = parseSieveScript(buildSieveScript(source));
  assert.deepEqual(parsed[0]?.actions.autoReply, {
    subject: 'Принято',
    text: 'Ответим в течение дня',
    days: 2,
  });
});

test('parseSieveScript: блок общего автоответчика не считается правилом', () => {
  const settings = defaultMailSettings('u@mail.local');
  settings.autoReply = { ...settings.autoReply, enabled: true, text: 'Меня нет' };
  const script = buildSieveScript(
    [rule({ id: 9, name: 'Одно', actions: actions({ folder: 'A' }) })],
    { settings },
  );
  const parsed = parseSieveScript(script);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.name, 'Одно');
});

test('parseSieveScript: чужой скрипт с незнакомыми командами не роняет разбор', () => {
  const parsed = parseSieveScript(`
require ["fileinto", "envelope"];
if envelope :is "to" "me@x" {
    discard;
}
# === Правило: Наше ===
if allof (not header :is "X-Spam" "Yes", header :contains "from" "a@b") {
    fileinto :create "Наша";
}
`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]?.name, 'Наше');
  assert.equal(parsed[1]?.actions.folder, 'Наша');
  assert.equal(parsed[1]?.actions.applyToSpam, false);
});

test('buildSieveScript: блок раскладки спама идёт после правил и не считается правилом', () => {
  // Здесь раньше стояло утверждение, что у обычного правила блока раскладки
  // спама быть НЕ должно, — то есть тест закреплял дефект. Пока личный скрипт
  // лишь дополнял глобальный, это было верно; после перевода глобального
  // фильтра в запасные личный скрипт его заменяет, и отсутствие блока молча
  // отключало антиспам любому, кто завёл хоть одно правило.
  //
  // Тест, закрепляющий ошибку, хуже отсутствия теста: он даёт уверенность
  // и мешает заметить регресс. Проверяем теперь только то, что действительно
  // должно быть верным — порядок и то, что блок не путается с правилами.
  const сСпамом = buildSieveScript([
    rule({ id: 1, name: 'Спамное', actions: actions({ folder: 'A', applyToSpam: true }) }),
  ]);
  assert.match(сСпамом, /# === Спам ===/);
  // Блок идёт ПОСЛЕ правил: сначала правило получает шанс забрать письмо.
  assert.ok(сСпамом.indexOf('=== Правило: Спамное ===') < сСпамом.indexOf('# === Спам ==='));
  assert.match(сСпамом, /fileinto :create "Spam";/);
  // Разбор не должен считать этот блок правилом пользователя.
  const parsed = parseSieveScript(сСпамом);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.name, 'Спамное');
});

/* ---------------------------------------------------------------- */
/* Находка 5: правило с кириллицей не срабатывало при другом регистре */
/* ---------------------------------------------------------------- */

/**
 * Проверено на живом стенде: правило «ОТЧЁТ» не ловило письмо с темой
 * «Квартальный отчёт за август», правило «отчёт» ловило, а правило
 * «REPORT» ловило «Monthly report». Причина — способ сравнения по
 * умолчанию (`i;ascii-casemap`) сворачивает регистр только для латиницы.
 *
 * `i;unicode-casemap` Pigeonhole не знает, `set :lower` кириллицу не
 * трогает, скобочные классы `[Оо]` в :regex разбираются побайтово —
 * работает только перечисление вариантов через `|` (проверено sieve-test).
 */
test('условие с кириллицей переводится в регистронезависимый :regex', () => {
  assert.equal(
    conditionToTest({ field: 'subject', op: 'contains', value: 'ОТЧЁТ' }),
    'header :regex "subject" "(О|о)(Т|т)(Ч|ч)(Ё|ё)(Т|т)"',
  );
});

test('латиница остаётся на обычном сравнении: с ней компаратор справляется сам', () => {
  assert.equal(
    conditionToTest({ field: 'subject', op: 'contains', value: 'REPORT' }),
    'header :contains "subject" "REPORT"',
  );
  assert.equal(needsRegexMatch('REPORT'), false);
  assert.equal(needsRegexMatch('отчёт'), true);
  assert.equal(needsRegexMatch('№ 5'), false, 'символ без регистра сам по себе ничего не требует');
});

test('valueToRegex: «совпадает» и «соответствует» получают якоря и подстановки', () => {
  assert.equal(valueToRegex('Да', 'is'), '^(Д|д)(а|А)$');
  assert.equal(valueToRegex('Счёт*', 'matches'), '^(С|с)(ч|Ч)(ё|Ё)(т|Т).*$');
  assert.equal(valueToRegex('Да?', 'matches'), '^(Д|д)(а|А).$');
});

test('valueToRegex: особые символы регулярного выражения экранируются', () => {
  // Иначе значение «цена (руб.)» стало бы группой и сломало компиляцию
  assert.equal(valueToRegex('ц.(1)', 'contains'), String.raw`(ц|Ц)\.\(1\)`);
});

test('в require попадает regex — и только когда он нужен', () => {
  const cyr = rule({
    id: 1,
    conditions: [{ field: 'subject', op: 'contains', value: 'ОТЧЁТ' }],
    actions: actions({ folder: 'Отчёты' }),
  });
  assert.deepEqual(requiredExtensions([cyr]), ['fileinto', 'mailbox', 'regex']);

  const latin = rule({
    id: 2,
    conditions: [{ field: 'subject', op: 'contains', value: 'report' }],
    actions: actions({ folder: 'Reports' }),
  });
  assert.deepEqual(requiredExtensions([latin]), ['fileinto', 'mailbox']);
  assert.match(buildSieveScript([cyr]), /require \[.*"regex"\];/);
});

test('условие с кириллицей переживает оборот в файл и обратно', () => {
  const source = [
    rule({
      id: 1,
      name: 'Отчёты',
      position: 0,
      conditions: [
        { field: 'subject', op: 'contains', value: 'ОТЧЁТ' },
        { field: 'from', op: 'is', value: 'Бухгалтерия' },
        { field: 'to', op: 'matches', value: 'Отдел*' },
      ],
      actions: actions({ folder: 'Отчёты' }),
    }),
  ];
  const parsed = parseSieveScript(buildSieveScript(source));
  assert.deepEqual(parsed[0]?.conditions, source[0]?.conditions);
});

/**
 * Регистр — единственное, что должно быть безразлично. Буква «ё» не
 * равна «е»: правило «отчет» ловить «отчёт» не обязано и не должно.
 */
test('регистронезависимость не превращается в «ё равно е»', () => {
  const built = conditionToTest({ field: 'subject', op: 'contains', value: 'отчёт' });
  assert.equal(built.includes('е'), false, 'в выражении не должно появиться «е»');
});

test('раскладка спама есть в скрипте даже без правил «применять к спаму»', () => {
  // Главный случай. Раньше блок дописывался только когда среди правил есть
  // хоть одно с пометкой «применять к спаму». Это осталось от прежней схемы,
  // где глобальный фильтр спама работал сам через sieve_before. После перевода
  // его в sieve_default личный скрипт глобальный ЗАМЕНЯЕТ — и любое обычное
  // правило молча отключало антиспам целиком.
  //
  // Проверено на живом стенде: чистый ящик кладёт спам в «Спам», но стоит
  // завести одно правило про совсем другое письмо — и спам с оценкой 10.45
  // остаётся во «Входящих».
  const script = buildSieveScript([
    rule({ id: 1, name: 'Про счета', actions: actions({ folder: 'Счета', applyToSpam: false }) }),
  ]);
  assert.ok(script.includes('=== Спам ==='), 'блок раскладки спама обязан быть всегда');
  assert.ok(
    script.includes('fileinto :create "Spam"'),
    'спам должен раскладываться в папку «Спам»',
  );
});

test('раскладка спама есть и когда правил вовсе нет', () => {
  const script = buildSieveScript([]);
  assert.ok(script.includes('fileinto :create "Spam"'));
});

test('правило «применять к спаму» стоит выше блока раскладки', () => {
  // Иначе спам разложится раньше, чем сработает правило, и правило станет
  // недостижимым — ровно то, ради чего вся эта конструкция и делалась.
  const script = buildSieveScript([
    rule({ id: 1, name: 'Спамное', actions: actions({ folder: 'Ловушка', applyToSpam: true }) }),
  ]);
  const posRule = script.indexOf('Ловушка');
  const posSpam = script.indexOf('=== Спам ===');
  assert.ok(posRule >= 0 && posSpam >= 0, 'оба блока должны присутствовать');
  assert.ok(posRule < posSpam, 'правило должно стоять до общей раскладки спама');
});
