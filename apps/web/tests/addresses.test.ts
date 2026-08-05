/** Тесты разбора строки получателей окна написания письма. */

import { describe, expect, it } from 'vitest';
import { parseAddresses } from '../src/lib/addresses';

describe('parseAddresses', () => {
  it('простые адреса через запятую и точку с запятой', () => {
    expect(parseAddresses('a@b.ru, c@d.ru; e@f.ru')).toEqual([
      { name: null, address: 'a@b.ru' },
      { name: null, address: 'c@d.ru' },
      { name: null, address: 'e@f.ru' },
    ]);
  });

  it('форма «Имя <адрес>»', () => {
    expect(parseAddresses('Анна Смирнова <a.smirnova@example.com>')).toEqual([
      { name: 'Анна Смирнова', address: 'a.smirnova@example.com' },
    ]);
  });

  it('пустая строка — пустой список', () => {
    expect(parseAddresses('')).toEqual([]);
    expect(parseAddresses('  ,  ')).toEqual([]);
  });
});
