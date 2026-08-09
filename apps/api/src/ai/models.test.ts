/**
 * Список моделей у поставщика.
 *
 * Разбор проверяется отдельно от сети, потому что форм ответа несколько и
 * все они встречаются в жизни: OpenAI-совместимые сервисы отдают
 * `{data: [{id}]}`, нативный Ollama — `{models: [{name}]}`, самодельные
 * обёртки — просто массив строк. Перепутать их легко, а последствие
 * тихое: список в панели оказывается пустым, и человек снова вводит
 * название модели руками, ради чего всё и затевалось.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeNetworkFailure, modelsEndpoint, parseModelList } from './models.js';

void test('адрес списка приклеивается к адресу сервиса', () => {
  assert.equal(modelsEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
});

void test('лишние косые черты в адресе не удваиваются', () => {
  // «http://ollama:11434/v1/» — ровно так адрес и вставляют из документации.
  assert.equal(modelsEndpoint('http://ollama:11434/v1/'), 'http://ollama:11434/v1/models');
  assert.equal(modelsEndpoint('http://ollama:11434/v1///'), 'http://ollama:11434/v1/models');
});

void test('ответ OpenAI-совместимого сервиса', () => {
  const payload = {
    object: 'list',
    data: [
      { id: 'gpt-4o-mini', object: 'model' },
      { id: 'gpt-4o', object: 'model' },
    ],
  };
  assert.deepEqual(parseModelList(payload), ['gpt-4o', 'gpt-4o-mini']);
});

void test('ответ нативного Ollama: имена в поле name', () => {
  const payload = { models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] };
  assert.deepEqual(parseModelList(payload), ['llama3.1:8b', 'qwen2.5:7b']);
});

void test('массив строк — так отвечают самодельные обёртки', () => {
  assert.deepEqual(parseModelList(['b-model', 'a-model']), ['a-model', 'b-model']);
});

void test('одна и та же модель не двоится', () => {
  /*
   * Обёртки над несколькими поставщиками называют модель по разу на
   * каждого. В выпадающем списке она троилась бы, а выбрать всё равно
   * можно только одну.
   */
  const payload = { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o' }, { id: 'gpt-4o' }] };
  assert.deepEqual(parseModelList(payload), ['gpt-4o']);
});

void test('пустые и мусорные записи отбрасываются, а не превращаются в пустые строки', () => {
  const payload = { data: [{ id: '' }, { id: '   ' }, {}, null, 42, { id: 'нормальная' }] };
  assert.deepEqual(parseModelList(payload), ['нормальная']);
});

void test('пробелы по краям названия срезаются', () => {
  // Название уедет в поле и оттуда — в запрос к сервису. Пробел в конце
  // превратил бы верную модель в неизвестную.
  assert.deepEqual(parseModelList([' qwen2.5:7b ']), ['qwen2.5:7b']);
});

void test('незнакомая форма ответа даёт пустой список, а не падение', () => {
  /*
   * Пустой список — честный ответ «поставщик ничего не назвал»: панель
   * оставляет ручной ввод. Исключение здесь означало бы, что на чужом
   * формате раздел настроек перестаёт открываться.
   */
  for (const payload of [null, undefined, 42, 'строка', {}, { data: 'не массив' }]) {
    assert.deepEqual(parseModelList(payload), []);
  }
});

void test('порядок — по алфавиту без учёта регистра', () => {
  // Порядок поставщика ничего не значит: у одних он по дате, у других
  // случайный. Список из полусотни моделей читается только отсортированным.
  assert.deepEqual(parseModelList(['Zephyr', 'alpha', 'Beta']), ['alpha', 'Beta', 'Zephyr']);
});

/* ------------------------------------------------------------------ */
/* Сетевой отказ словами                                               */
/* ------------------------------------------------------------------ */

void test('неверное имя хоста объясняется, а не пересказывается как «fetch failed»', () => {
  // Найдено живой проверкой: панель показывала ровно «fetch failed».
  const err = new TypeError('fetch failed', {
    cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
  });
  assert.match(describeNetworkFailure(err), /адрес/u);
});

void test('никто не слушает — сказано именно это', () => {
  const err = new TypeError('fetch failed', {
    cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
  });
  assert.match(describeNetworkFailure(err), /не запущен|не слушает/u);
});

void test('самоподписанный сертификат назван своим именем', () => {
  const err = new TypeError('fetch failed', {
    cause: Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
  });
  assert.match(describeNetworkFailure(err), /сертификат/u);
});

void test('незнакомая беда пересказывает причину, а не пустоту', () => {
  const err = new TypeError('fetch failed', { cause: new Error('что-то своё') });
  assert.equal(describeNetworkFailure(err), 'что-то своё');
});

void test('совсем без причины — понятная заглушка', () => {
  assert.equal(describeNetworkFailure(new TypeError('')), 'сеть недоступна');
});
