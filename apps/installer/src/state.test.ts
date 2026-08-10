/**
 * Ответы, которые человек уже дал.
 *
 * Проверка появилась после живой установки: сначала спросил домен и имя
 * сервера консольный установщик (`install.sh --prepare-only` пишет их в
 * infra/.env), а следом мастер в браузере спросил ровно то же самое —
 * и было непонятно, какой из двух ответов победит.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answersFromEnv, parseEnv } from './state.js';

function env(text: string): { values: Map<string, string>; exists: boolean } {
  return { values: parseEnv(text), exists: true };
}

const EXAMPLE = env(
  [
    'MAIL_DOMAIN=mail.local',
    'MAIL_HOSTNAME=mail.local',
    'BIND_ADDRESS=0.0.0.0',
    'CLAMAV_ENABLED=false',
    'MESSAGE_MAX_BYTES=26214400',
    'SMTP_PORT=25',
    'POSTGRES_PASSWORD=change-me-postgres-password',
    'SESSION_SECRET=change-me-session-secret-32-characters',
  ].join('\n'),
);

test('заданные ответы возвращаются в форму', () => {
  const answers = answersFromEnv(
    env(['MAIL_DOMAIN=home.local', 'MAIL_HOSTNAME=mail.home.local'].join('\n')),
    EXAMPLE,
  );
  assert.equal(answers.domain, 'home.local');
  assert.equal(answers.hostname, 'mail.home.local');
});

test('незаполненный образец в форму не попадает', () => {
  // web-install.sh кладёт infra/.env копией образца: там одни заглушки,
  // и подставить их в форму — хуже, чем оставить поля пустыми.
  const answers = answersFromEnv(EXAMPLE, EXAMPLE);
  assert.deepEqual(answers, {}, 'заглушки образца выданы за ответы человека');
});

test('секреты в форму не возвращаются никогда', () => {
  const answers = answersFromEnv(
    env(
      [
        'MAIL_DOMAIN=home.local',
        'POSTGRES_PASSWORD=NastoyashchiyParol123',
        'SESSION_SECRET=abcdefghijklmnopqrstuvwxyz123456',
        'DKIM_SELECTOR=mail',
      ].join('\n'),
    ),
    EXAMPLE,
  );
  const dump = JSON.stringify(answers);
  assert.doesNotMatch(dump, /NastoyashchiyParol123/u, 'пароль базы утёк в форму');
  assert.doesNotMatch(dump, /abcdefghijklmnopqrstuvwxyz123456/u, 'ключ сессий утёк в форму');
  assert.deepEqual(Object.keys(answers), ['domain']);
});

test('числа и флаги приходят числами и флагами, а не строками', () => {
  const answers = answersFromEnv(
    env(['CLAMAV_ENABLED=true', 'MESSAGE_MAX_BYTES=52428800', 'SMTP_PORT=2525'].join('\n')),
    EXAMPLE,
  );
  assert.equal(answers.clamav, true);
  assert.equal(answers.messageMaxBytes, 52_428_800);
  /*
   * Имя поля формы — `port.<ключ>`, и раньше здесь клался голый ключ:
   * заданный в .env порт в форму НЕ ПОПАДАЛ, а повторный проход мастера
   * возвращал нестандартные порты к 25/587/993 — стек падал с «port is
   * already allocated».
   */
  assert.equal(answers['port.smtp'], 2525);
});

test('значения-заглушки «change-me» ответами не считаются', () => {
  const answers = answersFromEnv(env('MAIL_DOMAIN=change-me-domain'), EXAMPLE);
  assert.deepEqual(answers, {});
});

test('без файла .env ответов нет', () => {
  const answers = answersFromEnv({ values: new Map(), exists: false }, EXAMPLE);
  assert.deepEqual(answers, {});
});
