/**
 * Хранилище личного файла правил: признак «записано» против «скомпилировано».
 *
 * Дефект найден на живом стенде. Сервер приложения работает в контейнере,
 * где нет sievec, поэтому write() возвращал compiled=false — и вызывающий
 * не мог отличить «правила записаны, просто проверить их нечем» (файл в
 * ящике лежит, Dovecot соберёт его сам при доставке) от «в скрипте ошибка,
 * действующий файл намеренно не тронут» (в ящике остались СТАРЫЕ правила).
 * Интерфейс объявлял и то и другое одинаково — «фильтры работать не будут».
 *
 * Проверка не зависит от того, есть ли sievec на машине проверяющего:
 * сверяется инвариант «written истинно тогда и только тогда, когда наш
 * скрипт действительно лежит в ящике».
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pino } from 'pino';
import { SieveStore } from './store.js';

const logger = pino({ level: 'silent' });

function storeIn(root: string): SieveStore {
  return new SieveStore({
    transport: 'local',
    root,
    container: '',
    scriptName: 'mailtrue',
    owner: '',
    logger,
  });
}

void test('признак «записано» совпадает с тем, что реально лежит в ящике', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-sieve-'));
  const store = storeIn(root);
  const email = 'demo@mail.local';
  const script = 'require ["fileinto"];\n# правило проверки\nkeep;\n';

  const result = await store.write(email, script);

  const onDisk = await readFile(result.activePath, 'utf8').catch(() => null);
  assert.equal(
    result.written,
    onDisk === script,
    `written=${String(result.written)}, а в ящике ${onDisk === null ? 'ничего нет' : 'лежит другое'}`,
  );
  // Именно ради этого признак и заведён: без компилятора рядом скрипт
  // всё равно записан, и объявлять «правила не работают» неправильно.
  if (!result.compiled && result.written) {
    assert.match(result.compilerOutput, /Правила записаны/);
  }
});

void test('выключенный транспорт честно говорит, что ничего не записал', async () => {
  const store = new SieveStore({
    transport: 'off',
    root: '/nowhere',
    container: '',
    scriptName: 'mailtrue',
    owner: '',
    logger,
  });
  const result = await store.write('demo@mail.local', 'keep;\n');
  assert.equal(result.written, false);
  assert.equal(result.compiled, false);
});
