/**
 * Метка блока подписи переживает санитизацию — и больше ничего из `data-*`.
 *
 * Дефект, ради которого это написано. Окно написания помечает блок подписи
 * атрибутом `data-mt-signature` (именно атрибутом: имена классов у нас
 * пересобираются сборщиком, искать по ним значило бы зависеть от сборки).
 * Санитайзер стирал все `data-*` подряд, а тело письма проходит через него
 * ДВАЖДЫ — при сохранении черновика и при чтении его обратно. То есть метка
 * не переживала одного оборота.
 *
 * Что из этого выходило у человека:
 *  - выбор подписи в дописанном черновике добавлял ВТОРОЙ блок подписи,
 *    потому что прежний окно уже не находило;
 *  - «Сохранить как шаблон» запекал подпись внутрь шаблона (он вырезает
 *    помеченный блок, а вырезать было нечего), и дальше каждое письмо по
 *    этому шаблону приходило с двумя подписями.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_PIXEL, sanitizeEmailHtml } from './sanitize.js';

test('метка блока подписи переживает санитизацию', () => {
  const { html } = sanitizeEmailHtml(
    '<div>Добрый день!</div><div data-mt-signature class="sig">Иван Петров</div>',
    { allowRemote: true },
  );
  assert.ok(
    html.includes('data-mt-signature'),
    'метка блока подписи стёрта — окно написания заведёт второй такой блок',
  );
  assert.ok(html.includes('Иван Петров'));
});

test('метка переживает и второй проход — черновик проходит санитайзер дважды', () => {
  const once = sanitizeEmailHtml('<div data-mt-signature>Иван Петров</div>', {
    allowRemote: true,
  }).html;
  const twice = sanitizeEmailHtml(once, { allowRemote: true }).html;
  assert.ok(twice.includes('data-mt-signature'), 'метка не пережила оборот «сохранил — открыл»');
});

test('прочие data-атрибуты по-прежнему вырезаются', () => {
  const { html } = sanitizeEmailHtml(
    '<div data-track="pixel-42" data-user-id="7" data-mt-signature>подпись</div>',
    { allowRemote: true },
  );
  assert.ok(!html.includes('data-track'), 'разрешён весь класс data-*, а не одна метка');
  assert.ok(!html.includes('data-user-id'));
  assert.ok(html.includes('data-mt-signature'));
});

test('разрешённая метка не открывает дороги скриптам и внешним картинкам', () => {
  const { html, blockedRemote } = sanitizeEmailHtml(
    '<div data-mt-signature onclick="steal()">' +
      '<script>alert(1)</script><img src="https://tracker.example/px.gif">' +
      '</div>',
    { allowRemote: false },
  );
  assert.ok(!html.includes('onclick'), 'обработчик события остался в письме');
  assert.ok(!html.includes('<script'));
  // Внешняя картинка внутри помеченного блока блокируется ровно как везде:
  // адрес уезжает в data-mt-src, а в src встаёт прозрачная точка.
  assert.ok(html.includes('data-mt-src="https://tracker.example/px.gif"'));
  assert.ok(html.includes(BLOCKED_PIXEL));
  assert.equal(blockedRemote, 1, 'внешняя картинка должна быть заблокирована как обычно');
});
