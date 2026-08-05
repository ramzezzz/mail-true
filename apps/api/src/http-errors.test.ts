import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { ApiError, NotFoundError, SendRejectedError } from './errors.js';
import {
  mapFrameworkError,
  notFoundBody,
  rateLimitedError,
  registerErrorHandling,
  retryAfterRu,
} from './http-errors.js';

function fastifyError(code: string, statusCode: number, message: string): unknown {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * Главный случай. Ошибки самого Fastify выпадали мимо контракта: наружу
 * уходили английские тексты и коды, которых в docs/api.md нет вовсе.
 */
test('коды Fastify переводятся в коды контракта с русским текстом', () => {
  const cases: Array<[string, number, number, string]> = [
    ['FST_ERR_CTP_BODY_TOO_LARGE', 413, 413, 'PAYLOAD_TOO_LARGE'],
    ['FST_REQ_FILE_TOO_LARGE', 413, 413, 'FILE_TOO_LARGE'],
    ['FST_ERR_CTP_EMPTY_JSON_BODY', 400, 400, 'BAD_REQUEST'],
    ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 415, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['FST_ERR_MAX_PARAM_LENGTH', 404, 400, 'BAD_REQUEST'],
    ['FST_ERR_VALIDATION', 400, 400, 'VALIDATION'],
  ];
  for (const [code, incoming, status, expected] of cases) {
    const mapped = mapFrameworkError(fastifyError(code, incoming, 'Request body is too large'));
    assert.equal(mapped.status, status, code);
    assert.equal(mapped.body.error, expected, code);
    assert.match(mapped.body.message, /[а-яё]/i, `${code}: текст должен быть по-русски`);
    assert.equal(/[a-z]{4,}/i.test(mapped.body.error), true);
    assert.equal(mapped.body.message.includes('FST_'), false);
  }
});

test('ограничение частоты отдаёт RATE_LIMITED, а не текст плагина', () => {
  const err = Object.assign(new Error('Rate limit exceeded, retry in 1 minute'), {
    statusCode: 429,
  });
  const mapped = mapFrameworkError(err);
  assert.equal(mapped.status, 429);
  assert.equal(mapped.body.error, 'RATE_LIMITED');
  assert.match(mapped.body.message, /Слишком много запросов/);
});

test('тело ответа «не найдено» — та же форма, что и у остальных ошибок', () => {
  const body = notFoundBody();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
  assert.equal(body.error, 'NOT_FOUND');
  // Раньше сюда прилетало {statusCode, error: 'Not Found', message} —
  // интерфейс читает поле error как КОД и показывал «Not Found»
  assert.equal(body.error.includes(' '), false);
});

test('ошибка со статусом 404 без нашего класса тоже приводится к контракту', () => {
  const mapped = mapFrameworkError(Object.assign(new Error('Not Found'), { statusCode: 404 }));
  assert.equal(mapped.body.error, 'NOT_FOUND');
  assert.match(mapped.body.message, /[а-яё]/i);
});

test('ошибки zod дают VALIDATION с подробностями', () => {
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse({ email: 'не почта' });
  assert.equal(parsed.success, false);
  const mapped = mapFrameworkError(parsed.success ? null : parsed.error);
  assert.equal(mapped.status, 400);
  assert.equal(mapped.body.error, 'VALIDATION');
  assert.ok(Array.isArray(mapped.body.details));
});

test('наши ошибки проходят как есть, вместе с подробностями', () => {
  const mapped = mapFrameworkError(
    new SendRejectedError('Получатель отклонён', { rejected: ['нет@mail.local'] })
  );
  assert.equal(mapped.status, 400);
  assert.equal(mapped.body.error, 'SEND_REJECTED');
  assert.deepEqual(mapped.body.details, { rejected: ['нет@mail.local'] });

  const notFound = mapFrameworkError(new NotFoundError('Папка не найдена: нет'));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error, 'NOT_FOUND');
  assert.equal(notFound.body.details, undefined);
});

test('внутренняя ошибка не выносит наружу подробностей', () => {
  const mapped = mapFrameworkError(new Error('connect ECONNREFUSED 10.0.0.1:5432'));
  assert.equal(mapped.status, 500);
  assert.equal(mapped.body.error, 'INTERNAL');
  assert.equal(mapped.body.message.includes('ECONNREFUSED'), false);
});

