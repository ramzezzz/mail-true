/**
 * Разбор полей раздела «Помощник ИИ».
 *
 * Форма не должна отправлять на сервер того, что он всё равно отвергнет,
 * и не должна молча подменять «без предела» нулём — это ровно те места,
 * где ошибка стоит денег или утечки.
 */
import { describe, expect, it } from 'vitest';
import {
  canEnable,
  endpointOf,
  errorLabel,
  formatDuration,
  isValidBaseUrl,
  parseLimit,
  parseNumber,
  periodLabel,
  periodOptions,
  rangeSince,
  technicalTitle,
} from '../src/lib/ai';
import type { AiFeatureInfo } from '../src/api/types';

describe('parseLimit', () => {
  it('пустое поле — это «без предела», а не ноль', () => {
    expect(parseLimit('')).toEqual({ ok: true, value: null });
    expect(parseLimit('   ')).toEqual({ ok: true, value: null });
  });

  it('разбирает целое число, в том числе с пробелами между разрядов', () => {
    expect(parseLimit('1000')).toEqual({ ok: true, value: 1000 });
    expect(parseLimit('100 000')).toEqual({ ok: true, value: 100000 });
  });

  it('не принимает мусор, ноль и дробные', () => {
    expect(parseLimit('0')).toEqual({ ok: false });
    expect(parseLimit('-5')).toEqual({ ok: false });
    expect(parseLimit('1.5')).toEqual({ ok: false });
    expect(parseLimit('много')).toEqual({ ok: false });
  });
});

describe('parseNumber', () => {
  it('держится границ сервера', () => {
    expect(parseNumber('20000', 200, 200_000)).toBe(20000);
    expect(parseNumber('199', 200, 200_000)).toBeNull();
    expect(parseNumber('200001', 200, 200_000)).toBeNull();
    expect(parseNumber('', 200, 200_000)).toBeNull();
  });
});

describe('окно учёта расходов', () => {
  it('называет привычные окна словами', () => {
    expect(periodLabel(86_400_000)).toBe('сутки');
    expect(periodLabel(3_600_000)).toBe('час');
    expect(periodLabel(604_800_000)).toBe('неделя');
  });

  it('нестандартное окно не теряется и не подменяется', () => {
    expect(periodLabel(7_200_000)).toBe('2 ч');
    const options = periodOptions(7_200_000);
    expect(options[0]).toEqual({ ms: 7_200_000, label: '2 ч' });
    expect(options).toHaveLength(5);
  });

  it('привычное окно не дублируется', () => {
    expect(periodOptions(86_400_000)).toHaveLength(4);
  });
});

describe('адрес сервиса', () => {
  it('принимает только http и https', () => {
    expect(isValidBaseUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isValidBaseUrl('https://api.example.com/v1')).toBe(true);
    expect(isValidBaseUrl('ftp://example.com')).toBe(false);
    expect(isValidBaseUrl('127.0.0.1:11434')).toBe(false);
    expect(isValidBaseUrl('')).toBe(false);
  });

  it('складывает полный адрес запроса без двойных косых', () => {
    expect(endpointOf('http://127.0.0.1:11434/v1/', '/chat/completions')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
    expect(endpointOf(null, '/chat/completions')).toBe('— адрес не задан —');
  });

  it('включить помощника без адреса и модели нельзя', () => {
    expect(canEnable('http://localhost/v1', 'qwen')).toBe(true);
    expect(canEnable('', 'qwen')).toBe(false);
    expect(canEnable('http://localhost/v1', '  ')).toBe(false);
  });
});

describe('подписи журнала', () => {
  it('переводит причины отказа', () => {
    expect(errorLabel('budget-exceeded')).toBe('исчерпан предел расходов');
    expect(errorLabel(null)).toBe('—');
    expect(errorLabel('невиданное')).toBe('невиданное');
  });

  it('показывает длительность по-человечески', () => {
    expect(formatDuration(850)).toBe('850 мс');
    expect(formatDuration(12_500)).toBe('12,5 с');
  });

  it('называет техническую возможность так же, как в настройках', () => {
    const features: AiFeatureInfo[] = [
      {
        key: 'summary',
        title: 'Краткое резюме',
        description: '',
        sends: '',
        technical: ['summarize.message', 'summarize.thread'],
        defaultOn: true,
      },
    ];
    expect(technicalTitle(features, 'summarize.thread')).toBe('Краткое резюме');
    expect(technicalTitle(features, 'translate')).toBe('translate');
  });
});

describe('период журнала', () => {
  it('за всё время границы нет', () => {
    expect(rangeSince('all')).toBeUndefined();
  });

  it('сутки отсчитываются от переданного момента', () => {
    const now = Date.parse('2026-08-05T12:00:00.000Z');
    expect(rangeSince('day', now)).toBe('2026-08-04T12:00:00.000Z');
    expect(rangeSince('hour', now)).toBe('2026-08-05T11:00:00.000Z');
  });
});
