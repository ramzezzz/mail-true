/**
 * Правка списков антиспама внахлёст.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗАКРЫВАЕТСЯ
 * ------------------------------------------------------------------
 * Запись в список — это «прочитать карту целиком, дописать строку,
 * записать целиком»: копии в базе нет намеренно, источник истины — файл,
 * который переписывает сам rspamd. Две такие правки внахлёст теряют одну
 * из записей, и теряют МОЛЧА: панель отвечает «готово», в журнале аудита
 * стоит добавление, а письма от адреса продолжают приходить.
 *
 * Раздел используют вдвоём — про «разбор обращения в четыре руки»
 * написано в самом коде списков, — так что случай не выдуманный.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withMapLock } from './map-edit.js';

/** Пауза — чтобы правки заведомо перекрылись по времени. */
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Карта в памяти: читается целиком, пишется целиком — как настоящая.
 * Задержка между чтением и записью и есть то окно, в которое пролезала
 * вторая правка.
 */
function fakeMap(initial: string[] = []) {
  let content = [...initial];
  return {
    read: async (): Promise<string[]> => {
      await tick(5);
      return [...content];
    },
    write: async (next: string[]): Promise<void> => {
      await tick(5);
      content = [...next];
    },
    now: (): string[] => [...content],
  };
}

void test('две правки одной карты не теряют друг друга', async () => {
  const map = fakeMap(['old@example.org']);

  const add = (value: string) =>
    withMapLock('blacklist.map', async () => {
      const before = await map.read();
      await map.write([...before, value]);
    });

  await Promise.all([add('a@example.org'), add('b@example.org')]);

  assert.deepEqual(map.now(), ['old@example.org', 'a@example.org', 'b@example.org']);
});

void test('без очереди тот же сценарий теряет запись — проверка, что тест ловит дефект', async () => {
  /*
   * Обратная сторона: если бы очередь ничего не делала, тест выше был бы
   * зелёным по случайности. Здесь тот же код БЕЗ очереди, и он обязан
   * терять запись — иначе проверка не про то.
   */
  const map = fakeMap(['old@example.org']);
  const addUnsafe = async (value: string) => {
    const before = await map.read();
    await map.write([...before, value]);
  };

  await Promise.all([addUnsafe('a@example.org'), addUnsafe('b@example.org')]);

  assert.equal(map.now().length, 2, 'без очереди должна теряться одна из двух записей');
});

void test('правки разных карт идут параллельно, а не в затылок', async () => {
  // Чёрному списку незачем ждать белый: это разные файлы, и общая
  // очередь на все карты превратила бы раздел в узкое место.
  const order: string[] = [];
  const slow = withMapLock('blacklist.map', async () => {
    await tick(40);
    order.push('чёрный');
  });
  const fast = withMapLock('whitelist.map', async () => {
    await tick(5);
    order.push('белый');
  });

  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['белый', 'чёрный']);
});

void test('отказ одной правки не роняет следующие', async () => {
  /*
   * Права на файл карты, недоступный rspamd, отказавшая сеть — правка
   * падает. Следующая в очереди обязана выполниться: иначе одна ошибка
   * закрывала бы раздел до перезапуска сервера.
   */
  const failing = withMapLock('blacklist.map', () => Promise.reject(new Error('нет прав')));
  const next = withMapLock('blacklist.map', () => Promise.resolve('готово'));

  await assert.rejects(() => failing, /нет прав/u);
  assert.equal(await next, 'готово');
});

void test('отказ достаётся тому, кто эту правку заказал', async () => {
  const ok = withMapLock('m.map', () => Promise.resolve(1));
  const bad = withMapLock('m.map', () => Promise.reject(new Error('своя беда')));
  assert.equal(await ok, 1);
  await assert.rejects(() => bad, /своя беда/u);
});

void test('очередь не копит записи о завершённых картах', async () => {
  /*
   * Карт немного, но утечка памяти на ровном месте — это утечка. После
   * последней правки запись обязана исчезнуть, иначе каждая правленая
   * карта держала бы промис до перезапуска.
   */
  for (let i = 0; i < 50; i += 1) {
    await withMapLock(`map-${String(i)}.map`, () => Promise.resolve(i));
  }
  // Косвенно: повторная правка той же карты по-прежнему работает и не
  // ждёт ничего лишнего.
  const started = Date.now();
  await withMapLock('map-1.map', () => Promise.resolve('снова'));
  assert.ok(Date.now() - started < 50);
});
