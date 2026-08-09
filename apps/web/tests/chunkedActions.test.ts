/**
 * Действие над большой пачкой писем узнаёт про КАЖДЫЙ отказ.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Порции отправлялись циклом `for (…) mutation.mutate(chunk, { onError })`.
 * Выглядит правильно, работает не так: у react-query колбэки, переданные
 * вторым аргументом `mutate`, живут на наблюдателе, а не на самом
 * запросе, и каждый следующий вызов их затирает. Значит `onError`
 * позовут только у ПОСЛЕДНЕЙ порции.
 *
 * В списке писем это выглядело так: выделено семьсот писем (в папке с
 * группировкой — одно нажатие «Выделить загруженные»), нажато «Удалить»,
 * сервер отказал на первой порции. Человек видит «Не удалось переместить
 * письма», а пятьсот строк остаются погашенными: ни выделить, ни
 * открыть, ни повторить, и пометка «уезжает» с них не снимется никогда —
 * письма-то из списка никуда не делись. Лечилось только уходом в другую
 * папку.
 */
import { describe, expect, it } from 'vitest';
import { chunkIds, MAX_IDS_PER_REQUEST, runInChunks } from '../src/mail/threadList';

/** Список из N писем: inbox:1, inbox:2, … */
function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `inbox:${String(i + 1)}`);
}

describe('действие порциями', () => {
  it('отказ ПЕРВОЙ порции не теряется — именно её строки и вернутся', async () => {
    const all = ids(700);
    const seen: string[][] = [];
    const { failed } = await runInChunks(all, async (chunk) => {
      seen.push(chunk);
      // Отказывает первая порция, остальные проходят.
      if (seen.length === 1) throw new Error('сервер отказал');
    });

    expect(seen).toHaveLength(2);
    expect(failed).toEqual(all.slice(0, MAX_IDS_PER_REQUEST));
    expect(failed).toHaveLength(500);
  });

  it('отказ последней порции тоже виден — и только он', async () => {
    const all = ids(700);
    let call = 0;
    const { failed } = await runInChunks(all, async () => {
      call += 1;
      if (call === 2) throw new Error('сервер отказал');
    });
    expect(failed).toEqual(all.slice(MAX_IDS_PER_REQUEST));
  });

  it('отказали все — вернутся все строки, а не одна порция', async () => {
    const all = ids(1200);
    const { failed } = await runInChunks(all, async () => {
      throw new Error('сервер лежит');
    });
    expect(failed).toEqual(all);
    expect(chunkIds(all)).toHaveLength(3);
  });

  it('всё прошло — возвращать на место нечего', async () => {
    const { failed } = await runInChunks(ids(700), async () => undefined);
    expect(failed).toEqual([]);
  });

  it('порции идут по очереди, а не все разом: сервер не заваливается', async () => {
    const order: string[] = [];
    await runInChunks(ids(1200), async (chunk) => {
      order.push(`начали ${String(chunk.length)}`);
      await Promise.resolve();
      order.push(`кончили ${String(chunk.length)}`);
    });
    // Ни одна порция не начинается, пока не кончилась предыдущая.
    expect(order).toEqual([
      'начали 500',
      'кончили 500',
      'начали 500',
      'кончили 500',
      'начали 200',
      'кончили 200',
    ]);
  });

  it('пустой список не порождает ни одного запроса', async () => {
    let calls = 0;
    const { failed } = await runInChunks([], async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(failed).toEqual([]);
  });
});
