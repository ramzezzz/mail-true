import assert from 'node:assert/strict';
import test from 'node:test';
import { ENCODING_OVERHEAD, loadConfig } from './config.js';

/** Окружение только из того, что нужно проверке (без .env машины). */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...extra };
}

/**
 * Главный случай. `UPLOAD_MAX_BYTES` (26214400) в точности равнялся пределу
 * письма в Postfix, но при кодировании base64 вложение растёт примерно на
 * 37%: файл больше ~19 МБ не уходил НИКОГДА, хотя загрузка принималась.
 */
test('действующий предел вложения меньше предела письма с запасом на кодирование', () => {
  const config = loadConfig(env({ UPLOAD_MAX_BYTES: '26214400', MESSAGE_MAX_BYTES: '26214400' }));

  assert.ok(
    config.ATTACHMENT_MAX_BYTES < config.MESSAGE_MAX_BYTES,
    'предел вложения не может равняться пределу письма'
  );
  // Вложение допустимого размера обязано пролезть в письмо после кодирования
  const encoded = Math.ceil(config.ATTACHMENT_MAX_BYTES * ENCODING_OVERHEAD);
  assert.ok(
    encoded <= config.MESSAGE_MAX_BYTES,
    `закодированное вложение ${encoded} не помещается в ${config.MESSAGE_MAX_BYTES}`
  );
});

test('заявленный предел загрузки не может превысить действующий', () => {
  const config = loadConfig(env({ UPLOAD_MAX_BYTES: '26214400', MESSAGE_MAX_BYTES: '26214400' }));
  assert.ok(config.ATTACHMENT_MAX_BYTES <= config.UPLOAD_MAX_BYTES);
});

test('меньший UPLOAD_MAX_BYTES остаётся в силе', () => {
  const config = loadConfig(env({ UPLOAD_MAX_BYTES: '1048576', MESSAGE_MAX_BYTES: '26214400' }));
  assert.equal(config.ATTACHMENT_MAX_BYTES, 1048576);
});

test('больший предел письма поднимает и предел вложения', () => {
  const small = loadConfig(env({ MESSAGE_MAX_BYTES: '26214400' })).ATTACHMENT_MAX_BYTES;
  const big = loadConfig(env({ MESSAGE_MAX_BYTES: '52428800' })).ATTACHMENT_MAX_BYTES;
  assert.ok(big > small);
});

test('предел тела запроса на написание письма больше самого тела письма по схеме', () => {
  const config = loadConfig(env());
  // bodyHtml по схеме — до 10 МБ; предел тела запроса обязан это вмещать
  assert.ok(
    config.COMPOSE_BODY_MAX_BYTES > 10 * 1024 * 1024,
    'письмо со вставленными картинками упрётся в невидимый потолок'
  );
});
