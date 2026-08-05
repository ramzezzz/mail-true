/** Клиентский разбор CSV для предварительного показа импорта. */
import { describe, expect, it } from 'vitest';
import { splitCsv, summarizeCsv } from '../src/lib/csvPreview';

describe('splitCsv', () => {
  it('разбирает запятые, кавычки и экранирование', () => {
    expect(splitCsv('a,b\n"стро, ка","он сказал ""да"""')).toEqual([
      ['a', 'b'],
      ['стро, ка', 'он сказал "да"'],
    ]);
  });

  it('определяет точку с запятой (Excel по-русски)', () => {
    expect(splitCsv('email;name\nivan@mail.local;Иван')).toEqual([
      ['email', 'name'],
      ['ivan@mail.local', 'Иван'],
    ]);
  });

  it('определяет табуляцию', () => {
    expect(splitCsv('email\tname\nivan@mail.local\tИван')).toEqual([
      ['email', 'name'],
      ['ivan@mail.local', 'Иван'],
    ]);
  });

  it('отбрасывает BOM и пустые строки, понимает CRLF', () => {
    expect(splitCsv('﻿email\r\n\r\na@mail.local\r\n')).toEqual([['email'], ['a@mail.local']]);
  });
});

describe('summarizeCsv', () => {
  it('распознаёт заголовок и столбцы', () => {
    const summary = summarizeCsv('email,name,password,quota\nivan@mail.local,Иван,parol12345,1G');
    expect(summary.hasHeader).toBe(true);
    expect(summary.columns).toEqual(['email', 'name', 'password', 'quota']);
    expect(summary.dataRows).toBe(1);
    expect(summary.notes).toEqual([]);
    expect(summary.sample[0]).toEqual({
      email: 'ivan@mail.local',
      name: 'Иван',
      quota: '1G',
      hasPassword: true,
    });
  });

  it('понимает русские названия столбцов в любом порядке', () => {
    const summary = summarizeCsv('Квота;Пароль;Адрес;ФИО\n1G;parol12345;ivan@mail.local;Иван');
    expect(summary.columns).toEqual(['quota', 'password', 'email', 'name']);
    expect(summary.sample[0]?.email).toBe('ivan@mail.local');
    expect(summary.sample[0]?.name).toBe('Иван');
  });

  it('без заголовка предупреждает и берёт порядок по умолчанию', () => {
    const summary = summarizeCsv('ivan@mail.local,Иван,parol12345,1G');
    expect(summary.hasHeader).toBe(false);
    expect(summary.dataRows).toBe(1);
    expect(summary.notes.join()).toMatch(/Заголовок не найден/);
  });

  it('предупреждает об отсутствии столбца с паролем', () => {
    const summary = summarizeCsv('email,name\nivan@mail.local,Иван');
    expect(summary.notes.join()).toMatch(/пароли будут сгенерированы/i);
    expect(summary.sample[0]?.hasPassword).toBe(false);
  });

  it('предупреждает об отсутствии столбца с адресом', () => {
    const summary = summarizeCsv('name,quota\nИван,1G');
    expect(summary.notes.join()).toMatch(/Не найден столбец с адресом/);
  });

  it('пустой файл не ломает разбор', () => {
    const summary = summarizeCsv('');
    expect(summary.dataRows).toBe(0);
    expect(summary.notes).toEqual(['Файл пуст']);
  });

  it('в образец попадает не больше запрошенного числа строк', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `u${i}@mail.local`).join('\n');
    const summary = summarizeCsv(`email\n${rows}`, 5);
    expect(summary.dataRows).toBe(20);
    expect(summary.sample).toHaveLength(5);
  });

  it('адреса приводятся к нижнему регистру', () => {
    const summary = summarizeCsv('email\n  IVAN@Mail.Local ');
    expect(summary.sample[0]?.email).toBe('ivan@mail.local');
  });
});
