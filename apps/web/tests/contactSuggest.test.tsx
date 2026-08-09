// @vitest-environment jsdom
/**
 * Подсказка адреса в поле «Кому».
 *
 * Проверяется не «список рисуется», а то, что легко сломать незаметно:
 *
 *   * запрос НЕ уходит на каждую букву, но всё-таки уходит;
 *   * уточнение запроса отвечается из памяти, не дожидаясь сервера;
 *   * уже введённые адреса не предлагаются повторно — и при этом
 *     остальные предлагаются;
 *   * поле целиком работает с клавиатуры;
 *   * НИЧЕГО не подставляется само: ни по Tab, ни по уходу фокуса.
 *
 * Каждое правило проверено в обе стороны. Проверка «Enter подставляет
 * адрес» без проверки «Tab не подставляет» пропустила бы поле, которое
 * дописывает адрес при любом удобном случае, — а это ровно тот случай,
 * когда письмо уходит не туда.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { useState } from 'react';
import {
  RecipientField,
  applyChoice,
  enteredAddresses,
  formatChosen,
  splitRecipients,
} from '../src/contacts/RecipientField';
import { answerFromMemory, SUGGEST_LIMIT } from '../src/contacts/useContactSuggest';
import type { ContactSuggestResponse, ContactSuggestion } from '../src/contacts/contactsApi';

let host: HTMLDivElement;
let root: Root;

interface Call {
  url: string;
  method: string;
  body: string | null;
}

let calls: Call[] = [];
let answer: (url: string) => ContactSuggestResponse;

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const body = url.includes('/suggest') ? answer(url) : { ok: true };
      return {
        ok: true,
        json: async () => body,
      } as unknown as Response;
    }),
  );
}

function person(address: string, name: string | null, own = true): ContactSuggestion {
  return { address, name, own };
}

/** Обёртка: поле с состоянием, как в окне написания письма. */
function Harness({ initial = '' }: { initial?: string }): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <div
      data-testid="outer"
      onKeyDown={(event) => {
        // Подделка окна написания: оно закрывается по Escape. Подсказка
        // обязана этот Escape перехватить, пока список открыт.
        if (event.key === 'Escape') escapesSeenByWindow += 1;
      }}
    >
      <RecipientField value={value} onChange={setValue} label="Кому" placeholder="Введите адрес" />
      <output data-testid="value">{value}</output>
    </div>
  );
}

let escapesSeenByWindow = 0;

function render(initial = ''): void {
  act(() => {
    root.render(<Harness initial={initial} />);
  });
}

const input = (): HTMLInputElement => {
  const element = host.querySelector('input[aria-label="Кому"]');
  if (!element) throw new Error('поля «Кому» нет');
  return element as HTMLInputElement;
};

const fieldValue = (): string => host.querySelector('[data-testid="value"]')?.textContent ?? '';

const options = (): HTMLElement[] => [...host.querySelectorAll('[role="option"]')] as HTMLElement[];

