/**
 * Окно «Создание фильтра» (research/mailru/06-filter-editor.png и
 * 07-filter-all-actions.png).
 *
 * Сверху — «Если выполнено условие»: строки «поле · оператор · значение»
 * с крестиком и ссылкой «Добавить условие». Ниже — «Тогда»: папка-приёмник,
 * пометки, применение к уже полученным письмам, а под ссылкой «Все действия
 * и параметры» — пересылка, автоответ, продолжение других фильтров и спам.
 * Свёрнутый вид ровно такой же, как у mail.ru: редкие действия не мозолят
 * глаза, но и не спрятаны навсегда.
 */

import { useState } from 'react';
import type { Folder } from '@mail-true/shared';
import { Button, Checkbox, Modal, SelectField, TextAreaField, TextField } from '../components';
import { folderTitle } from '../lib/folderNames';
import {
  FIELD_TITLES,
  OPERATOR_TITLES,
  buildRule,
  emptyCondition,
  isRuleComplete,
  operatorsFor,
  type FilterCondition,
  type FilterField,
  type FilterOperator,
  type FilterRule,
} from '../lib/filterRules';
import { IconClose, IconPlus } from '../mail/icons';
import styles from './FilterDialog.module.css';

export interface FilterDialogProps {
  /** Правило-заготовка: новое, предзаполненное или редактируемое. */
  initial: FilterRule;
  folders: readonly Folder[];
  saving: boolean;
  error?: string | null;
  onSave(rule: FilterRule): void;
  onClose(): void;
}

const FIELD_ORDER: readonly FilterField[] = ['from', 'to', 'subject', 'cc', 'size'];

