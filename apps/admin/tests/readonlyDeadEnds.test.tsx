/**
 * Роль «только чтение» не должна упираться в тупик.
 *
 * Требование к панели: дежурный, который разбирает обращение, видит всё,
 * но ничего не меняет. Дежурному нельзя показывать кнопок, которых у него
 * нет, — и нельзя показывать пустой экран без объяснения.
 *
 * Диалог DNS нарушал оба правила разом. Кнопка «Проверить DNS» в строке
 * домена показывалась ВСЕМ (в отличие от «Ключ DKIM», спрятанного правом),
 * но у роли «только чтение» она не запускала проверку: 403 не приходил,
 * потому что запрос вообще не уходил. А если проверок по домену ещё не
 * было, диалог сообщал: «Проверка ещё не запускалась. Нажмите „Проверить
 * заново“» — при том что эта кнопка у него же и спрятана.
 *
 * Получалась инструкция, указывающая на кнопку, которой нет на экране.
 * Это хуже отказа: 403 хотя бы объясняет, что прав не хватает.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DnsDialog } from '../src/pages/DnsDialog';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(canCheck: boolean): void {
  act(() => {
    root.render(
      <DnsDialog
        domainName="mail.local"
        report={null}
        checking={false}
        checkingIds={[]}
        error={null}
        canCheck={canCheck}
        onRecheck={() => undefined}
        onRecheckOne={() => undefined}
        onClose={() => undefined}
      />,
    );
  });
}

/** Есть ли на экране кнопка с такой подписью. */
function hasButton(label: string): boolean {
  return [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === label);
}

describe('диалог DNS без единой проверки', () => {
  it('тому, кто может проверить, называет кнопку — и она на экране есть', () => {
    render(true);
    expect(container.textContent ?? '').toContain('Проверить заново');
    expect(hasButton('Проверить заново'), 'кнопка названа, но её нет').toBe(true);
  });

  it('роли «только чтение» не советует нажать спрятанную кнопку', () => {
    render(false);
    expect(hasButton('Проверить заново'), 'кнопка должна быть спрятана').toBe(false);
    expect(
      container.textContent ?? '',
      'текст отправляет искать кнопку, которой на экране нет',
    ).not.toContain('Нажмите «Проверить заново»');
  });

  it('роли «только чтение» объясняет, чего не хватает и что делать', () => {
    render(false);
    const text = container.textContent ?? '';
    // Пустой экран без объяснения — тоже дефект: человек решит, что панель
    // сломана. Должно быть сказано и про права, и про выход из положения.
    expect(text).toMatch(/прав|может только|доверено/iu);
    expect(text).toMatch(/попросите|обратитесь/iu);
  });
});
