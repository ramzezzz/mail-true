/**
 * Правила фильтрации: модель, разбор и сборка.
 *
 * Набор условий и действий взят один в один с окна «Создание фильтра»
 * (research/mailru/06-filter-editor.png и 07-filter-all-actions.png).
 * Он же ровно ложится на Sieve — язык фильтрации Dovecot, — поэтому своей
 * машины исполнения не потребуется: сервер транслирует правило в Sieve.
 *
 * Здесь три вещи:
 *   - `buildRule` — сборка: форма окна → нормализованное правило;
 *   - `parseRulePrefill` — разбор: «Создать фильтр» из контекстного меню
 *     письма приходит адресом `/settings/filters?new=from:вася@почта`;
 *   - `describeRule` — человекочитаемое описание для списка правил.
 */

import type { Folder } from '@mail-true/shared';
import { folderTitle } from './folderNames';

export type FilterField = 'from' | 'to' | 'subject' | 'cc' | 'size';

export const FIELD_TITLES: Record<FilterField, string> = {
  from: 'Поле «От»',
  to: 'Поле «Кому»',
  subject: 'Поле «Тема»',
  cc: 'Поле «Копия»',
  size: 'Размер, Кб',
};

export type FilterOperator = 'contains' | 'not-contains' | 'equals' | 'greater' | 'less';

export const OPERATOR_TITLES: Record<FilterOperator, string> = {
  contains: 'содержит',
  'not-contains': 'не содержит',
  equals: 'совпадает с',
  greater: 'больше чем',
  less: 'меньше чем',
};

/** Размер сравнивается числом, остальные поля — текстом. */
export const TEXT_OPERATORS: readonly FilterOperator[] = ['contains', 'not-contains', 'equals'];
export const SIZE_OPERATORS: readonly FilterOperator[] = ['greater', 'less', 'equals'];

export function operatorsFor(field: FilterField): readonly FilterOperator[] {
  return field === 'size' ? SIZE_OPERATORS : TEXT_OPERATORS;
}

