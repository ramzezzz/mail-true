// @vitest-environment jsdom
/**
 * Окно «Создание фильтра»: новые условия и новые действия.
 *
 * Проверяется не вёрстка, а обещания, которые окно даёт человеку:
 *
 *   - у условия «Вложение» нет поля значения — спрашивается наличие;
 *   - метки берутся из справочника ящика, а не выдумываются окном;
 *   - безвозвратное удаление показывает предупреждение, и оно появляется
 *     ТОЛЬКО у него. Это единственное действие правила, последствия
 *     которого нельзя отменить ничем, и молчаливым оно быть не должно.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import type { Folder } from '@mail-true/shared';
import { emptyRule, type FilterRule } from '../src/lib/filterRules';
import type { MailLabel } from '../src/mail/labelsApi';
import { FilterDialog } from '../src/settings/FilterDialog';

let host: HTMLDivElement;
let root: Root;

const FOLDERS: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: true,
    uidValidity: 1,
  },
];

const LABELS: MailLabel[] = [
  { key: 'mt-scheta', name: 'Счета', color: 'orange', position: 0 },
  { key: 'mt-srochno', name: 'Срочно', color: 'red', position: 1 },
];

function render(initial: FilterRule, onSave = vi.fn()) {
  act(() => {
    root.render(
      <FilterDialog
        initial={initial}
        folders={FOLDERS}
        labels={LABELS}
        saving={false}
        onSave={onSave}
        onClose={() => undefined}
      />,
    );
  });
  return onSave;
}

/** Список по доступному имени — так же, как его находит человек. */
function selectByLabel(name: string): HTMLSelectElement {
  const found = [...host.querySelectorAll('select')].find(
    (el) => el.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`Нет списка «${name}»`);
  return found as HTMLSelectElement;
}

function setSelect(name: string, value: string) {
  const el = selectByLabel(name);
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function checkboxByLabel(text: string): HTMLInputElement {
  const found = [...host.querySelectorAll('label')].find((el) =>
    (el.textContent ?? '').includes(text),
  );
  const input = found?.querySelector('input[type="checkbox"]');
  if (!input) throw new Error(`Нет флажка «${text}»`);
  return input as HTMLInputElement;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('условия', () => {
  it('у «Вложения» нет поля значения, а у «Текста письма» есть', () => {
    render(emptyRule());
    expect(host.querySelector('input[aria-label="Значение"]')).not.toBeNull();

    setSelect('Поле письма', 'attachment');
    expect(host.querySelector('input[aria-label="Значение"]')).toBeNull();
    expect([...selectByLabel('Условие').options].map((o) => o.textContent)).toEqual(['есть', 'нет']);

    setSelect('Поле письма', 'body');
    expect(host.querySelector('input[aria-label="Значение"]')).not.toBeNull();
  });

  it('правило «письма со счетами» сохраняется целиком', () => {
    const onSave = render({
      ...emptyRule(),
      conditions: [
        { field: 'body', operator: 'contains', value: 'счёт' },
        { field: 'attachment', operator: 'has', value: '' },
      ],
      actions: { ...emptyRule().actions, markFlagged: true },
    });
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Сохранить');
    act(() => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0].conditions).toEqual([
      { field: 'body', operator: 'contains', value: 'счёт' },
      { field: 'attachment', operator: 'has', value: '' },
    ]);
  });
});

describe('метки', () => {
  it('предлагаются метки ящика и отмеченная попадает в правило', () => {
    const onSave = render(emptyRule());
    const scheta = checkboxByLabel('Счета');
    act(() => {
      scheta.click();
    });
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Сохранить');
    act(() => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSave.mock.calls[0]?.[0].actions.labelKeys).toEqual(['mt-scheta']);
  });
});

describe('удаление', () => {
  it('умолчание удаления — корзина, а не «навсегда»', () => {
    const onSave = render({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
    });
    setSelect('Действие', 'delete');
    expect(selectByLabel('Как удалить').value).toBe('trash');
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Сохранить');
    act(() => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSave.mock.calls[0]?.[0].actions.deleteMode).toBe('trash');
  });

  /*
   * Главное обещание раздела. Правило, молча стирающее почту, — самое
   * опасное, что можно завести в настройках, и человек обязан прочитать,
   * на что соглашается, ДО нажатия «Сохранить».
   */
  it('предупреждение появляется только у безвозвратного удаления', () => {
    render({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
    });
    const warning = () =>
      [...host.querySelectorAll('[role="alert"]')].find((el) =>
        (el.textContent ?? '').includes('навсегда'),
      );

    expect(warning()).toBeUndefined();
    setSelect('Действие', 'delete');
    expect(warning()).toBeUndefined();
    setSelect('Как удалить', 'purge');
    expect(warning()).toBeDefined();
    expect(warning()?.textContent).toContain('вернуть их будет нельзя');
    setSelect('Как удалить', 'trash');
    expect(warning()).toBeUndefined();
  });

  it('удаление и папка-приёмник не соседствуют', () => {
    const onSave = render({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: { ...emptyRule().actions, moveToFolderId: 'inbox' },
    });
    setSelect('Действие', 'delete');
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Сохранить');
    act(() => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSave.mock.calls[0]?.[0].actions.moveToFolderId).toBeNull();
    expect(onSave.mock.calls[0]?.[0].actions.deleteMode).toBe('trash');
  });
});
