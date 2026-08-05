/**
 * Квота с единицей измерения.
 *
 * Главная беда старого поля была в том, что оно принимало одну строку и
 * само угадывало единицу: набранное «500» молча означало 500 БАЙТ, то есть
 * ящик почти нулевого размера. Здесь закреплено, что единица задаётся
 * отдельно и угадывать больше нечего.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_UNIT,
  QUOTA_UNITS,
  quotaToBytes,
  splitQuota,
  unitFactor,
  type QuotaUnit,
} from '../src/lib/quota';
import { formatBytes, parseBytes } from '../src/lib/format';

describe('quotaToBytes', () => {
  it('«500» с выбранной единицей МБ — это мегабайты, а не байты', () => {
    expect(quotaToBytes('500', 'МБ')).toBe(500 * 1024 ** 2);
    // Ровно та ошибка, ради которой поле переделано: разбор одной строкой
    // понимал «500» как 500 байт.
    expect(parseBytes('500')).toBe(500);
  });

  it('понимает целые и дробные числа', () => {
    expect(quotaToBytes('1', 'ГБ')).toBe(1024 ** 3);
    expect(quotaToBytes('1.5', 'ГБ')).toBe(1.5 * 1024 ** 3);
    expect(quotaToBytes('1,5', 'ГБ')).toBe(1.5 * 1024 ** 3);
  });

  it('ноль — это «без ограничения», а не ошибка', () => {
    expect(quotaToBytes('0', 'ГБ')).toBe(0);
    expect(formatBytes(0)).toBe('без ограничения');
  });

  it('не-число и пустая строка не проходят', () => {
    expect(quotaToBytes('', 'ГБ')).toBeNull();
    expect(quotaToBytes('   ', 'ГБ')).toBeNull();
    expect(quotaToBytes('много', 'ГБ')).toBeNull();
    expect(quotaToBytes('1 ГБ', 'ГБ')).toBeNull();
    expect(quotaToBytes('-1', 'ГБ')).toBeNull();
  });

  it('каждая единица кратна 1024, а не 1000', () => {
    expect(unitFactor('КБ')).toBe(1024);
    expect(unitFactor('МБ')).toBe(1024 ** 2);
    expect(unitFactor('ГБ')).toBe(1024 ** 3);
    expect(unitFactor('ТБ')).toBe(1024 ** 4);
  });
});

describe('splitQuota', () => {
  it('берёт самую крупную единицу, в которой число остаётся целым', () => {
    expect(splitQuota(1024 ** 3)).toEqual({ amount: 1, unit: 'ГБ' });
    expect(splitQuota(100 * 1024)).toEqual({ amount: 100, unit: 'КБ' });
    expect(splitQuota(512 * 1024 ** 2)).toEqual({ amount: 512, unit: 'МБ' });
    expect(splitQuota(2 * 1024 ** 4)).toEqual({ amount: 2, unit: 'ТБ' });
  });

  it('ноль показывается как 0 в единице по умолчанию', () => {
    expect(splitQuota(0)).toEqual({ amount: 0, unit: DEFAULT_QUOTA_UNIT });
  });

  it('значение возвращается в поле без потерь', () => {
    // Открыли ящик на правку и сохранили, ничего не меняя, — квота
    // обязана остаться прежней.
    for (const bytes of [1024, 100 * 1024, 1024 ** 2, 512 * 1024 ** 2, 1024 ** 3, 5 * 1024 ** 3]) {
      const split = splitQuota(bytes);
      expect(quotaToBytes(String(split.amount), split.unit)).toBe(bytes);
    }
  });
});

describe('единицы', () => {
  it('в списке есть и мегабайты, и гигабайты', () => {
    expect(QUOTA_UNITS).toContain('МБ');
    expect(QUOTA_UNITS).toContain('ГБ');
  });

  it('единица всегда написана рядом с числом', () => {
    // Ни одно значение не должно показываться голым числом.
    for (const unit of QUOTA_UNITS) {
      const bytes = quotaToBytes('3', unit as QuotaUnit);
      expect(bytes).not.toBeNull();
      expect(formatBytes(bytes as number)).toMatch(/(Б|КБ|МБ|ГБ|ТБ|ПБ)$/u);
    }
  });
});
