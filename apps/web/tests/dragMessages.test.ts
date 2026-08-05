/**
 * Тесты полезной нагрузки при перетаскивании писем в папки.
 * Главное — папка не должна принимать посторонний перенос: текст из другого
 * окна не может внезапно «переместить» письма.
 */

import { describe, expect, it } from 'vitest';
import {
  MESSAGE_IDS_MIME,
  getDragMessages,
  isMessageDrag,
  setDragMessages,
} from '../src/lib/dragMessages';

/** Минимальная подделка DataTransfer: в node-окружении его нет. */
function fakeTransfer(initial: Record<string, string> = {}): DataTransfer {
  const data = new Map(Object.entries(initial));
  return {
    get types() {
      return [...data.keys()];
    },
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: (format: string, value: string) => void data.set(format, value),
    getData: (format: string) => data.get(format) ?? '',
  } as unknown as DataTransfer;
}

describe('setDragMessages / getDragMessages', () => {
  it('идентификаторы переживают перенос', () => {
    const transfer = fakeTransfer();
    setDragMessages(transfer, ['inbox:1', 'inbox:2']);
    expect(getDragMessages(transfer)).toEqual(['inbox:1', 'inbox:2']);
  });

  it('дублируется в text/plain — иначе браузер не начнёт перетаскивание', () => {
    const transfer = fakeTransfer();
    setDragMessages(transfer, ['inbox:1']);
    expect(transfer.getData('text/plain')).toBe('inbox:1');
    expect(transfer.effectAllowed).toBe('move');
  });
});

describe('isMessageDrag', () => {
  it('узнаёт свой перенос по собственному типу данных', () => {
    const transfer = fakeTransfer();
    setDragMessages(transfer, ['inbox:1']);
    expect(isMessageDrag(transfer)).toBe(true);
  });

  it('посторонний перенос не признаёт своим', () => {
    expect(isMessageDrag(fakeTransfer({ 'text/plain': 'что-то из другого окна' }))).toBe(false);
    expect(isMessageDrag(fakeTransfer({ Files: '' }))).toBe(false);
  });
});

describe('getDragMessages: испорченные данные', () => {
  it('не-JSON не роняет обработчик', () => {
    expect(getDragMessages(fakeTransfer({ [MESSAGE_IDS_MIME]: 'не json' }))).toEqual([]);
  });

  it('JSON не того вида даёт пустой список', () => {
    expect(getDragMessages(fakeTransfer({ [MESSAGE_IDS_MIME]: '{"a":1}' }))).toEqual([]);
  });

  it('нестроковые элементы отбрасываются', () => {
    expect(getDragMessages(fakeTransfer({ [MESSAGE_IDS_MIME]: '["inbox:1",7,null]' }))).toEqual([
      'inbox:1',
    ]);
  });

  it('пустой перенос — пустой список, а не исключение', () => {
    expect(getDragMessages(fakeTransfer())).toEqual([]);
  });
});
