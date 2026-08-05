/** Тесты санитизации HTML писем. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEmailHtml, BLOCKED_PIXEL } from './sanitize.js';

test('вырезает <script> и его содержимое', () => {
  const { html } = sanitizeEmailHtml('<p>привет</p><script>alert(1)</script>', {
    allowRemote: true,
  });
  assert.ok(!html.includes('<script'), 'тег script должен быть удалён');
  assert.ok(!html.includes('alert(1)'), 'содержимое script должно быть удалено');
  assert.ok(html.includes('привет'));
});

test('вырезает обработчики событий (onerror, onclick)', () => {
  const { html } = sanitizeEmailHtml(
    '<img src="cid:x" onerror="alert(1)"><div onclick="steal()">text</div>',
    { allowRemote: true }
  );
  assert.ok(!html.includes('onerror'), 'onerror должен быть удалён');
  assert.ok(!html.includes('onclick'), 'onclick должен быть удалён');
  assert.ok(!html.includes('alert(1)'));
});

test('вырезает iframe, object, embed, form', () => {
  const { html } = sanitizeEmailHtml(
    '<iframe src="https://evil.example"></iframe><object data="x"></object>' +
      '<embed src="x"><form action="https://evil.example"><input name="pwd"></form><b>ok</b>',
    { allowRemote: true }
  );
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('<object'));
  assert.ok(!html.includes('<embed'));
  assert.ok(!html.includes('<form'));
  assert.ok(!html.includes('<input'));
  assert.ok(html.includes('<b>ok</b>'));
});

test('запрещает javascript: в ссылках', () => {
  const { html } = sanitizeEmailHtml('<a href="javascript:alert(1)">кликни</a>', {
    allowRemote: true,
  });
  assert.ok(!html.includes('javascript:'));
});

test('блокирует внешние картинки по умолчанию', () => {
  const { html, blockedRemote } = sanitizeEmailHtml(
    '<img src="https://tracker.example/pixel.png" alt="x">',
    { allowRemote: false }
  );
  assert.equal(blockedRemote, 1);
  assert.ok(html.includes('data-mt-src="https://tracker.example/pixel.png"'), 'исходный URL сохранён');
  assert.ok(html.includes(BLOCKED_PIXEL), 'вместо src — заглушка');
});

test('разрешает внешние картинки при allowRemote', () => {
  const { html, blockedRemote } = sanitizeEmailHtml('<img src="https://cdn.example/a.png">', {
    allowRemote: true,
  });
  assert.equal(blockedRemote, 0);
  assert.ok(html.includes('src="https://cdn.example/a.png"'));
});

test('переписывает cid: на маршрут частей письма', () => {
  const { html } = sanitizeEmailHtml('<img src="cid:image001@mail">', {
    allowRemote: false,
    resolveCid: (cid) => (cid === 'image001@mail' ? '/api/messages/inbox%3A5/parts/2' : null),
  });
  assert.ok(html.includes('src="/api/messages/inbox%3A5/parts/2"'));
  assert.ok(!html.includes('cid:'));
});

test('неизвестный cid удаляется', () => {
  const { html } = sanitizeEmailHtml('<img src="cid:unknown@mail" alt="п">', {
    allowRemote: false,
  });
  assert.ok(!html.includes('cid:'));
});

test('чистит внешние url() в inline-стилях', () => {
  const { html, blockedRemote } = sanitizeEmailHtml(
    '<div style="background-image: url(https://evil.example/bg.png); color: red">x</div>',
    { allowRemote: false }
  );
  assert.ok(!html.includes('evil.example'));
  assert.ok(html.includes('color: red'));
  assert.equal(blockedRemote, 1);
});

test('ссылки открываются в новой вкладке с rel=noopener', () => {
  const { html } = sanitizeEmailHtml('<a href="https://example.com">ссылка</a>', {
    allowRemote: false,
  });
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('noopener'));
});

test('внешний url() со скобкой внутри кавычек не обходит блокировку', () => {
  // Наивный разбор url(...) не совпадал с таким адресом и оставлял его в CSS
  // нетронутым: трекинговый пиксель загружался, а счётчик блокировок был нулевым,
  // то есть отправитель узнавал о прочтении письма вопреки включённой защите.
  const { html, blockedRemote } = sanitizeEmailHtml(
    '<div style="background-image: url(&quot;http://tracker.example/a)b.png&quot;)">x</div>',
    { allowRemote: false }
  );
  assert.ok(!html.includes('tracker.example'), 'внешний адрес не должен остаться в CSS');
  assert.ok(blockedRemote > 0, 'блокировка должна быть засчитана');
});

test('внешний url() в одинарных кавычках со скобкой тоже блокируется', () => {
  const { html, blockedRemote } = sanitizeEmailHtml(
    "<div style=\"background-image: url('http://tracker.example/x(1).png')\">x</div>",
    { allowRemote: false }
  );
  assert.ok(!html.includes('tracker.example'));
  assert.ok(blockedRemote > 0);
});

test('при разрешённых картинках внешний url() со скобкой сохраняется', () => {
  const { html } = sanitizeEmailHtml(
    '<div style="background-image: url(&quot;http://cdn.example/a)b.png&quot;)">x</div>',
    { allowRemote: true }
  );
  assert.ok(html.includes('cdn.example'), 'при разрешении картинок адрес должен остаться');
});
