/**
 * Тесты правил фильтрации: разбор предзаполнения, сборка правила из формы
 * и описание правила для списка (research/mailru/05-filters.png).
 */

import { describe, expect, it } from 'vitest';
import type { Folder } from '@mail-true/shared';
import {
  buildRule,
  describeActions,
  describeConditions,
  emptyRule,
  isRuleComplete,
  moveRule,
  operatorsFor,
  parseRulePrefill,
  serializeRulePrefill,
  type FilterRule,
} from '../src/lib/filterRules';

const FOLDERS: Folder[] = [
  {
    id: '1',
    path: 'Важное',
    name: 'Важное',
    role: 'custom',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: false,
    uidValidity: 1,
  },
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

describe('parseRulePrefill', () => {
  it('«Создать фильтр» из письма подставляет отправителя', () => {
    const rule = parseRulePrefill('from:bank@example.com');
    expect(rule.conditions).toEqual([
      { field: 'from', operator: 'contains', value: 'bank@example.com' },
    ]);
  });

  it('понимает остальные поля', () => {
    expect(parseRulePrefill('subject:Счёт').conditions[0]?.field).toBe('subject');
  });

  it('мусор и неизвестное поле дают пустую заготовку, а не падение', () => {
    expect(parseRulePrefill('чепуха')).toEqual(emptyRule());
    expect(parseRulePrefill('unknown:x')).toEqual(emptyRule());
    expect(parseRulePrefill('from:')).toEqual(emptyRule());
    expect(parseRulePrefill(null)).toEqual(emptyRule());
  });

  it('сборка и разбор — обратные операции', () => {
    const value = 'bank@example.com';
    const rule = parseRulePrefill(serializeRulePrefill('from', value));
    expect(rule.conditions[0]?.value).toBe(value);
  });
});

describe('buildRule', () => {
  function draft(patch: Partial<FilterRule> = {}): FilterRule {
    return { ...emptyRule(), id: 'r1', ...patch };
  }

  it('выбрасывает пустые условия и обрезает пробелы', () => {
    const rule = buildRule(
      draft({
        conditions: [
          { field: 'from', operator: 'contains', value: '  bank@example.com  ' },
          { field: 'subject', operator: 'contains', value: '   ' },
        ],
      }),
    );
    expect(rule.conditions).toEqual([
      { field: 'from', operator: 'contains', value: 'bank@example.com' },
    ]);
  });

  it('чинит оператор, несовместимый с полем «Размер»', () => {
    const rule = buildRule(
      draft({ conditions: [{ field: 'size', operator: 'contains', value: '500' }] }),
    );
    expect(operatorsFor('size')).toContain(rule.conditions[0]?.operator);
    expect(rule.conditions[0]?.operator).toBe('greater');
  });

  it('пустые строки действий превращаются в null', () => {
    const rule = buildRule(
      draft({
        conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
        actions: { ...emptyRule().actions, forwardTo: '   ', autoReply: '' },
      }),
    );
    expect(rule.actions.forwardTo).toBeNull();
    expect(rule.actions.autoReply).toBeNull();
  });

  it('список «применить к уже полученным» без папки-приёмника не сохраняется', () => {
    const rule = buildRule(
      draft({
        conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
        actions: {
          ...emptyRule().actions,
          moveToFolderId: null,
          applyToExistingFolderIds: ['inbox'],
        },
      }),
    );
    expect(rule.actions.applyToExistingFolderIds).toEqual([]);
  });

  it('умолчания повторяют окно mail.ru: другие фильтры — да, спам — нет', () => {
    const actions = emptyRule().actions;
    expect(actions.continueOtherFilters).toBe(true);
    expect(actions.applyToSpam).toBe(false);
  });
});

describe('isRuleComplete', () => {
  it('правило без условий допустимо — это «Все письма», случай пересылки', () => {
    const forwarding = buildRule({
      ...emptyRule(),
      conditions: [],
      actions: { ...emptyRule().actions, forwardTo: 'admin@example.com' },
    });
    expect(forwarding.conditions).toEqual([]);
    expect(isRuleComplete(forwarding)).toBe(true);
    expect(describeConditions(forwarding)).toBe('Все письма');
  });

  it('правило без единого действия сохранить нельзя', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
    });
    expect(isRuleComplete(rule)).toBe(false);
  });

  it('одного действия достаточно', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: { ...emptyRule().actions, markRead: true },
    });
    expect(isRuleComplete(rule)).toBe(true);
  });
});

describe('describeConditions / describeActions', () => {
  it('условия читаются как в окне: поле, оператор, значение', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'bank@example.com' }],
    });
    expect(describeConditions(rule)).toBe('Поле «От» содержит bank@example.com');
  });

  it('правило без условий описывается как «Все письма»', () => {
    expect(describeConditions({ ...emptyRule(), conditions: [] })).toBe('Все письма');
  });

  it('действия перечисляются списком и папка называется по-русски', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: {
        ...emptyRule().actions,
        moveToFolderId: '1',
        markRead: true,
        forwardTo: 'admin@example.com',
        applyToSpam: true,
        continueOtherFilters: false,
      },
    });
    expect(describeActions(rule, FOLDERS)).toEqual([
      'Поместить в папку «Важное»',
      'Пометить прочитанным',
      'Переслать на: admin@example.com',
      'Применять к спаму',
      'Не выполнять другие фильтры после выполнения этого',
    ]);
  });

  it('системная папка в описании берёт русское имя по роли, а не IMAP-имя', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: { ...emptyRule().actions, moveToFolderId: 'inbox' },
    });
    expect(describeActions(rule, FOLDERS)[0]).toBe('Поместить в папку «Входящие»');
  });
});

describe('moveRule', () => {
  const rules: FilterRule[] = ['a', 'b', 'c'].map((id) => ({ ...emptyRule(), id }));

  it('поднимает и опускает правило', () => {
    expect(moveRule(rules, 'b', 'up').map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(moveRule(rules, 'b', 'down').map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('на границах списка порядок не меняется', () => {
    expect(moveRule(rules, 'a', 'up').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(moveRule(rules, 'c', 'down').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('неизвестный id ничего не ломает', () => {
    expect(moveRule(rules, 'нет такого', 'up').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
