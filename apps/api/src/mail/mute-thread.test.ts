/**
 * Что считать «той же перепиской».
 *
 * Здесь проверяется самое дорогое место возможности: заглушить ЛИШНЕЕ —
 * значит потерять почту молча, и обнаружится это через неделю. Поэтому
 * закрепляются оба края: и то, что продолжение переписки узнаётся, и то,
 * что чужое письмо в неё не попадает.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { groupThreads, parseMessageIdList, threadIdentity } from './mute-thread.js';

test('из References берётся только то, что в угловых скобках', () => {
  assert.deepEqual(parseMessageIdList('<a@x> <b@x>'), ['a@x', 'b@x']);
  // Многострочный развёрнутый заголовок — обычное дело.
  assert.deepEqual(parseMessageIdList('<a@x>\r\n\t<b@x>'), ['a@x', 'b@x']);
  // Мусор отправителя: «On Mon, … wrote:» в In-Reply-To встречается чаще,
  // чем хотелось бы, и в правило доставки ему нельзя.
  assert.deepEqual(parseMessageIdList('On Mon, Ivan wrote:'), []);
  assert.deepEqual(parseMessageIdList(null), []);
});

test('ключ переписки — корень, а не первое попавшееся письмо', () => {
  const later = {
    messageId: '<c@x>',
    references: '<a@x> <b@x>',
    inReplyTo: '<b@x>',
    date: new Date('2026-08-05T10:00:00Z'),
  };
  const earlier = {
    messageId: '<b@x>',
    references: '<a@x>',
    inReplyTo: '<a@x>',
    date: new Date('2026-08-04T10:00:00Z'),
  };
  // Порядок писем на входе значения не имеет: ключ обязан быть один и тот
  // же, иначе повторное заглушение заведёт вторую запись о том же разговоре.
  assert.equal(threadIdentity([later, earlier]).threadKey, 'a@x');
  assert.equal(threadIdentity([earlier, later]).threadKey, 'a@x');
});

test('в список идут и собственные идентификаторы, и все ссылки', () => {
  /*
   * Начала переписки в папке может не быть вовсе — человека добавили
   * на сороковом письме. Но следующий ответ сошлётся именно на него.
   */
  const { messageIds } = threadIdentity([
    { messageId: '<c@x>', references: '<a@x> <b@x>', inReplyTo: '<b@x>', date: new Date() },
  ]);
  assert.deepEqual([...messageIds].sort(), ['a@x', 'b@x', 'c@x']);
});

test('письмо без Message-ID и без ссылок заглушить нечем', () => {
  const identity = threadIdentity([{ messageId: null, references: null, inReplyTo: null }]);
  assert.equal(identity.threadKey, '');
  assert.deepEqual(identity.messageIds, []);
});

test('выделенные письма из разных разговоров не сливаются в один', () => {
  /*
   * Человек вправе выделить пять строк из разных переписок и нажать
   * «Заглушить». Слепить их в одну запись значило бы, что снятие одной
   * строки расглушает все пять — то есть возвращает переписки, которых
   * он не просил.
   */
  const groups = groupThreads([
    { messageId: '<a1@x>', references: null, inReplyTo: null },
    { messageId: '<a2@x>', references: '<a1@x>', inReplyTo: '<a1@x>' },
    { messageId: '<b1@y>', references: null, inReplyTo: null },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.length, 2);
  assert.equal(groups[1]?.length, 1);
});

test('письмо, ссылающееся на обе группы, склеивает их в одну', () => {
  const groups = groupThreads([
    { messageId: '<a@x>', references: null, inReplyTo: null },
    { messageId: '<b@x>', references: null, inReplyTo: null },
    // Ответ «на оба письма» — так бывает после слияния обсуждений.
    { messageId: '<c@x>', references: '<a@x> <b@x>', inReplyTo: '<b@x>' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.length, 3);
});
