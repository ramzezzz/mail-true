/** Тесты разбора ответов модели, в том числе искажённых и неполных. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { extractJsonText, parseJsonLoose, parseWithSchema } from '../json.js';
import { summarySchema, searchQuerySchema } from '../schemas.js';

describe('extractJsonText', () => {
  it('находит чистый JSON', () => {
    assert.equal(extractJsonText('{"a":1}'), '{"a":1}');
  });

  it('снимает ограждение ```json', () => {
    assert.equal(extractJsonText('```json\n{"a":1}\n```'), '{"a":1}');
  });

  it('отбрасывает пояснения до и после', () => {
    assert.equal(extractJsonText('Вот ответ: {"a":1}. Надеюсь, помог!'), '{"a":1}');
  });

  it('не путается на скобках внутри строк', () => {
    const raw = '{"text":"} не конец {","n":1}';
    assert.equal(extractJsonText(raw), raw);
  });

  it('возвращает null, если JSON нет вовсе', () => {
    assert.equal(extractJsonText('Извините, я не могу это сделать.'), null);
  });
});

describe('parseJsonLoose', () => {
  it('чинит лишнюю запятую перед закрывающей скобкой', () => {
    const result = parseJsonLoose('{"a":1,}');
    assert.ok(result.ok);
    assert.deepEqual(result.value, { a: 1 });
    assert.equal(result.repaired, true);
  });

  it('оборванный ответ не роняет разбор', () => {
    const result = parseJsonLoose('{"summary":"начал писать и об');
    assert.equal(result.ok, false);
  });

  it('пустая строка не роняет разбор', () => {
    assert.equal(parseJsonLoose('').ok, false);
  });

  it('мусор вместо JSON не роняет разбор', () => {
    assert.equal(parseJsonLoose('   <<< >>>').ok, false);
  });
});

describe('parseWithSchema', () => {
  it('подставляет значения по умолчанию для необязательных полей', () => {
    const result = parseWithSchema('{"summary":"Счёт на 45 600 руб."}', summarySchema);
    assert.ok(result.ok);
    assert.equal(result.value.summary, 'Счёт на 45 600 руб.');
    assert.deepEqual(result.value.bullets, []);
    assert.equal(result.value.actionRequired, false);
  });

  it('ответ без обязательного поля даёт понятный отказ, а не исключение', () => {
    const result = parseWithSchema('{"bullets":["а","б"]}', summarySchema);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, 'bad-response');
      assert.ok(result.error.details?.includes('summary'));
    }
  });

  it('неверный тип поля даёт отказ', () => {
    const result = parseWithSchema('{"summary":42}', summarySchema);
    assert.equal(result.ok, false);
  });

  it('чужая форма ответа отвергается', () => {
    const result = parseWithSchema('[1,2,3]', summarySchema);
    assert.equal(result.ok, false);
  });

  it('разбор поискового запроса требует explanation', () => {
    const ok = parseWithSchema(
      '{"from":["бухгалтерия"],"dateFrom":"2026-03-01","dateTo":"2026-03-31","explanation":"письма от бухгалтерии за март"}',
      searchQuerySchema,
    );
    assert.ok(ok.ok);
    assert.equal(ok.value.explanation, 'письма от бухгалтерии за март');
    assert.deepEqual(ok.value.text, []);
    assert.equal(ok.value.hasAttachments, null);

    const bad = parseWithSchema('{"from":["бухгалтерия"]}', searchQuerySchema);
    assert.equal(bad.ok, false);
  });

  it('произвольная схема работает так же', () => {
    const schema = z.object({ n: z.number() });
    assert.equal(parseWithSchema('{"n":5}', schema).ok, true);
    assert.equal(parseWithSchema('{"n":"пять"}', schema).ok, false);
  });
});
