/** Тесты разбора строки получателей окна написания письма. */

import { describe, expect, it } from 'vitest';
import { formatAddresses, parseAddresses } from '../src/lib/addresses';
import { formatChosen } from '../src/contacts/RecipientField';

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

/**
 * Имя с запятой — «Фамилия, Имя».
 *
 * Такие имена приходят к нам сами: их ставят корпоративные почтовые
 * системы, а наша подсказка поля «Кому» собирает имена из заголовков
 * полученных писем. Человек выбирает контакт из списка — и получает
 * ДВУХ получателей: несуществующего «Иванов» и настоящий адрес. Письмо
 * уходит с адресом, которого нет, и возвращается отказом.
 */
describe('запятая внутри имени получателя', () => {
  it('один контакт остаётся одним получателем', () => {
    expect(parseAddresses('"Иванов, Иван" <ivan@example.com>')).toEqual([
      { name: 'Иванов, Иван', address: 'ivan@example.com' },
    ]);
  });

  it('и рядом с другими адресами тоже', () => {
    expect(parseAddresses('a@b.ru, "Иванов, Иван" <ivan@example.com>; c@d.ru')).toEqual([
      { name: null, address: 'a@b.ru' },
      { name: 'Иванов, Иван', address: 'ivan@example.com' },
      { name: null, address: 'c@d.ru' },
    ]);
  });

  it('подсказка вставляет такое имя в кавычках', () => {
    const line = formatChosen({ address: 'ivan@example.com', name: 'Иванов, Иван', own: false });
    expect(parseAddresses(line)).toHaveLength(1);
  });

  /*
   * Оборот «черновик → открыть → сохранить». Получатели приходят с
   * сервера разобранными, в поле кладётся текст, при отправке он
   * разбирается снова. Несогласованность здесь означает, что адреса
   * меняются сами по себе — и с каждым открытием черновика их всё больше.
   */
  it('разбор и сборка согласованы', () => {
    const list = [
      { name: 'Иванов, Иван', address: 'ivan@example.com' },
      { name: 'Пётр "Петя" Петров', address: 'petr@example.com' },
      { name: null, address: 'a@b.ru' },
    ];
    expect(parseAddresses(formatAddresses(list))).toEqual(list);
  });
});
