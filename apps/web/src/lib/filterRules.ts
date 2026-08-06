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

export type FilterField = 'from' | 'to' | 'subject' | 'cc' | 'size' | 'body' | 'attachment';

export const FIELD_TITLES: Record<FilterField, string> = {
  from: 'Поле «От»',
  to: 'Поле «Кому»',
  subject: 'Поле «Тема»',
  cc: 'Поле «Копия»',
  size: 'Размер, Кб',
  body: 'Текст письма',
  attachment: 'Вложение',
};

export type FilterOperator =
  | 'contains'
  | 'not-contains'
  | 'equals'
  | 'greater'
  | 'less'
  | 'has'
  | 'has-not';

export const OPERATOR_TITLES: Record<FilterOperator, string> = {
  contains: 'содержит',
  'not-contains': 'не содержит',
  equals: 'совпадает с',
  greater: 'больше чем',
  less: 'меньше чем',
  has: 'есть',
  'has-not': 'нет',
};

/** Размер сравнивается числом, вложение — наличием, остальные поля — текстом. */
export const TEXT_OPERATORS: readonly FilterOperator[] = ['contains', 'not-contains', 'equals'];
export const SIZE_OPERATORS: readonly FilterOperator[] = ['greater', 'less', 'equals'];
export const ATTACHMENT_OPERATORS: readonly FilterOperator[] = ['has', 'has-not'];

export function operatorsFor(field: FilterField): readonly FilterOperator[] {
  if (field === 'size') return SIZE_OPERATORS;
  if (field === 'attachment') return ATTACHMENT_OPERATORS;
  return TEXT_OPERATORS;
}

/**
 * У условия есть значение, которое вводит человек.
 *
 * У «Вложения» его нет: спрашивается наличие, и поле ввода рядом с ним
 * было бы окном, в которое нечего писать.
 */
export function conditionNeedsValue(field: FilterField): boolean {
  return field !== 'attachment';
}

export interface FilterCondition {
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

/**
 * Как правило удаляет письмо.
 *
 * 'trash' — в корзину: письмо видно и его можно достать обратно.
 * 'purge' — безвозвратно: письма не будет нигде и вернуть его нельзя ничем.
 * Поэтому умолчание — всегда 'trash', а 'purge' человек выбирает сам и
 * с предупреждением: правило, молча стирающее почту, — самое опасное,
 * что можно завести в настройках.
 */
export type FilterDeleteMode = 'trash' | 'purge';

export interface FilterActions {
  /** id папки-приёмника или null — не перекладывать. */
  moveToFolderId: string | null;
  markRead: boolean;
  markFlagged: boolean;
  /** Ключи своих меток (`mt-…`), которые правило ставит письму. */
  labelKeys: string[];
  /** Удалить письмо или null — не удалять. */
  deleteMode: FilterDeleteMode | null;
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
  labelKeys: [],
  deleteMode: null,
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
    actions: { ...DEFAULT_ACTIONS, applyToExistingFolderIds: [], labelKeys: [] },
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
    .map((c) => (conditionNeedsValue(c.field) ? { ...c, value: c.value.trim() } : { ...c, value: '' }))
    // Условие «Вложение» остаётся без значения — оно и не нужно ему.
    .filter((c) => !conditionNeedsValue(c.field) || c.value.length > 0)
    .map((c) =>
      operatorsFor(c.field).includes(c.operator)
        ? c
        : // Поле сменили на «Размер», а оператор остался текстовым —
          // берём первый допустимый, иначе правило не переведётся в Sieve.
          { ...c, operator: operatorsFor(c.field)[0] ?? 'contains' },
    );

  const forwardTo = draft.actions.forwardTo?.trim() ?? '';
  const autoReply = draft.actions.autoReply?.trim() ?? '';
  const deleteMode = draft.actions.deleteMode;

  return {
    ...draft,
    conditions,
    actions: {
      ...draft.actions,
      // Удаление и папка-приёмник исключают друг друга: письмо нельзя
      // одновременно положить в папку и выбросить. То же правило стоит и
      // на сервере (settings/webdto.ts) — чтобы список правил и файл Sieve
      // не разошлись в понимании одного и того же правила.
      moveToFolderId: deleteMode ? null : draft.actions.moveToFolderId,
      labelKeys: [...new Set(draft.actions.labelKeys)],
      forwardTo: forwardTo.length > 0 ? forwardTo : null,
      autoReply: autoReply.length > 0 ? autoReply : null,
      // Прогон по уже полученным письмам имеет смысл, только если правило
      // с ними что-то делает: раскладывает, помечает или удаляет.
      applyToExistingFolderIds:
        draft.actions.moveToFolderId === null &&
        deleteMode === null &&
        !draft.actions.markRead &&
        !draft.actions.markFlagged &&
        draft.actions.labelKeys.length === 0
          ? []
          : [...draft.actions.applyToExistingFolderIds],
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
    a.labelKeys.length > 0 ||
    a.deleteMode !== null ||
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
    .map((c) =>
      conditionNeedsValue(c.field)
        ? `${FIELD_TITLES[c.field]} ${OPERATOR_TITLES[c.operator]} ${c.value}`
        : // «Вложение есть» — значения нет, и лишний пробел в конце строки
          // выглядел бы обрывом фразы.
          `${FIELD_TITLES[c.field]} ${OPERATOR_TITLES[c.operator]}`,
    )
    .join(', ');
}

/**
 * Действия правила списком — как в правой колонке списка фильтров mail.ru:
 * «Переслать на:», «Пометить прочитанным», «Применять к спаму»…
 */
export function describeActions(
  rule: FilterRule,
  folders: readonly Folder[],
  labels: readonly { key: string; name: string }[] = [],
): string[] {
  const lines: string[] = [];
  const a = rule.actions;

  if (a.moveToFolderId !== null) {
    const folder = folders.find((f) => f.id === a.moveToFolderId);
    lines.push(`Поместить в папку «${folder ? folderTitle(folder) : a.moveToFolderId}»`);
  }
  if (a.markRead) lines.push('Пометить прочитанным');
  if (a.markFlagged) lines.push('Пометить флагом');
  if (a.labelKeys.length > 0) {
    // Метка называется именем, а не ключом: ключ `mt-scheta` человек не
    // выбирал и никогда не видел — его выдал сервер (mail/labels.ts).
    const names = a.labelKeys.map((key) => labels.find((l) => l.key === key)?.name ?? key);
    lines.push(`Поставить метку: ${names.join(', ')}`);
  }
  /*
   * Удаление называется прямо, а не «поместить в папку „Корзина“».
   * Безвозвратное — отдельной строкой и словами, которые нельзя прочитать
   * мельком: в списке правил это единственное место, где человек увидит,
   * что одно из его правил стирает почту насовсем.
   */
  if (a.deleteMode === 'trash') lines.push('Удалить (в корзину)');
  if (a.deleteMode === 'purge') lines.push('Удалить безвозвратно, минуя корзину');
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
