/**
 * График не должен называть свои числа чужим именем.
 *
 * Панель «Пиковые часы» брала ряд `sent` из реестра почтового потока, и
 * подсказка при наведении честно печатала его название — «Доставлено: 38».
 * А запрос за этими числами (hourlyProfile) считает ВСЕ состояния разом:
 * доставленные, отложенные, отбитые и отклонённые на приёме.
 *
 * Для администратора это не мелочь. Он сверяет пик с кольцом «Доли
 * состояний» на том же экране, числа не сходятся — и он идёт искать
 * поломку в доставке, которой нет. Ровно тот случай, когда панель
 * выглядит рабочей и при этом вводит в заблуждение.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_SERIES, FLOW_SERIES, HOURLY_SERIES, seriesOf } from '../src/lib/chartSeries';

const overview = readFileSync(
  fileURLToPath(new URL('../src/pages/OverviewPage.tsx', import.meta.url)),
  'utf8',
);

describe('«Пиковые часы»', () => {
  it('рисуются своим рядом, а не заимствованным у доставленных', () => {
    // Вырезаем разметку панели: проверять надо именно её, а не файл целиком.
    const at = overview.indexOf('Пиковые часы');
    expect(at, 'панель «Пиковые часы» пропала из дашборда').toBeGreaterThan(0);
    const block = overview.slice(at, at + 900);
    expect(block).toContain('HOURLY_SERIES');
    expect(
      block,
      'панель снова берёт ряд «Доставлено», хотя считает письма всех состояний',
    ).not.toMatch(/seriesOf\(\s*FLOW_SERIES/u);
  });

  it('название ряда не обещает одно состояние', () => {
    const series = seriesOf(HOURLY_SERIES, 'hourlyTotal');
    // Ни одно из названий состояний не должно оказаться названием ряда,
    // который считает их сумму.
    for (const flow of FLOW_SERIES) {
      expect(series.title).not.toBe(flow.title);
    }
    expect(series.title).toMatch(/всего/iu);
  });

  it('ряд есть в общем реестре — иначе он выпадет из проверок контраста', () => {
    expect(ALL_SERIES.map((s) => s.id)).toContain('hourlyTotal');
  });
});

describe('очередь длиннее предела разбора', () => {
  it('дашборд предупреждает о неполноте, а не выдаёт предел за факт', () => {
    // Раздел «Почтовый поток» об этом предупреждал, а дашборд показывал
    // ровно 20 000 как точное число — два раздела расходились в показаниях.
    expect(overview).toContain('queue.truncated');
    expect(overview).toMatch(/длиннее предела разбора/u);
  });
});
