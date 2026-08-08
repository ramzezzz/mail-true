/**
 * Тесты правил фильтрации: разбор предзаполнения, сборка правила из формы
 * и описание правила для списка (эталонные снимки интерфейса).
 */

import { describe, expect, it } from 'vitest';
import type { Folder } from '@mail-true/shared';
import {
  buildRule,
  conditionNeedsValue,
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

  it('умолчания повторяют окно привычных почтовых интерфейсов: другие фильтры — да, спам — нет', () => {
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

describe('текст письма и вложение', () => {
  it('у «Вложения» свои операторы и нет значения', () => {
    expect(operatorsFor('attachment')).toEqual(['has', 'has-not']);
    expect(conditionNeedsValue('attachment')).toBe(false);
    expect(conditionNeedsValue('body')).toBe(true);
  });

  it('условие «Вложение» сохраняется без значения, а не выбрасывается как пустое', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'attachment', operator: 'has', value: '' }],
      actions: { ...emptyRule().actions, markRead: true },
    });
    expect(rule.conditions).toEqual([{ field: 'attachment', operator: 'has', value: '' }]);
    expect(isRuleComplete(rule)).toBe(true);
  });

  it('оператор, оставшийся от прежнего поля, чинится', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'attachment', operator: 'contains', value: 'мусор' }],
      actions: { ...emptyRule().actions, markRead: true },
    });
    expect(rule.conditions[0]?.operator).toBe('has');
    expect(rule.conditions[0]?.value).toBe('');
  });

  it('правило «письма со счетами» описывается словами', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [
        { field: 'body', operator: 'contains', value: 'счёт' },
        { field: 'attachment', operator: 'has', value: '' },
      ],
      actions: { ...emptyRule().actions, markFlagged: true },
    });
    expect(describeConditions(rule)).toBe('Текст письма содержит счёт, Вложение есть');
  });
});

describe('метки и удаление', () => {
  const LABELS = [
    { key: 'mt-scheta', name: 'Счета' },
    { key: 'mt-srochno', name: 'Срочно' },
  ];

  it('одной метки достаточно, чтобы правило можно было сохранить', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: { ...emptyRule().actions, labelKeys: ['mt-scheta'] },
    });
    expect(isRuleComplete(rule)).toBe(true);
    expect(describeActions(rule, FOLDERS, LABELS)).toContain('Поставить метку: Счета');
  });

  it('метка называется именем, а без справочника — ключом, а не пропадает', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: { ...emptyRule().actions, labelKeys: ['mt-scheta'] },
    });
    expect(describeActions(rule, FOLDERS, [])).toContain('Поставить метку: mt-scheta');
  });

  it('повторы меток схлопываются', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: { ...emptyRule().actions, labelKeys: ['mt-scheta', 'mt-scheta'] },
    });
    expect(rule.actions.labelKeys).toEqual(['mt-scheta']);
  });

  /*
   * Удаление отменяет папку-приёмник: письмо нельзя одновременно положить
   * в «Счета» и выбросить. То же правило стоит и на сервере (webdto.ts) —
   * иначе список правил и файл Sieve поняли бы одно правило по-разному.
   */
  it('удаление отменяет папку-приёмник', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: { ...emptyRule().actions, moveToFolderId: '1', deleteMode: 'trash' },
    });
    expect(rule.actions.moveToFolderId).toBeNull();
    expect(describeActions(rule, FOLDERS)).toEqual(['Удалить (в корзину)']);
  });

  it('безвозвратное удаление называется в списке прямо', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: { ...emptyRule().actions, deleteMode: 'purge' },
    });
    expect(describeActions(rule, FOLDERS)).toEqual(['Удалить безвозвратно, минуя корзину']);
  });

  it('умолчание — не удалять: правило не должно стирать почту само собой', () => {
    expect(emptyRule().actions.deleteMode).toBeNull();
    expect(emptyRule().actions.labelKeys).toEqual([]);
  });

  it('прогон по уже полученным письмам имеет смысл и без папки-приёмника', () => {
    const rule = buildRule({
      ...emptyRule(),
      conditions: [{ field: 'from', operator: 'contains', value: 'a@b.c' }],
      actions: {
        ...emptyRule().actions,
        deleteMode: 'trash',
        applyToExistingFolderIds: ['inbox'],
      },
    });
    expect(rule.actions.applyToExistingFolderIds).toEqual(['inbox']);
  });
});