export interface FilterCondition {
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

export interface FilterActions {
  /** id папки-приёмника или null — не перекладывать. */
  moveToFolderId: string | null;
  markRead: boolean;
  markFlagged: boolean;
  /** Прогнать правило по уже полученной почте в этих папках. */
  applyToExistingFolderIds: string[];
  /** Адрес пересылки копии или null. */
  forwardTo: string | null;
  /** Текст автоответа или null. */
  autoReply: string | null;
  /** После срабатывания применять другие фильтры — по умолчанию включено. */
  continueOtherFilters: boolean;
  /** Применять фильтр к спаму — по умолчанию выключено. */
  applyToSpam: boolean;
}

export interface FilterRule {
  id: string;
  enabled: boolean;
  conditions: FilterCondition[];
  actions: FilterActions;
  /** Правило, заведённое сервисом самостоятельно (флажок «Показывать автофильтры»). */
  auto: boolean;
}

export const DEFAULT_ACTIONS: FilterActions = {
  moveToFolderId: null,
  markRead: false,
  markFlagged: false,
  applyToExistingFolderIds: [],
  forwardTo: null,
  autoReply: null,
  continueOtherFilters: true,
  applyToSpam: false,
};

export function emptyCondition(): FilterCondition {
  return { field: 'from', operator: 'contains', value: '' };
}

/** Заготовка нового правила: одно пустое условие «От содержит …». */
export function emptyRule(): FilterRule {
  return {
    id: '',
    enabled: true,
    conditions: [emptyCondition()],
    actions: { ...DEFAULT_ACTIONS, applyToExistingFolderIds: [] },
    auto: false,
  };
}

/**
 * Сборка правила из формы окна: обрезаем пробелы, выбрасываем пустые условия
 * и действия-пустышки, чиним операторы, несовместимые с полем.
 *
 * Возвращает нормализованное правило — именно оно уходит на сервер и именно
 * его показывает список, поэтому нормализация должна быть в одном месте.
 */
export function buildRule(draft: FilterRule): FilterRule {
  const conditions = draft.conditions
    .map((c) => ({ ...c, value: c.value.trim() }))
    .filter((c) => c.value.length > 0)
    .map((c) =>
      operatorsFor(c.field).includes(c.operator)
        ? c
        : // Поле сменили на «Размер», а оператор остался текстовым —
          // берём первый допустимый, иначе правило не переведётся в Sieve.
          { ...c, operator: operatorsFor(c.field)[0] ?? 'contains' },
    );

  const forwardTo = draft.actions.forwardTo?.trim() ?? '';
  const autoReply = draft.actions.autoReply?.trim() ?? '';

  return {
    ...draft,
    conditions,
    actions: {
      ...draft.actions,
      forwardTo: forwardTo.length > 0 ? forwardTo : null,
      autoReply: autoReply.length > 0 ? autoReply : null,
      // Список папок имеет смысл только вместе с папкой-приёмником:
      // «применить к уже полученным» — это перекладывание задним числом.
      applyToExistingFolderIds:
        draft.actions.moveToFolderId === null ? [] : [...draft.actions.applyToExistingFolderIds],
    },
  };
}

/**
 * Правило можно сохранить, если задано хотя бы одно действие.
 *
 * Условия НЕ обязательны: правило без условий применяется ко всем письмам —
 * именно так выглядит «Добавить пересылку» и правило «Все письма» в списке
 * mail.ru (research/mailru/05-filters.png). Правило без действий, наоборот,
 * бессмысленно: оно ничего не сделает.
 */
export function isRuleComplete(rule: FilterRule): boolean {
  const a = rule.actions;
  return (
    a.moveToFolderId !== null ||
    a.markRead ||
    a.markFlagged ||
    a.forwardTo !== null ||
    a.autoReply !== null
  );
}

/**
 * Разбор параметра предзаполнения `?new=<поле>:<значение>`.
 *
 * Так открывается окно из пункта «Создать фильтр» контекстного меню письма:
 * поле уже выбрано, значение подставлено. Неизвестное поле и мусор дают
 * пустую заготовку — адресную строку правит пользователь, падать нельзя.
 */
export function parseRulePrefill(prefill: string | null | undefined): FilterRule {
  const rule = emptyRule();
  if (!prefill) return rule;
  const separator = prefill.indexOf(':');
  if (separator <= 0) return rule;
  const field = prefill.slice(0, separator) as FilterField;
  const value = prefill.slice(separator + 1).trim();
  if (!(field in FIELD_TITLES) || value.length === 0) return rule;
  rule.conditions = [{ field, operator: 'contains', value }];
  return rule;
}

/** Обратная операция: значение для `?new=` из условия. */
export function serializeRulePrefill(field: FilterField, value: string): string {
  return `${field}:${value}`;
}

/** Условия правила одной строкой: «От содержит вася@почта». */
export function describeConditions(rule: FilterRule): string {
  if (rule.conditions.length === 0) return 'Все письма';
  return rule.conditions
    .map((c) => `${FIELD_TITLES[c.field]} ${OPERATOR_TITLES[c.operator]} ${c.value}`)
    .join(', ');
}

/**
 * Действия правила списком — как в правой колонке списка фильтров mail.ru:
 * «Переслать на:», «Пометить прочитанным», «Применять к спаму»…
 */
export function describeActions(rule: FilterRule, folders: readonly Folder[]): string[] {
  const lines: string[] = [];
  const a = rule.actions;

  if (a.moveToFolderId !== null) {
    const folder = folders.find((f) => f.id === a.moveToFolderId);
    lines.push(`Поместить в папку «${folder ? folderTitle(folder) : a.moveToFolderId}»`);
  }
  if (a.markRead) lines.push('Пометить прочитанным');
  if (a.markFlagged) lines.push('Пометить флагом');
  if (a.forwardTo !== null) lines.push(`Переслать на: ${a.forwardTo}`);
  if (a.autoReply !== null) lines.push('Отвечать автоматически');
  if (a.applyToExistingFolderIds.length > 0) {
    const names = a.applyToExistingFolderIds.map((id) => {
      const folder = folders.find((f) => f.id === id);
      return folder ? folderTitle(folder) : id;
    });
    lines.push(`Применить к уже полученным письмам: ${names.join(', ')}`);
  }
  if (a.applyToSpam) lines.push('Применять к спаму');
  if (!a.continueOtherFilters) lines.push('Не выполнять другие фильтры после выполнения этого');

  return lines;
}

/**
 * Перестановка правила в списке. Порядок важен: фильтры выполняются сверху
 * вниз, и «не выполнять другие фильтры» отсекает всё, что ниже.
 * Выход за границы списка — не ошибка, просто ничего не меняется.
 */
export function moveRule(
  rules: readonly FilterRule[],
  id: string,
  direction: 'up' | 'down',
): FilterRule[] {
  const index = rules.findIndex((r) => r.id === id);
  const target = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || target < 0 || target >= rules.length) return [...rules];
  const next = [...rules];
  const moved = next[index];
  const replaced = next[target];
  if (!moved || !replaced) return next;
  next[index] = replaced;
  next[target] = moved;
  return next;
}