export function FilterDialog({
  initial,
  folders,
  saving,
  error,
  onSave,
  onClose,
}: FilterDialogProps) {
  const [draft, setDraft] = useState<FilterRule>(() => structuredClone(initial));
  const [allActions, setAllActions] = useState(
    () =>
      // Если редкие действия уже заданы, окно открывается развёрнутым —
      // иначе пользователь не увидел бы половину собственного правила.
      initial.actions.forwardTo !== null ||
      initial.actions.autoReply !== null ||
      initial.actions.applyToSpam ||
      !initial.actions.continueOtherFilters,
  );
  const [touched, setTouched] = useState(false);

  const patchActions = (patch: Partial<FilterRule['actions']>) =>
    setDraft((d) => ({ ...d, actions: { ...d.actions, ...patch } }));

  const patchCondition = (index: number, patch: Partial<FilterCondition>) =>
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));

  const addCondition = () =>
    setDraft((d) => ({ ...d, conditions: [...d.conditions, emptyCondition()] }));

  const removeCondition = (index: number) =>
    setDraft((d) => ({
      ...d,
      // Последнее условие не удаляем, а очищаем: окно без единой строки
      // выглядит сломанным.
      conditions:
        d.conditions.length === 1
          ? [emptyCondition()]
          : d.conditions.filter((_, i) => i !== index),
    }));

  const submit = () => {
    const rule = buildRule(draft);
    setTouched(true);
    if (!isRuleComplete(rule)) return;
    onSave(rule);
  };

  const normalized = buildRule(draft);
  const invalid = touched && !isRuleComplete(normalized);

  return (
    <Modal
      title={initial.id ? 'Изменение фильтра' : 'Создание фильтра'}
      onClose={onClose}
      className={styles.modal}
      footer={
        <>
          <Button disabled={saving} onClick={submit}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          <Button mode="secondary" disabled={saving} onClick={onClose}>
            Отменить
          </Button>
        </>
      }
    >
      <h3 className={styles.groupTitle}>Если выполнено условие</h3>

      {draft.conditions.map((condition, index) => {
        const operators = operatorsFor(condition.field);
        const operator = operators.includes(condition.operator)
          ? condition.operator
          : (operators[0] ?? 'contains');
        return (
          <div key={index} className={styles.condition}>
            <SelectField
              aria-label="Поле письма"
              wrapperClassName={styles.conditionField}
              value={condition.field}
              onChange={(e) => patchCondition(index, { field: e.target.value as FilterField })}
            >
              {FIELD_ORDER.map((field) => (
                <option key={field} value={field}>
                  {FIELD_TITLES[field]}
                </option>
              ))}
            </SelectField>

            <SelectField
              aria-label="Условие"
              wrapperClassName={styles.conditionOperator}
              value={operator}
              onChange={(e) =>
                patchCondition(index, { operator: e.target.value as FilterOperator })
              }
            >
              {operators.map((op) => (
                <option key={op} value={op}>
                  {OPERATOR_TITLES[op]}
                </option>
              ))}
            </SelectField>

            <TextField
              aria-label="Значение"
              wrapperClassName={styles.conditionValue}
              type={condition.field === 'size' ? 'number' : 'text'}
              value={condition.value}
              onChange={(e) => patchCondition(index, { value: e.target.value })}
            />

            <button
              type="button"
              className={styles.removeCondition}
              aria-label="Удалить условие"
              onClick={() => removeCondition(index)}
            >
              <IconClose size={14} />
            </button>
          </div>
        );
      })}

      <button type="button" className={styles.addCondition} onClick={addCondition}>
        <IconPlus size={14} />
        Добавить условие
      </button>

      <h3 className={styles.groupTitle}>Тогда</h3>

      <div className={styles.condition}>
        <SelectField
          aria-label="Действие"
          wrapperClassName={styles.conditionField}
          value={draft.actions.moveToFolderId === null ? 'none' : 'move'}
          onChange={(e) =>
            patchActions({
              moveToFolderId: e.target.value === 'move' ? (folders[0]?.id ?? null) : null,
            })
          }
        >
          <option value="none">Оставить во «Входящих»</option>
          <option value="move">Поместить в папку</option>
        </SelectField>

        <SelectField
          aria-label="Папка"
          wrapperClassName={styles.actionFolder}
          disabled={draft.actions.moveToFolderId === null}
          value={draft.actions.moveToFolderId ?? ''}
          onChange={(e) => patchActions({ moveToFolderId: e.target.value })}
        >
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {folderTitle(f)}
            </option>
          ))}
        </SelectField>
      </div>

      <div className={styles.checkRow}>
        <Checkbox
          label="Пометить прочитанным"
          checked={draft.actions.markRead}
          onChange={(e) => patchActions({ markRead: e.target.checked })}
        />
        <Checkbox
          label="Пометить флагом"
          checked={draft.actions.markFlagged}
          onChange={(e) => patchActions({ markFlagged: e.target.checked })}
        />
      </div>

      <Checkbox
        label="Применить к письмам, которые уже находятся в папках"
        checked={draft.actions.applyToExistingFolderIds.length > 0}
        disabled={draft.actions.moveToFolderId === null}
        onChange={(e) =>
          patchActions({ applyToExistingFolderIds: e.target.checked ? ['inbox'] : [] })
        }
      />
      {draft.actions.applyToExistingFolderIds.length > 0 && (
        <div className={styles.folderPicker}>
          {folders.map((f) => (
            <Checkbox
              key={f.id}
              label={folderTitle(f)}
              checked={draft.actions.applyToExistingFolderIds.includes(f.id)}
              onChange={(e) =>
                patchActions({
                  applyToExistingFolderIds: e.target.checked
                    ? [...draft.actions.applyToExistingFolderIds, f.id]
                    : draft.actions.applyToExistingFolderIds.filter((id) => id !== f.id),
                })
              }
            />
          ))}
        </div>
      )}

      {!allActions ? (
        <button type="button" className={styles.moreActions} onClick={() => setAllActions(true)}>
          Все действия и параметры
        </button>
      ) : (
        <div className={styles.extraActions}>
          <Checkbox
            label="Переслать копию сообщения на адрес"
            checked={draft.actions.forwardTo !== null}
            onChange={(e) => patchActions({ forwardTo: e.target.checked ? '' : null })}
          />
          {draft.actions.forwardTo !== null && (
            <TextField
              aria-label="Адрес пересылки"
              type="email"
              placeholder="адрес@почта"
              value={draft.actions.forwardTo}
              onChange={(e) => patchActions({ forwardTo: e.target.value })}
            />
          )}

          <Checkbox
            label="Отвечать автоматически"
            checked={draft.actions.autoReply !== null}
            onChange={(e) => patchActions({ autoReply: e.target.checked ? '' : null })}
          />
          {draft.actions.autoReply !== null && (
            <TextAreaField
              aria-label="Текст автоответа"
              rows={3}
              value={draft.actions.autoReply}
              onChange={(e) => patchActions({ autoReply: e.target.value })}
            />
          )}

          <Checkbox
            label="После срабатывания этого фильтра применять другие фильтры"
            checked={draft.actions.continueOtherFilters}
            onChange={(e) => patchActions({ continueOtherFilters: e.target.checked })}
          />
          <Checkbox
            label="Применять фильтр к спаму"
            checked={draft.actions.applyToSpam}
            onChange={(e) => patchActions({ applyToSpam: e.target.checked })}
          />
        </div>
      )}

      {invalid && (
        <p className={styles.error} role="alert">
          Задайте условие со значением и хотя бы одно действие.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