test('любая ошибка приводится к паре полей error+message', () => {
  const samples: unknown[] = [
    new Error('что-то'),
    fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413, 'too large'),
    new ApiError(409, 'CONFLICT', 'Уже есть'),
    Object.assign(new Error('rate'), { statusCode: 429 }),
    null,
    'строка',
  ];
  for (const sample of samples) {
    const { body } = mapFrameworkError(sample);
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
    assert.ok(body.error.length > 0);
    assert.ok(body.message.length > 0);
  }
});

/* ------------------------------------------------------------------ */
/* Находка 9: сообщение об ограничении частоты было наполовину         */
/*            английским                                               */
/* ------------------------------------------------------------------ */

/**
 * Живой ответ до исправления: «Слишком много запросов, попробуйте через
 * 32 seconds». `@fastify/rate-limit` подставляет строку из пакета `ms`,
 * то есть по-английски; численное `context.ttl` склоняем сами.
 */
test('ожидание в ограничении частоты пишется по-русски и склоняется', () => {
  assert.equal(retryAfterRu(32_000), '32 секунды');
  assert.equal(retryAfterRu(1000), '1 секунду');
  assert.equal(retryAfterRu(21_000), '21 секунду');
  assert.equal(retryAfterRu(11_000), '11 секунд');
  assert.equal(retryAfterRu(5000), '5 секунд');
  assert.equal(retryAfterRu(0), '1 секунду');
  assert.equal(retryAfterRu(60_000), '1 минуту');
  assert.equal(retryAfterRu(125_000), '3 минуты');
  assert.equal(retryAfterRu(15 * 60_000), '15 минут');
  // Ни одного английского слова
  for (const ms of [1000, 32_000, 125_000]) {
    assert.equal(/[a-z]/i.test(retryAfterRu(ms)), false, `в тексте осталась латиница: ${retryAfterRu(ms)}`);
  }
});

/**
 * Сквозная проверка со СТОЯЩИМ плагином: важно не только склонение, но и
 * то, что мы берём из его контекста именно `ttl`, а не английское `after`.
 */
test('ответ 429 приходит целиком по-русски', async () => {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  await app.register(rateLimit, {
    max: 1,
    timeWindow: 60_000,
    errorResponseBuilder: (_request, context) => rateLimitedError(context),
  });
  registerErrorHandling(app);
  app.get('/пример', async () => ({ ok: true }));
  await app.ready();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/пример' })).statusCode, 200);
    const res = await app.inject({ method: 'GET', url: '/пример' });
    assert.equal(res.statusCode, 429);
    const body = res.json() as { error: string; message: string };
    assert.equal(body.error, 'RATE_LIMITED');
    assert.match(body.message, /^Слишком много запросов, попробуйте через \d+ (секунд|минут)/);
    assert.equal(
      /[a-z]/i.test(body.message),
      false,
      `в сообщении осталась латиница: ${body.message}`
    );
  } finally {
    await app.close();
  }
});

/**
 * Отказ при теле не в UTF-8 должен называть кодировку.
 *
 * Fastify поднимает FST_ERR_CTP_INVALID_CONTENT_LENGTH в двух разных случаях:
 * длина тела не совпала с заголовком — и тело не в UTF-8 (тогда разбор меняет
 * недопустимые байты на символ замены, длина в байтах растёт, и несовпадение
 * находит уже сверка длины).
 *
 * Прежний текст говорил только про длину. Человек шёл проверять заголовок
 * Content-Length, тот оказывался верным, и дальше искать было негде: за один
 * день на это потерялось время у двоих независимо — на теле с кириллицей,
 * которое оболочка Windows перекодировала из UTF-8 в однобайтовую кодировку.
 */
test('отказ по нечитаемому телу называет кодировку, а не только длину', () => {
  const mapped = mapFrameworkError(
    fastifyError('FST_ERR_CTP_INVALID_CONTENT_LENGTH', 400, 'Request body size did not match'),
  );
  assert.equal(mapped.status, 400);
  assert.equal(mapped.body.error, 'BAD_REQUEST');

  const text = String(mapped.body.message);
  assert.match(text, /UTF-8/, 'текст должен называть кодировку — это частая причина');
  assert.match(text, /Content-Length/, 'и вторую причину тоже, чтобы не увести в другую сторону');
});
