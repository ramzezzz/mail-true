/**
 * Что уходит в браузер по потоковому маршруту черновика.
 *
 * Поток сериализовал событие ЦЕЛИКОМ — вместе с полем `details`, про
 * которое в типе AiError прямо написано «технические подробности для
 * журнала; в интерфейс не выводится». Туда кладётся сырое тело ответа
 * поставщика (до 500 символов), в том числе при 401 и 403, где сервисы
 * охотно пишут подробности про ключ, организацию и внутренние адреса.
 * Обычные маршруты берут из отказа только `message` (см. errors.ts),
 * а потоковый отдавал всё.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiError } from '@mail-true/ai';
import { publicStreamEvent } from './routes.js';

const rejected: AiError = {
  kind: 'not-configured',
  message: 'Сервис ИИ отклонил ключ доступа',
  retryable: false,
  status: 401,
  details:
    '{"error":{"message":"Incorrect API key provided: sk-proj-AbCd***. ' +
    'Organization org-mailtrue-internal","type":"invalid_request_error"}}',
};

void test('подробности отказа поставщика в поток не уходят', () => {
  const sent = JSON.stringify(publicStreamEvent({ type: 'error', error: rejected }));

  assert.ok(!sent.includes('details'), 'поле details не должно попадать в поток');
  assert.ok(!sent.includes('sk-proj-AbCd'), 'кусок ключа доступа ушёл в браузер');
  assert.ok(!sent.includes('org-mailtrue-internal'), 'внутреннее имя организации ушло в браузер');

  // При этом человеку остаётся всё, что ему нужно: причина по-русски,
  // код и понимание, есть ли смысл повторять.
  const event = JSON.parse(sent) as { type: string; error: Record<string, unknown> };
  assert.equal(event.type, 'error');
  assert.equal(event.error['message'], 'Сервис ИИ отклонил ключ доступа');
  assert.equal(event.error['kind'], 'not-configured');
  assert.equal(event.error['status'], 401);
  assert.equal(event.error['retryable'], false);
});

void test('обычные события потока не трогаются', () => {
  const delta = { type: 'delta', text: 'Добрый день!' };
  assert.deepEqual(publicStreamEvent(delta), delta);

  const disclosure = { type: 'disclosure', disclosure: { totalChars: 120 } };
  assert.deepEqual(publicStreamEvent(disclosure), disclosure);

  const done = { type: 'done', text: 'готово', usage: { totalTokens: 12 } };
  assert.deepEqual(publicStreamEvent(done), done);
});

test('админский разговор чистит событие тем же отбором', () => {
  /*
   * Пользовательский поток гонит событие через publicStreamEvent, а
   * админский писал его как есть. У отказа поставщика в `details` лежит
   * сырое тело ответа до 500 символов — для 401/403 туда попадает кусок
   * ключа доступа и внутренние имена организации. Право на раздел есть
   * только у владельца, но ключ не предназначен для показа и ему: он
   * вводится один раз и больше нигде не отдаётся.
   *
   * Проверяем сам источник — код маршрута: событие обязано проходить
   * через отбор, а не улетать в поток напрямую.
   */
  const source = readFileSync(
    fileURLToPath(new URL('./admin.ts', import.meta.url).href.replace('/dist/', '/src/')),
    'utf8',
  );
  const stream = source.slice(
    source.indexOf('for await'),
    source.indexOf('Разговор администратора'),
  );
  assert.match(stream, /publicStreamEvent\(event\)/, 'событие должно чиститься перед отправкой');
  assert.ok(!/JSON\.stringify\(event\)/.test(stream), 'сырое событие в поток попадать не должно');
});
