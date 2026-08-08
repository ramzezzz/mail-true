/**
 * Две проверки, которые раньше значились как «этот раздел их не делает».
 *
 * Обе отвечают на вопросы, которые задают чаще прочих, и обе обязаны
 * отвечать честно: «не видно» вместо выдуманного «в порядке» — половина
 * смысла этой правки. Панель, показывающая зелёное там, где она просто
 * не смотрела, хуже панели, которой нет.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeBackup, gradeMigrations } from './deploy-checks.js';

const FILES = ['0000_schema_migrations.sql', '0001_init.sql', '0002_users.sql'];

test('все миграции применены — в порядке', () => {
  const check = gradeMigrations({ files: FILES, applied: new Set(FILES) });
  assert.equal(check.state, 'ok');
  assert.match(check.detail, /3/u, 'из ответа не видно, сколько миграций проверено');
});

test('непримененная миграция — отказ, и названа поимённо', () => {
  const check = gradeMigrations({
    files: FILES,
    applied: new Set(['0000_schema_migrations.sql', '0001_init.sql']),
  });
  // Именно fail: код уже ждёт таблицу, которой нет, и узнается это
  // отказом раздела в самый неподходящий момент.
  assert.equal(check.state, 'fail');
  assert.match(check.detail, /0002_users\.sql/u, 'не сказано, какой миграции не хватает');
  assert.match(check.hint ?? '', /install\.sh/u, 'не сказано, чем накатывать');
});

test('каталог миграций не виден — «неизвестно», а не «в порядке»', () => {
  const check = gradeMigrations({ files: [], applied: new Set() });
  assert.equal(check.state, 'unknown');
  assert.notEqual(check.state, 'ok');
});

test('свежая копия — в порядке, старая — предупреждение, очень старая — отказ', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  const at = (days: number): Date => new Date(now.getTime() - days * 86_400_000);

  assert.equal(gradeBackup({ at: at(0), now }).state, 'ok');
  assert.equal(gradeBackup({ at: at(3), now }).state, 'ok');
  assert.equal(gradeBackup({ at: at(8), now }).state, 'warn');
  assert.equal(gradeBackup({ at: at(45), now }).state, 'fail');
});

test('копий не было — предупреждение с командой, а не тишина', () => {
  const check = gradeBackup({ at: null });
  assert.equal(check.state, 'warn');
  assert.match(check.hint ?? '', /backup\.sh/u);
});

test('в ответе про копию видно и сколько суток прошло, и дату', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  const check = gradeBackup({ at: new Date('2026-08-01T03:00:00Z'), now });
  assert.match(check.detail, /8 сут/u);
  assert.match(check.detail, /2026-08-01/u);
});
