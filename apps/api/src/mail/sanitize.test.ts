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
    { allowRemote: true },
  );
  assert.ok(!html.includes('onerror'), 'onerror должен быть удалён');
  assert.ok(!html.includes('onclick'), 'onclick должен быть удалён');
  assert.ok(!html.includes('alert(1)'));
});

test('вырезает iframe, object, embed, form', () => {
  const { html } = sanitizeEmailHtml(
    '<iframe src="https://evil.example"></iframe><object data="x"></object>' +
      '<embed src="x"><form action="https://evil.example"><input name="pwd"></form><b>ok</b>',
    { allowRemote: true },
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
    { allowRemote: false },
  );
  assert.equal(blockedRemote, 1);
  assert.ok(
    html.includes('data-mt-src="https://tracker.example/pixel.png"'),
    'исходный URL сохранён',
  );
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
    { allowRemote: false },
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
    { allowRemote: false },
  );
  assert.ok(!html.includes('tracker.example'), 'внешний адрес не должен остаться в CSS');
  assert.ok(blockedRemote > 0, 'блокировка должна быть засчитана');
});

test('внешний url() в одинарных кавычках со скобкой тоже блокируется', () => {
  const { html, blockedRemote } = sanitizeEmailHtml(
    '<div style="background-image: url(\'http://tracker.example/x(1).png\')">x</div>',
    { allowRemote: false },
  );
  assert.ok(!html.includes('tracker.example'));
  assert.ok(blockedRemote > 0);
});

test('при разрешённых картинках внешний url() со скобкой сохраняется', () => {
  const { html } = sanitizeEmailHtml(
    '<div style="background-image: url(&quot;http://cdn.example/a)b.png&quot;)">x</div>',
    { allowRemote: true },
  );
  assert.ok(html.includes('cdn.example'), 'при разрешении картинок адрес должен остаться');
});

/*
 * Письма рассылок приходят полным документом, и стиль почти всегда стоит
 * в <head>. DOMPurify зовётся с WHOLE_DOCUMENT: false — он возвращает
 * только тело, а стиль до содержимого тела по правилам разбора HTML
 * попадает в <head> и терялся целиком.
 *
 * На экране это выглядело так: служебный предзаголовок, который
 * отправитель прячет через display:none, показывался первой строкой
 * письма, а вёрстка разъезжалась. И вся работа scrubCss над <style> в
 * самом частом случае не выполнялась вообще.
 */
test('стиль из <head> не теряется вместе с обёрткой документа', () => {
  const { html } = sanitizeEmailHtml(
    '<!doctype html><html><head><style>.preheader{display:none}</style></head>' +
      '<body><div class="preheader">СЛУЖЕБНЫЙ ПРЕДЗАГОЛОВОК</div><p>Здравствуйте!</p></body></html>',
    { allowRemote: false },
  );
  assert.match(html, /\.preheader\s*\{\s*display:\s*none\s*\}/, 'стиль письма пропал');
  assert.match(html, /СЛУЖЕБНЫЙ ПРЕДЗАГОЛОВОК/, 'содержимое тела пропало');
  // Обёрток документа в результате быть не должно: тело письма встраивается
  // в страницу почты.
  assert.doesNotMatch(html, /<html|<head|<body/i);
});

test('стиль из <head> проходит ту же чистку, что и стиль в теле', () => {
  const { html, blockedRemote } = sanitizeEmailHtml(
    '<html><head><style>@import url(http://zloy.example/x.css); ' +
      'body{background:url(http://zloy.example/fon.png)}</style></head><body>x</body></html>',
    { allowRemote: false },
  );
  assert.doesNotMatch(html, /@import/i, '@import из <head> не вычищен');
  assert.doesNotMatch(html, /zloy\.example/, 'внешний адрес из <head> остался');
  assert.ok(blockedRemote > 0, 'блокировки из <head> не посчитаны');
});

/*
 * Адрес без схемы («//cdn/a.png») ставят рассылки, которые шлют письмо и
 * по HTTP, и по HTTPS. Он не проходил список разрешённых схем, поэтому
 * DOMPurify снимал атрибут ДО нашего хука: счётчик заблокированных не
 * рос, плашки не было, data-mt-src не ставился — «Показать картинки»
 * вернуть такую картинку уже не могло.
 */
test('картинка без схемы блокируется видимо, а не пропадает молча', () => {
  const { html, blockedRemote } = sanitizeEmailHtml(
    '<img src="//cdn.example/a.png" alt="Логотип">',
    { allowRemote: false },
  );
  assert.equal(blockedRemote, 1, 'блокировка не посчитана — плашки не будет');
  assert.match(html, /data-mt-src="\/\/cdn\.example\/a\.png"/, 'адрес не сохранён для показа');
  // Именно `src`, а не `data-mt-src`: подстрока «src="//cdn» есть и в нём.
  assert.match(html, /\ssrc="data:image\//, 'вместо картинки должна стоять заглушка');
});

test('при разрешённых картинках адрес без схемы возвращается', () => {
  const { html } = sanitizeEmailHtml('<img src="//cdn.example/a.png" alt="Логотип">', {
    allowRemote: true,
  });
  assert.match(html, /src="\/\/cdn\.example\/a\.png"/);
});

test('фон без схемы возвращается вместе с остальными картинками', () => {
  const blocked = sanitizeEmailHtml('<div style="background:url(//cdn.example/f.png)">x</div>', {
    allowRemote: false,
  });
  assert.ok(blocked.blockedRemote > 0);
  assert.doesNotMatch(blocked.html, /cdn\.example/);

  const allowed = sanitizeEmailHtml('<div style="background:url(//cdn.example/f.png)">x</div>', {
    allowRemote: true,
  });
  assert.match(allowed.html, /cdn\.example\/f\.png/, 'после «Показать» фон так и не вернулся');
});

test('стиль письма действует только внутри письма', () => {
  const { html } = sanitizeEmailHtml(
    '<style>body{background:#000}:root{--mt-color-bg:red}' +
      'body::before{position:fixed;inset:0;z-index:9}' +
      '.wrap{color:blue}@media (max-width:600px){body{font-size:9px}}</style><p>текст</p>',
    { allowRemote: false },
  );
  // Ни одного селектора, действующего на страницу почты, остаться не должно:
  // письмо не может ни перекрасить интерфейс, ни накрыть его своим слоем.
  assert.ok(!/(^|[{}])\s*body\s*[{,]/.test(html), 'селектор body должен быть сужен');
  assert.ok(!html.includes(':root{'), 'селектор :root должен быть сужен');
  assert.match(html, /\.mt-mail-html\{background:#000\}/);
  assert.match(html, /\.mt-mail-html::before\{/);
  assert.match(html, /\.mt-mail-html \.wrap\{color:blue\}/);
  // Вложенные @-правила тоже сужаются, иначе через @media проходило бы всё.
  assert.match(html, /@media \(max-width:600px\)\{\.mt-mail-html\{font-size:9px\}\}/);
});

test('@font-face и @keyframes остаются нетронутыми', () => {
  const { html } = sanitizeEmailHtml(
    '<style>@keyframes go{from{opacity:0}to{opacity:1}}' +
      '@font-face{font-family:X;src:url(data:font/woff2;base64,AA)}</style><p>x</p>',
    { allowRemote: false },
  );
  // Внутри них не селекторы, а кадры и дескрипторы: сужать нечего и нельзя.
  assert.match(html, /@keyframes go\{from\{opacity:0\}to\{opacity:1\}\}/);
  assert.ok(html.includes('@font-face{font-family:X;'));
});