function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const element = input();
  act(() => {
    element.focus();
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(name: string): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

async function settle(ms = 220): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const suggestCalls = (): Call[] => calls.filter((c) => c.url.includes('/suggest'));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  escapesSeenByWindow = 0;
  answer = () => ({ items: [], complete: true });
  stubFetch();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Разбор строки получателей                                           */
/* ------------------------------------------------------------------ */

describe('разбор строки поля', () => {
  it('подсказывает по последнему набираемому адресу, а не по всей строке', () => {
    expect(splitRecipients('anna@example.com, пет')).toEqual({
      entered: ['anna@example.com'],
      current: ' пет',
    });
    expect(splitRecipients('')).toEqual({ entered: [], current: '' });
  });

  it('уже введённые адреса собираются из обеих форм записи', () => {
    expect(enteredAddresses('Анна <ANNA@example.com>; boris@example.com, пет')).toEqual([
      'anna@example.com',
      'boris@example.com',
    ]);
    // Обратный ход: набираемый сейчас адрес в исключения НЕ попадает,
    // иначе подсказка исчезала бы ровно на последней букве
    expect(enteredAddresses('anna@example.com')).toEqual([]);
  });

  it('выбор дописывается к уже введённому, а не затирает его', () => {
    const chosen = person('boris@example.com', 'Борис');
    expect(applyChoice('anna@example.com, бор', chosen)).toBe(
      'anna@example.com, Борис <boris@example.com>, ',
    );
    expect(applyChoice('бор', chosen)).toBe('Борис <boris@example.com>, ');
    // Без имени — голый адрес, без пустых угловых скобок
    expect(formatChosen(person('x@example.com', null))).toBe('x@example.com');
  });
});

/* ------------------------------------------------------------------ */
/* Память об уже полученном                                            */
/* ------------------------------------------------------------------ */

describe('память подсказки', () => {
  const short: ContactSuggestResponse = {
    items: [person('ivan@example.com', 'Иван'), person('igor@example.com', 'Игорь')],
    complete: true,
  };

  it('уточнённый запрос отбирается из уже полученного', () => {
    const memory = new Map([['и', short]]);
    expect(answerFromMemory(memory, 'ив')?.items.map((i) => i.address)).toEqual([
      'ivan@example.com',
    ]);
  });

  it('обрезанный список для отбора не годится', () => {
    // За обрезом могло остаться подходящее — отбор соврал бы про полноту
    const truncated: ContactSuggestResponse = {
      items: Array.from({ length: SUGGEST_LIMIT }, (_, i) =>
        person(`user${String(i)}@example.com`, null),
      ),
      complete: true,
    };
    expect(answerFromMemory(new Map([['u', truncated]]), 'user1')).toBeNull();
  });

  it('память о другом запросе не подходит', () => {
    expect(answerFromMemory(new Map([['ив', short]]), 'бор')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Поле целиком                                                        */
/* ------------------------------------------------------------------ */

describe('поле «Кому» с подсказкой', () => {
  it('пустое поле не спрашивает сервер', async () => {
    render();
    act(() => input().focus());
    await settle();
    expect(suggestCalls()).toHaveLength(0);
  });

  it('набранные буквы находят человека по имени и по адресу', async () => {
    answer = () => ({ items: [person('ivan.petrov@example.com', 'Иван Петров')], complete: true });
    render();
    type('пет');
    await settle();
    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent).toContain('Иван Петров');
    expect(options()[0]?.textContent).toContain('ivan.petrov@example.com');
  });

  it('запрос не уходит на каждую букву', async () => {
    answer = () => ({ items: [person('ivan@example.com', 'Иван')], complete: true });
    render();
    // Три нажатия подряд — быстрее задержки
    type('п');
    type('пе');
    type('пет');
    await settle();
    expect(suggestCalls()).toHaveLength(1);
    expect(suggestCalls()[0]?.url).toContain('q=%D0%BF%D0%B5%D1%82');
  });

  it('уточнение показывается сразу, не дожидаясь сервера', async () => {
    answer = () => ({
      items: [person('ivan@example.com', 'Иван'), person('igor@example.com', 'Игорь')],
      complete: true,
    });
    render();
    type('и');
    await settle();
    expect(options()).toHaveLength(2);

    // Сервер с этого момента отвечает медленно и НЕ тем же самым:
    // если бы поле ждало его, список был бы пуст или другим.
    answer = () => ({ items: [], complete: true });
    type('ив');
    // Ни одного оборота таймера — только синхронная перерисовка
    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent).toContain('ivan@example.com');
  });

  it('уже введённые адреса не предлагаются повторно', async () => {
    answer = (url) => {
      const excluded = new URL(url, 'http://x').searchParams.get('exclude');
      expect(excluded).toBe('anna@example.com');
      return { items: [person('anton@example.com', 'Антон')], complete: true };
    };
    render();
    type('Анна <anna@example.com>, ан');
    await settle();
    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent).toContain('anton@example.com');
  });

  it('стрелки и Enter выбирают адрес без мыши', async () => {
    answer = () => ({
      items: [person('ivan@example.com', 'Иван'), person('igor@example.com', 'Игорь')],
      complete: true,
    });
    render();
    type('и');
    await settle();

    // Первая строка выделена сразу — Enter не должен требовать стрелки
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    // По кругу: список короткий, упираться в край незачем
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');

    key('Enter');
    expect(fieldValue()).toBe('Игорь <igor@example.com>, ');
  });

  it('Escape закрывает подсказку, а не окно написания письма', async () => {
    answer = () => ({ items: [person('ivan@example.com', 'Иван')], complete: true });
    render();
    type('и');
    await settle();
    expect(options()).toHaveLength(1);

    key('Escape');
    expect(options()).toHaveLength(0);
    expect(escapesSeenByWindow).toBe(0);

    // Обратный ход: когда подсказки нет, Escape уходит наверх — иначе
    // окно написания перестало бы закрываться с клавиатуры
    key('Escape');
    expect(escapesSeenByWindow).toBe(1);
  });

  it('стрелка вниз возвращает закрытую подсказку', async () => {
    answer = () => ({ items: [person('ivan@example.com', 'Иван')], complete: true });
    render();
    type('и');
    await settle();
    key('Escape');
    expect(options()).toHaveLength(0);
    key('ArrowDown');
    expect(options()).toHaveLength(1);
  });

  it('Tab ничего не подставляет', async () => {
    answer = () => ({ items: [person('ivan@example.com', 'Иван')], complete: true });
    render();
    type('и');
    await settle();
    key('Tab');
    // Подстановка при уходе из поля — это письмо не тому адресату
    expect(fieldValue()).toBe('и');
    expect(options()).toHaveLength(0);
  });

  it('уход фокуса ничего не подставляет', async () => {
    answer = () => ({ items: [person('ivan@example.com', 'Иван')], complete: true });
    render();
    type('и');
    await settle();
    act(() => input().blur());
    expect(fieldValue()).toBe('и');
    expect(options()).toHaveLength(0);
  });

  it('щелчок по строке подставляет адрес', async () => {
    answer = () => ({ items: [person('ivan@example.com', 'Иван')], complete: true });
    render();
    type('и');
    await settle();
    act(() => options()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(fieldValue()).toBe('Иван <ivan@example.com>, ');
  });

  it('адрес убирается из подсказок сразу и насовсем', async () => {
    answer = () => ({
      items: [person('ivan@exmaple.com', 'Иван'), person('ivan@example.com', 'Иван')],
      complete: true,
    });
    render();
    type('ив');
    await settle();
    expect(options()).toHaveLength(2);

    const remove = host.querySelector('button[aria-label="Убрать ivan@exmaple.com из подсказок"]');
    expect(remove).not.toBeNull();
    act(() => remove?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Строка исчезает не дожидаясь сервера: иначе человек нажмёт ещё раз
    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent).toContain('ivan@example.com');

    const hide = calls.find((c) => c.url.includes('/api/contacts/hide'));
    expect(hide?.method).toBe('POST');
    expect(hide?.body).toBe(JSON.stringify({ address: 'ivan@exmaple.com' }));
    // Обратный ход: выбранный адрес при этом НЕ подставился
    expect(fieldValue()).toBe('ив');
  });

  it('пока указатель разбирается, вместо «ничего нет» говорится правда', async () => {
    answer = () => ({ items: [], complete: false });
    render();
    type('ив');
    await settle();
    expect(host.textContent).toContain('Собираем адреса');

    // Обратный ход: указатель разобран целиком — молчим, а не пугаем
    answer = () => ({ items: [], complete: true });
    type('ива');
    await settle();
    expect(host.textContent).not.toContain('Собираем адреса');
  });

  it('отказ сервера не мешает набирать адрес руками', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response),
    );
    render();
    type('ив');
    await settle();
    expect(options()).toHaveLength(0);
    expect(fieldValue()).toBe('ив');
  });

  it('неотвеченный запрос не запоминается как «ничего не найдено»', async () => {
    /*
     * Перезапуск API (502 от nginx), истёкшая сессия, пропавшая сеть — всё
     * это отдавало пустой список, неотличимый от честного ответа, и он
     * ложился в память окна навсегда. Человек, набравший «пет» в неудачную
     * секунду, больше не получал подсказку по этим буквам НИКОГДА: стирал
     * букву, дописывал обратно — пусто, до закрытия окна письма.
     */
    let broken = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url, method: 'GET', body: null });
        if (broken) return { ok: false, json: async () => ({}) } as unknown as Response;
        return {
          ok: true,
          json: async () => ({ items: [person('petrov@example.com', 'Пётр')], complete: true }),
        } as unknown as Response;
      }),
    );

    render();
    type('пет');
    await settle();
    expect(options()).toHaveLength(0);
    expect(suggestCalls()).toHaveLength(1);

    // Сервер вернулся. Человек стёр буквы и набрал те же самые заново.
    broken = false;
    type('');
    await settle();
    type('пет');
    await settle();

    expect(suggestCalls()).toHaveLength(2);
    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent).toContain('petrov@example.com');
  });
});
