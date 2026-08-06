/**
 * Включаемый файл заглушённых цепочек.
 *
 * Проверяется не «строка собралась», а то, из-за чего эту возможность
 * страшно делать: файл попадает в ДОСТАВКУ ящика, и ошибка в нём роняет
 * компиляцию всего личного скрипта — вместе с правилами, автоответчиком
 * и раскладкой спама разом. Поэтому здесь закреплены три вещи:
 *
 *   - в файл не попадает ничего, кроме заведомо безопасных Message-ID;
 *   - личный скрипт подключает файл ВСЕГДА и всегда объявляет `include`,
 *     иначе Pigeonhole отказывается от скрипта целиком;
 *   - пустой список даёт пустую строку — команду убрать файл, а не
 *     условие без значений (его компилятор не примет).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSieveScript, MUTED_INCLUDE_NAME } from './sieve.js';
import { buildMutedSieveScript, MUTED_MAX_IDS, usableMutedId } from './sieve-muted.js';
import { DEFAULT_ACTIONS } from './types.js';

test('личный скрипт подключает файл заглушённых цепочек всегда', () => {
  // Ни одного правила, ни автоответчика — и всё равно include на месте.
  const script = buildSieveScript([]);
  assert.match(script, /require \[[^\]]*"include"/);
  assert.ok(script.includes(`include :optional :personal "${MUTED_INCLUDE_NAME}";`));
});

test('include стоит ДО правил пользователя и до раскладки спама', () => {
  const script = buildSieveScript([
    {
      id: 1,
      name: 'Счета',
      enabled: true,
      auto: false,
      position: 0,
      matchMode: 'all',
      conditions: [{ field: 'from', op: 'contains', value: 'billing@example.com' }],
      actions: { ...DEFAULT_ACTIONS, folder: 'Счета' },
    },
  ]);
  const include = script.indexOf('include :optional');
  const rule = script.indexOf('# === Правило: Счета ===');
  const spam = script.indexOf('# === Спам ===');
  assert.ok(include > 0 && rule > 0 && spam > 0);
  assert.ok(include < rule, 'заглушённые цепочки должны проверяться раньше правил');
  assert.ok(rule < spam);
});

test('пустой список — это пустая строка, а не условие без значений', () => {
  assert.equal(buildMutedSieveScript([]), '');
  // Ни одного годного идентификатора — то же самое.
  assert.equal(buildMutedSieveScript(['', '   ', '<>']), '');
});

test('идентификаторы попадают в файл в угловых скобках', () => {
  const script = buildMutedSieveScript(['abc@example.com', '<def@example.com>']);
  assert.ok(script.includes('"<abc@example.com>"'));
  assert.ok(script.includes('"<def@example.com>"'));
  // Без скобок «abc@example.com» совпал бы и с чужим «xyzabc@example.com».
  assert.ok(!script.includes('"abc@example.com"'));
});

test('файл кладёт письмо в «Заглушённые», помечает прочитанным и останавливает разбор', () => {
  const script = buildMutedSieveScript(['abc@example.com']);
  assert.ok(script.includes('require ["fileinto", "mailbox", "imap4flags"];'));
  assert.ok(script.includes('addflag "\\\\Seen";'));
  assert.ok(script.includes('fileinto :create "Muted";'));
  assert.ok(script.includes('stop;'));
  assert.ok(script.includes('header :contains ["References", "In-Reply-To"]'));
});

test('повторы отбрасываются без учёта регистра', () => {
  const script = buildMutedSieveScript(['ABC@example.com', 'abc@example.com']);
  assert.equal(script.match(/example\.com/g)?.length, 1);
});

test('в файл не проходит ничего, кроме печатного ASCII без кавычек и скобок', () => {
  // Кириллица: не ошибка отправителя, так и не наше дело её сравнивать.
  // Условие с не-ASCII у нас переводится в :regex (см. sieve.ts) — здесь
  // этого не будет никогда, такой идентификатор просто отбрасывается.
  assert.equal(usableMutedId('письмо@example.com'), null);
  assert.equal(usableMutedId('a"b@example.com'), null);
  assert.equal(usableMutedId('a\\b@example.com'), null);
  assert.equal(usableMutedId('a b@example.com'), null);
  assert.equal(usableMutedId('a<b@example.com'), null);
  assert.equal(usableMutedId('a\nb@example.com'), null);
  assert.equal(usableMutedId('x'.repeat(260)), null);
  assert.equal(usableMutedId('<ok-1@example.com>'), 'ok-1@example.com');

  const script = buildMutedSieveScript(['письмо@example.com', 'ok@example.com']);
  assert.ok(script.includes('"<ok@example.com>"'));
  assert.ok(!script.includes('письмо@example.com'));
});

test('список обрезается по потолку: доставка не должна дорожать без предела', () => {
  const many = Array.from({ length: MUTED_MAX_IDS + 50 }, (_, i) => `id-${String(i)}@example.com`);
  const script = buildMutedSieveScript(many);
  assert.equal(script.match(/@example\.com/g)?.length, MUTED_MAX_IDS);
  // Обрезается ХВОСТ: первыми в списке идут самые свежие записи.
  assert.ok(script.includes('"<id-0@example.com>"'));
  assert.ok(!script.includes(`"<id-${String(MUTED_MAX_IDS + 10)}@example.com>"`));
});
