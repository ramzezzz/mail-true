/**
 * Слова, которыми администратору сообщают, что случится с ЧУЖИМИ подписями.
 *
 * Проверка не косметическая. Требование было сформулировано прямо:
 * «молча затирать чужую подпись нельзя». Молчание — это не только
 * отсутствие текста, но и текст, из которого потерю не видно: бодрое
 * «применится к 12 ящикам» при пяти уничтоженных подписях ровно так же
 * оставляет администратора в неведении. Поэтому число затираемых подписей
 * обязано стоять в тексте первым и называться словом «уничтожено».
 */
import { describe, expect, it } from 'vitest';
import type { SignatureBulkCounts } from '../src/api/types';
import { bulkNeedsConfirmation, bulkResultText, bulkSummaryText, plural } from '../src/lib/signatureBulk';

function counts(over: Partial<SignatureBulkCounts> = {}): SignatureBulkCounts {
  return {
    total: 0,
    willAdd: 0,
    willReplace: 0,
    willSkipExisting: 0,
    willSkipIncomplete: 0,
    signaturesReplaced: 0,
    withExistingSignatures: 0,
    ...over,
  };
}

describe('склонение', () => {
  it('считает по-русски, а не «1 ящиков»', () => {
    expect(plural(1, 'ящик', 'ящика', 'ящиков')).toBe('ящик');
    expect(plural(2, 'ящик', 'ящика', 'ящиков')).toBe('ящика');
    expect(plural(5, 'ящик', 'ящика', 'ящиков')).toBe('ящиков');
    // Одиннадцать — не «одиннадцать ящик»
    expect(plural(11, 'ящик', 'ящика', 'ящиков')).toBe('ящиков');
    expect(plural(21, 'ящик', 'ящика', 'ящиков')).toBe('ящик');
  });
});

describe('сводка групповой установки', () => {
  it('называет число затираемых чужих подписей первым', () => {
    const text = bulkSummaryText(
      counts({ total: 12, willAdd: 7, willReplace: 5, signaturesReplaced: 8, withExistingSignatures: 5 }),
    );
    expect(text).toMatch(/^Будет уничтожено 8 существующих подписей/);
    expect(text).toContain('Подпись получат 12 ящиков из 12.');
  });

  it('не пугает потерями, когда терять нечего', () => {
    const text = bulkSummaryText(counts({ total: 3, willAdd: 3 }));
    expect(text).not.toMatch(/уничтожено/);
    expect(text).toContain('Подпись получат 3 ящика из 3.');
  });

  it('говорит о пропущенных и почему именно', () => {
    const text = bulkSummaryText(
      counts({ total: 5, willAdd: 2, willSkipExisting: 2, willSkipIncomplete: 1 }),
    );
    expect(text).toContain('подпись у них уже есть');
    expect(text).toContain('не хватает данных для подстановки');
  });

  it('честно сообщает, что подпись не достанется никому', () => {
    const text = bulkSummaryText(counts({ total: 4, willSkipExisting: 4 }));
    expect(text).toContain('Ни одному ящику подпись не достанется.');
  });

  it('пустая выборка не выдаётся за успех', () => {
    expect(bulkSummaryText(counts())).toBe('В выборке нет ни одного ящика.');
  });
});

describe('отдельная отмашка', () => {
  it('нужна ровно тогда, когда чужие подписи будут уничтожены', () => {
    expect(bulkNeedsConfirmation(counts({ total: 100, willAdd: 100 }))).toBe(false);
    expect(bulkNeedsConfirmation(counts({ total: 1, willReplace: 1, signaturesReplaced: 1 }))).toBe(
      true,
    );
  });
});

describe('итог применения', () => {
  it('называет и сделанное, и несделанное', () => {
    expect(bulkResultText(3, 5, 0)).toBe('Подпись установлена в 3 ящика из 5.');
    expect(bulkResultText(3, 5, 2)).toContain('Не удалось: 2 ящика.');
  });
});
