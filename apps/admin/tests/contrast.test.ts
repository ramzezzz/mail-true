/**
 * Контраст в админке.
 *
 * Считаем по WCAG 2.1 (относительная яркость), а не сверяем строки: если
 * цвет однажды подкрутят «на глаз», проверка это заметит.
 *
 * На прежней палитре падали все проверки ниже. Замеры того, что было:
 *   «работает»     #0DC268 на #ECFAF3 — 2,19:1  (нужно 4,5)
 *   «не настроено» #ED330A на #FEEFEB — 3,69:1
 *   оранжевый      #FF9E00 на белом   — 2,07:1
 *   вторичный      #87898F на белом   — 3,50:1, на фоне страницы — 3,09:1
 *   ссылка         #0070f0 на подложке активного пункта меню — 3,52:1
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const admin = readFileSync(
  fileURLToPath(new URL('../src/styles/admin.css', import.meta.url)),
  'utf8',
);

/** Значение переменной из admin.css — берём то, что реально в стилях. */
function token(name: string): string {
  const match = admin.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`в admin.css нет цвета ${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4]
    .map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function ratio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Подложки, на которых в админке лежит текст. */
const SURFACE = '#FFFFFF'; // --mt-color-background-content
const PAGE = '#F0F1F3'; // --mt-color-background-secondary
const OK_TINT = '#ECFAF3'; // --mt-color-background-positive-tint
const FAIL_TINT = '#FEEFEB'; // --mt-color-background-negative-tint
/** Подложка активного пункта меню: rgba(0,119,255,.2) поверх белого. */
const MENU_ACTIVE = '#CCE4FF';

const TEXT_MIN = 4.5;

describe('значки состояния сервисов читаются', () => {
  it('«работает» — по нему судят, всё ли живо', () => {
    const value = ratio(token('--mt-admin-ok'), OK_TINT);
    expect(
      value,
      `${token('--mt-admin-ok')} на ${OK_TINT} = ${value.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('«не настроено» и «не отвечает»', () => {
    const value = ratio(token('--mt-admin-fail'), FAIL_TINT);
    expect(value, `= ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('предупреждение', () => {
    const value = ratio(token('--mt-admin-warn'), SURFACE);
    expect(value, `= ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('те же цвета рисуют рамку значка — ей хватает 3:1', () => {
    for (const name of ['--mt-admin-ok', '--mt-admin-fail'] as const) {
      expect(ratio(token(name), SURFACE)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('вторичный текст читается на обеих подложках', () => {
  // Им подписаны плитки сводки, заголовки таблиц, роль в шапке,
  // пустые состояния и «скоро» в меню — то есть половина экрана
  it('на белой карточке', () => {
    const value = ratio(token('--mt-color-text-secondary'), SURFACE);
    expect(value, `= ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('на фоне страницы', () => {
    const value = ratio(token('--mt-color-text-secondary'), PAGE);
    expect(value, `= ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
  });
});

describe('ссылки и активный пункт меню', () => {
  it('ссылка на белом', () => {
    const value = ratio(token('--mt-color-text-link'), SURFACE);
    expect(value, `= ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('активный пункт меню — на своей синей подложке', () => {
    const value = ratio(token('--mt-color-text-link'), MENU_ACTIVE);
    expect(value, `= ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
  });
});

describe('недоступная кнопка', () => {
  it('гасится заливкой, а не прозрачностью', () => {
    // Прозрачность 0,48 поверх синей заливки давала белой подписи 1,39:1 —
    // надпись просто исчезала
    const rule = admin.slice(admin.indexOf('button:disabled:disabled'));
    const body = rule.slice(rule.indexOf('{') + 1, rule.indexOf('}'));
    expect(body).toMatch(/opacity:\s*1/);
    expect(body).toContain('background');
  });

  it('курсор честно говорит «нельзя»', () => {
    const rule = admin.slice(admin.indexOf('button:disabled:disabled'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('cursor: not-allowed');
  });

  it('подпись на погашенной кнопке читается', () => {
    const rule = admin.slice(admin.indexOf('button:disabled:disabled'));
    const colour = rule.slice(0, rule.indexOf('}')).match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(colour, 'у недоступной кнопки не задан цвет подписи').toBeDefined();
    const value = ratio(colour!, PAGE);
    expect(value, `= ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
  });
});

describe('переопределения не задевают тёмную тему', () => {
  it('тёмные значения токенов заданы только для светлой темы', () => {
    // Иначе admin.css, подключённый последним, перекрыл бы и тёмную тему
    const at = admin.indexOf('--mt-color-text-secondary:');
    const selector = admin.lastIndexOf('{', at);
    const head = admin.slice(admin.lastIndexOf('}', selector) + 1, selector);
    expect(head).toContain("[data-theme='light']");
  });
});
