/**
 * Разбор номера из адреса запроса.
 *
 * Проверка появилась после живой находки: `/users/cleanup` отвечал 500
 * «Внутренняя ошибка сервера», потому что NaN доезжал до Postgres. Здесь
 * закреплено и само поведение, и то, что маршруты им пользуются, — иначе
 * следующий маршрут снова напишет `Number(...)` и всё вернётся.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathId } from './params.js';
import { ApiError } from './errors.js';

function refusal(raw: string): ApiError {
  try {
    pathId(raw, 'ящика');
  } catch (err) {
    assert.ok(err instanceof ApiError, 'ожидалась прикладная ошибка');
    return err;
  }
  throw new Error(`«${raw}» приняли за номер, хотя это не номер`);
}

test('обычный номер проходит как есть', () => {
  assert.equal(pathId('12', 'ящика'), 12);
  assert.equal(pathId(' 7 ', 'ящика'), 7, 'пробелы по краям — не повод для отказа');
  assert.equal(pathId('2147483647', 'ящика'), 2_147_483_647, 'предел int4 ещё допустим');
});

test('ноль и отрицательные идут дальше: это разговор про «не найдено»', () => {
  // Маршрут ответит своим 404 — так было и до появления разбора.
  assert.equal(pathId('0', 'ящика'), 0);
  assert.equal(pathId('-5', 'ящика'), -5);
});

test('не-номер получает внятный отказ, а не пятисотую', () => {
  for (const raw of ['cleanup', 'abc', '', ' ', '1e999', '0x10', '12abc', '1.5', '١٢']) {
    const err = refusal(raw);
    assert.equal(err.statusCode, 400, `«${raw}» должен давать 400`);
    assert.match(err.message, /номер ящика/u, `в отказе на «${raw}» не сказано, чего ждали`);
  }
});

test('12abc не превращается в двенадцать', () => {
  // parseInt поступил бы именно так — молча обрезал хвост.
  assert.equal(refusal('12abc').statusCode, 400);
});

test('слишком большой номер отвергается до базы', () => {
  // Postgres на таком отвечает «integer out of range» — той же 500-й.
  const err = refusal('9999999999');
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /пределы/u, 'из отказа не видно, что номер попросту велик');

  // Совсем длинную простыню цифр отсеивает ещё разбор — тоже отказом, не NaN.
  assert.equal(refusal('9999999999999999999999').statusCode, 400);
});

test('в отказ не попадают управляющие знаки и простыни', () => {
  const err = refusal(`ab\u0007cd${'я'.repeat(200)}`);
  assert.doesNotMatch(err.message, /[\u0000-\u001f]/u, 'управляющие знаки утекли в ответ');
  assert.ok(err.message.length < 200, 'ответ раздут переданной простынёй');
});

test('маршруты разбирают номер из адреса только через pathId', () => {
  /*
   * Голый Number(request.params.…) отдаёт NaN на любой опечатке в адресе,
   * и опечатка становится неотличима от поломки сервера: 500 в ответе и
   * трассировка в журнале. Так вело себя девятнадцать маршрутов панели.
   */
  const roots = [
    fileURLToPath(new URL('./admin/routes', import.meta.url)),
    fileURLToPath(new URL('./routes', import.meta.url)),
    fileURLToPath(new URL('./ai', import.meta.url)),
  ];

  const offenders: string[] = [];
  let checked = 0;
  for (const dir of roots) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.includes('.test.')) continue;
      checked += 1;
      const src = readFileSync(`${dir}/${name}`, 'utf8');
      for (const m of src.matchAll(/\b(?:Number|parseInt)\(\s*request\.params\./gu)) {
        offenders.push(`${name}: ${m[0]}`);
      }
    }
  }

  assert.ok(checked > 20, `файлов маршрутов найдено всего ${checked} — проверка смотрит не туда`);
  assert.deepEqual(offenders, [], 'номер из адреса разбирается в обход pathId');
});
