/**
 * Шаблон CSV для импорта — та его часть, что видит человек в панели.
 *
 * Раньше образец был показан на странице текстом: его выделяли мышью и
 * копировали руками. Теперь это скачиваемый файл, и он обязан открываться
 * в Excel без плясок с кодировкой.
 *
 * Что наш собственный разбор принимает этот текст — проверяется на стороне
 * сервера (apps/api/src/admin/csv.test.ts): шаблон и разбор лежат по разные
 * стороны, и договор между ними стережётся там, где живёт разбор.
 */
import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_FILENAME,
  TEMPLATE_ROWS,
  templateCsv,
  templateCsvWithBom,
} from '@shared/import-template';

describe('шаблон импорта', () => {
  it('первая строка — заголовок с теми именами столбцов, что понимает разбор', () => {
    expect(TEMPLATE_ROWS[0]).toBe('email,name,password,quota');
  });

  it('есть пара строк-примеров', () => {
    expect(TEMPLATE_ROWS.length - 1).toBeGreaterThanOrEqual(2);
  });

  it('примеры показывают, что пароль необязателен', () => {
    // Во второй строке-примере пароль пуст — иначе не видно, что его можно
    // не задавать и он будет сгенерирован.
    expect(TEMPLATE_ROWS[2]).toContain(',,');
  });

  it('переводы строк — CRLF, иначе Excel показывает файл одной строкой', () => {
    expect(templateCsv()).toContain('\r\n');
    expect(templateCsv().endsWith('\r\n')).toBe(true);
  });

  it('в файле есть метка кодировки — иначе Excel портит русские имена', () => {
    expect(templateCsvWithBom().charCodeAt(0)).toBe(0xfeff);
    // А в самом тексте метки быть не должно: она только в файле
    expect(templateCsv().charCodeAt(0)).not.toBe(0xfeff);
  });

  it('имя файла говорит, что это шаблон, и оканчивается на .csv', () => {
    expect(TEMPLATE_FILENAME).toMatch(/\.csv$/u);
  });
});
