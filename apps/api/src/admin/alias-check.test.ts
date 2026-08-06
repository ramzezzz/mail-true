/**
 * Связность алиасов.
 *
 * Раньше проверялось ровно одно — что адрес не указывает сам на себя.
 * Круг проверки админки нашёл три случая, которые принимались молча, и один
 * из них тихо ломает почту живого ящика.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAlias, type AliasWorld } from './alias-check.js';

/** Мирок из существующих ящиков и уже заведённых перенаправлений. */
function world(mailboxes: string[], aliases: Record<string, string> = {}): AliasWorld {
  const boxes = new Set(mailboxes);
  return {
    mailboxExists: (email) => Promise.resolve(boxes.has(email)),
    aliasTarget: (source) => Promise.resolve(aliases[source] ?? null),
  };
}

/**
 * Главный случай. В настройках почтового сервера карта перенаправлений
 * разбирается РАНЬШЕ карты ящиков, поэтому алиас с адресом живого ящика
 * уводит всю его входящую почту. Ящик при этом выглядит целым: он в списке,
 * в него можно войти, в нём лежит старая почта — просто новая не приходит.
 */
test('алиас с адресом существующего ящика отвергается', async () => {
  const problem = await checkAlias(
    'ivanov@mail.local',
    'petrov@mail.local',
    world(['ivanov@mail.local', 'petrov@mail.local']),
  );
  assert.ok(problem, 'такой алиас обязан отвергаться');
  assert.equal(problem.blocking, true);
  assert.match(problem.message, /существующий ящик/);
  assert.match(problem.message, /всю его входящую почту/, 'человеку надо сказать, чем это грозит');
});

test('кольцо перенаправлений отвергается', async () => {
  // a → b уже есть; создаём b → a
  const problem = await checkAlias(
    'b@mail.local',
    'a@mail.local',
    world([], { 'a@mail.local': 'b@mail.local' }),
  );
  assert.ok(problem);
  assert.equal(problem.blocking, true);
  assert.match(problem.message, /кольцо/);
});

test('длинное кольцо тоже находится', async () => {
  const chain = {
    'a@mail.local': 'b@mail.local',
    'b@mail.local': 'c@mail.local',
    'c@mail.local': 'd@mail.local',
  };
  const problem = await checkAlias('d@mail.local', 'a@mail.local', world([], chain));
  assert.ok(problem);
  assert.equal(problem.blocking, true);
});

test('адрес сам на себя по-прежнему отвергается', async () => {
  const problem = await checkAlias('a@mail.local', 'a@mail.local', world([]));
  assert.ok(problem);
  assert.equal(problem.blocking, true);
  assert.match(problem.message, /сам на себя/);
});

/**
 * Отказывать здесь нельзя: ящик могут завести следующим действием, а
 * пересылка на внешний адрес — обычное дело. Но и молчать нельзя: письмо на
 * несуществующий внутренний адрес отобьётся, и узнают об этом не сразу.
 */
test('путь на несуществующий адрес предупреждает, но не запрещает', async () => {
  const problem = await checkAlias('sales@mail.local', 'net-takogo@mail.local', world([]));
  assert.ok(problem);
  assert.equal(problem.blocking, false, 'создать всё-таки можно');
  assert.match(problem.message, /нет/);
});

test('цепочка, ведущая в никуда, называет конечный адрес', async () => {
  const problem = await checkAlias(
    'a@mail.local',
    'b@mail.local',
    world([], { 'b@mail.local': 'c@mail.local' }),
  );
  assert.ok(problem);
  assert.equal(problem.blocking, false);
  assert.match(problem.message, /c@mail\.local/, 'важен конец пути, а не первый шаг');
});

test('исправный алиас на живой ящик не вызывает возражений', async () => {
  const problem = await checkAlias(
    'sales@mail.local',
    'ivanov@mail.local',
    world(['ivanov@mail.local']),
  );
  assert.equal(problem, null);
});

test('цепочка, кончающаяся живым ящиком, тоже в порядке', async () => {
  const problem = await checkAlias(
    'info@mail.local',
    'sales@mail.local',
    world(['ivanov@mail.local'], { 'sales@mail.local': 'ivanov@mail.local' }),
  );
  assert.equal(problem, null);
});
