/**
 * Юнит-тесты сравнения письма с правилом.
 *
 * Это сравнение должно совпадать с тем, что делает Sieve при доставке:
 * иначе правило будет вести себя на старой почте не так, как на новой,
 * и объяснить это пользователю будет нечем.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCondition, matchesRule, parseHeaderBlock, type MatchableMessage } from './apply.js';
import { DEFAULT_ACTIONS, type FilterRule } from './types.js';

const MESSAGE: MatchableMessage = {
  from: 'Бухгалтерия <buh@example.com>',
  to: 'Иван <ivan@mail.local>',
  cc: 'all@example.com',
  subject: 'Счёт № 42 за август',
  resentFrom: 'old@legacy.example',
  resentTo: 'list@example.com',
  size: 250 * 1024,
};

function rule(partial: Partial<FilterRule>): FilterRule {
  return {
    id: 1,
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

test('«содержит» не учитывает регистр', () => {
  assert.ok(matchesCondition(MESSAGE, { field: 'from', op: 'contains', value: 'BUH@example.com' }));
  assert.ok(matchesCondition(MESSAGE, { field: 'subject', op: 'contains', value: 'счёт' }));
  assert.ok(!matchesCondition(MESSAGE, { field: 'subject', op: 'contains', value: 'акт' }));
});

test('отрицания', () => {
  assert.ok(matchesCondition(MESSAGE, { field: 'subject', op: 'not-contains', value: 'акт' }));
  assert.ok(!matchesCondition(MESSAGE, { field: 'subject', op: 'not-contains', value: 'счёт' }));
});

test('«равно» сравнивает поле целиком', () => {
  assert.ok(matchesCondition(MESSAGE, { field: 'cc', op: 'is', value: 'all@example.com' }));
  assert.ok(!matchesCondition(MESSAGE, { field: 'cc', op: 'is', value: 'all@' }));
});

test('шаблон :matches понимает * и ?', () => {
  assert.ok(matchesCondition(MESSAGE, { field: 'from', op: 'matches', value: '*@example.com>' }));
  assert.ok(matchesCondition(MESSAGE, { field: 'cc', op: 'matches', value: 'all@example.co?' }));
  assert.ok(!matchesCondition(MESSAGE, { field: 'cc', op: 'matches', value: 'all@example.c' }));
});

test('шаблон не даёт спецсимволам регулярных выражений сработать', () => {
  const msg: MatchableMessage = { ...MESSAGE, subject: 'a+b' };
  assert.ok(matchesCondition(msg, { field: 'subject', op: 'matches', value: 'a+b' }));
  assert.ok(!matchesCondition(msg, { field: 'subject', op: 'matches', value: 'ab' }));
});

test('переадресованные поля берутся из Resent-*', () => {
  assert.ok(
    matchesCondition(MESSAGE, { field: 'resent-from', op: 'contains', value: 'legacy.example' }),
  );
  assert.ok(matchesCondition(MESSAGE, { field: 'resent-to', op: 'is', value: 'list@example.com' }));
});

test('размер сравнивается в килобайтах', () => {
  assert.ok(matchesCondition(MESSAGE, { field: 'size', op: 'greater', value: '100' }));
  assert.ok(!matchesCondition(MESSAGE, { field: 'size', op: 'greater', value: '500' }));
  assert.ok(matchesCondition(MESSAGE, { field: 'size', op: 'less', value: '500' }));
  assert.ok(!matchesCondition(MESSAGE, { field: 'size', op: 'less', value: '100' }));
});

test('«все условия» и «любое условие»', () => {
  const conditions = [
    { field: 'from', op: 'contains', value: 'buh@example.com' } as const,
    { field: 'subject', op: 'contains', value: 'акт' } as const,
  ];
  assert.ok(!matchesRule(MESSAGE, rule({ matchMode: 'all', conditions: [...conditions] })));
  assert.ok(matchesRule(MESSAGE, rule({ matchMode: 'any', conditions: [...conditions] })));
});

test('правило без условий подходит любому письму', () => {
  assert.ok(matchesRule(MESSAGE, rule({})));
});

test('parseHeaderBlock: разворачивает перенос строки внутри заголовка', () => {
  const headers = parseHeaderBlock(
    'Resent-From: first@example.com\r\nResent-To: a@example.com,\r\n b@example.com\r\n',
  );
  assert.deepEqual(headers.get('resent-from'), ['first@example.com']);
  assert.deepEqual(headers.get('resent-to'), ['a@example.com, b@example.com']);
});
