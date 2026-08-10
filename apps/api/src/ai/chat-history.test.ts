/**
 * История разговора с помощником: чем длинный ответ ломал весь разговор.
 *
 * Дефект был не в одном запросе, а в НЕОБРАТИМОСТИ: история живёт у
 * клиента и уезжает на сервер целиком с каждым вопросом, схема
 * применяется ко всей истории сразу. Ответ помощника длиннее предела
 * вставал в историю — и каждый следующий вопрос отбивался «Некорректные
 * данные запроса». Навсегда: убрать бракованную реплику было нечем.
 * Починка одна — закрыть окно и потерять разговор.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_TURN_MAX_CHARS,
  CHAT_TURN_HARD_MAX_CHARS,
  chatHistorySchema,
} from './chat-history.js';

const long = (n: number): string => 'а'.repeat(n);

test('длинный ответ помощника обрезается, а не ломает разговор', () => {
  const parsed = chatHistorySchema.parse({
    messages: [
      { role: 'user', content: 'Разбери подробно' },
      { role: 'assistant', content: long(CHAT_TURN_MAX_CHARS + 500) },
      { role: 'user', content: 'А короче?' },
    ],
  });

  assert.equal(parsed.messages.length, 3);
  const answer = parsed.messages[1]?.content ?? '';
  assert.equal(answer.length, CHAT_TURN_MAX_CHARS + 1, 'обрезано ровно до предела плюс многоточие');
  assert.ok(answer.endsWith('…'), 'обрыв должен быть виден модели, а не выглядеть законченным');
  // Обратный ход: короткие реплики не трогаются вовсе.
  assert.equal(parsed.messages[2]?.content, 'А короче?');
});

test('слишком длинный вопрос человека отбивается словами, а не обрезается', () => {
  /*
   * Молча укоротить написанное нельзя: модель ответит не на то, о чём
   * спросили, а человек этого не заметит. Поэтому вопрос — единственное,
   * что отбивается, и отбивается с разбором.
   */
  const result = chatHistorySchema.safeParse({
    messages: [{ role: 'user', content: long(CHAT_TURN_MAX_CHARS + 1) }],
  });

  assert.equal(result.success, false);
  const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
  assert.match(message, /Вопрос длиннее/);
  assert.match(message, new RegExp(String(CHAT_TURN_MAX_CHARS)), 'предел обязан быть назван');
});

test('у реплики остаётся жёсткий потолок: запрос без границы принимать нельзя', () => {
  // Без него двадцать реплик по мегабайту прошли бы разбор и легли в
  // память процесса — до всякой обрезки.
  const result = chatHistorySchema.safeParse({
    messages: [{ role: 'assistant', content: long(CHAT_TURN_HARD_MAX_CHARS + 1) }],
  });
  assert.equal(result.success, false);
});

test('пустая история и разговор длиннее двадцати реплик не принимаются', () => {
  assert.equal(chatHistorySchema.safeParse({ messages: [] }).success, false);
  const many = Array.from({ length: 21 }, () => ({ role: 'user' as const, content: 'да' }));
  assert.equal(chatHistorySchema.safeParse({ messages: many }).success, false);
});
