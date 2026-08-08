// @vitest-environment jsdom
/**
 * Анатомия строки списка писем — сверка с живым привычный почтовый интерфейс.
 *
 * Эталон лежит в справочник по вёрстке:
 *   row-anatomy.json — строка .llc: сама строка x=232 (в край колонки),
 *                      колонка статуса 28×48, аватар 32×32 с x=260;
 *   01-inbox.png     — пипеткой: заголовок периода «Сегодня» тёмный
 *                      rgb(44,45,46) и начинается на x=260, разделитель
 *                      строк идёт с x=308, счётчик цепочки — серая пилюля
 *                      в колонке ТЕМЫ (x=588) перед самой темой;
 *   10-selection.png — выделенная строка залита rgb(235,236,239) = #EBECEF,
 *                      чекбокс лежит прямо на этой заливке, без белого кружка.
 *
 * Всё это на старом коде расходилось: список отступал 8px от края колонки,
 * заголовок периода был серым #87898F с отступом 68px (ни над одной из
 * колонок), счётчик цепочки стоял после имени отправителя, а под чекбоксом
 * был белый кружок цвета карточки.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { MessageSummary } from '@mail-true/shared';
import { MessageList } from '../src/mail/MessageList';
import { useUiStore } from '../src/app/store';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const listCss = readFileSync(join(SRC, 'mail/MessageList.module.css'), 'utf8');

/** Тело правила по селектору (первое вхождение). */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `в CSS нет правила ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('колонки строки списка совпадают с эталонной вёрсткой', () => {
  it('строка идёт в край колонки: у прокрутки нет боковых полей', () => {
    // Было `padding: 0 8px` — весь список стоял на x=240 при колонке 232
    expect(rule(listCss, '.scroll')).toMatch(/padding:\s*0;/u);
  });

  it('колонка статуса 28px, аватар отступает 16px — вместе ровно 76px', () => {
    expect(rule(listCss, '.readStatus')).toMatch(/width:\s*28px/u);
    expect(rule(listCss, '.avatarCell')).toMatch(/margin-right:\s*16px/u);
    // Разделитель начинается там же, где текстовые колонки: 28 + 32 + 16
    expect(rule(listCss, '.row::after')).toMatch(/left:\s*76px/u);
  });

  it('заголовок периода — тёмный и ровно над левым краем аватара', () => {
    const header = rule(listCss, '.periodHeader');
    expect(header, 'цвет: был вторичный серый #87898F').toContain(
      'color: var(--mt-color-text-primary)',
    );
    // 28px — ширина .readStatus, то есть левый край аватара
    expect(header, 'отступ слева: был 68px').toMatch(/padding:\s*0 12px 6px 28px/u);
  });

  it('под чекбоксом фон строки, а не белый кружок карточки', () => {
    const checkbox = rule(listCss, '.rowCheckbox');
    expect(checkbox).toContain('background: var(--row-bg)');
    expect(checkbox).not.toContain('--mt-app-content-bg');
  });

  it('лента «важное» покрашена мейловым #FC2C38, а не общим accent-red', () => {
    const flag = rule(listCss, '.flagIcon');
    expect(flag).toContain('--mt-mail-color-icon-favorite');
    expect(flag).not.toContain('--mt-color-accent-red');
  });
});

/* ------------------------------------------------------------------ */
/* Счётчик цепочки — в колонке темы                                     */
/* ------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;

function summary(uid: number, threadId: string): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId,
    from: { name: 'Пётр Смирнов', address: 'p@example.com' },
    to: [],
    cc: [],
    subject: `Тема письма ${uid}`,
    snippet: 'начало текста',
    date: new Date(2026, 7, 5, 12, uid).toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 1024,
  };
}

/**
 * jsdom не считает размеров: offsetWidth/offsetHeight у него всегда нули,
 * а виртуализация меряет контейнер прокрутки именно ими — при нулевой
 * высоте она не отрисовывает ни одной строки. Выдаём ей окно 1200×800.
 */
function stubLayout() {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 1200,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 800,
  });
}

beforeEach(() => {
  stubLayout();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ selectedIds: new Set<string>() });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('счётчик писем в цепочке', () => {
  it('стоит в колонке темы перед темой, а не после отправителя', () => {
    // Два письма одной цепочки — счётчик показывается
    const messages = [summary(1, 't-1'), summary(2, 't-1')];
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={messages} />
        </MemoryRouter>,
      );
    });

    const badge = host.querySelector('[class*="threadCount"]');
    expect(badge, 'счётчик цепочки не отрисовался').not.toBeNull();
    expect(badge!.textContent).toBe('2');

    // Родитель счётчика — колонка темы, а не колонка отправителя.
    // Раньше он лежал внутри .correspondent сразу за именем.
    const parentClass = badge!.parentElement?.className ?? '';
    expect(parentClass, `счётчик лежит в «${parentClass}»`).toMatch(/title/u);
    expect(parentClass).not.toMatch(/correspondent/u);

    // И идёт ПЕРЕД темой: в привычных почтовых интерфейсах пилюля слева от неё
    const subject = host.querySelector('[class*="subject"]')!;
    expect(badge!.compareDocumentPosition(subject) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
