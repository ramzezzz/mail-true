/**
 * Правила фильтрации (research/mailru/05-filters.png).
 *
 * Слева у каждого правила — стрелки порядка и переключатель «включено»,
 * дальше условия, справа списком — действия и корзина. Сверху «Добавить
 * фильтр», «Добавить пересылку» и флажок «Показывать автофильтры».
 *
 * Сюда же ведёт пункт «Создать фильтр» из письма: адрес
 * `/settings/filters?new=from:вася@почта` открывает окно с подставленным
 * отправителем (разбор — в lib/filterRules.ts).
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useFolders } from '../../api/queries';
import {
  useDeleteFilterRule,
  useFilterRules,
  useReorderFilterRules,
  useSaveFilterRule,
} from '../../api/settingsQueries';
import { Button, Checkbox, IconButton, Switch } from '../../components';
import {
  describeActions,
  describeConditions,
  emptyRule,
  moveRule,
  parseRulePrefill,
  type FilterRule,
} from '../../lib/filterRules';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '../../mail/icons';
import { FilterDialog } from '../../settings/FilterDialog';
import {
  SettingsEmpty,
  SettingsError,
  SettingsRow,
  SettingsSkeleton,
  SettingsTitle,
} from '../../settings/ui';
import styles from './FiltersPage.module.css';

export function FiltersPage() {
  const [params, setParams] = useSearchParams();
  const { data: folders } = useFolders();
  const { data: rules, isPending, isError } = useFilterRules();
  const saveRule = useSaveFilterRule();
  const deleteRule = useDeleteFilterRule();
  const reorder = useReorderFilterRules();

  const [showAuto, setShowAuto] = useState(false);
  const [editing, setEditing] = useState<FilterRule | null>(null);

  // «Создать фильтр» из письма приходит параметром ?new=<поле>:<значение>
  useEffect(() => {
    const prefill = params.get('new');
    if (prefill === null) return;
    setEditing(parseRulePrefill(prefill));
    // Параметр одноразовый: иначе окно открывалось бы снова после закрытия
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const visible = (rules ?? []).filter((r) => showAuto || !r.auto);

  const applyOrder = (id: string, direction: 'up' | 'down') => {
    if (!rules) return;
    reorder.mutate(moveRule(rules, id, direction).map((r) => r.id));
  };

  return (
    <>
      <SettingsTitle>Правила фильтрации</SettingsTitle>

      <SettingsRow className={styles.topRow}>
        <Button before={<IconPlus />} onClick={() => setEditing(emptyRule())}>
          Добавить фильтр
        </Button>
        <Button
          mode="secondary"
          onClick={() =>
            // «Добавить пересылку» — упрощённый случай правила: без условий,
            // с одним действием «переслать копию».
            setEditing({
              ...emptyRule(),
              conditions: [],
              actions: { ...emptyRule().actions, forwardTo: '' },
            })
          }
        >
          Добавить пересылку
        </Button>
        <div className={styles.spacer} />
        <Checkbox
          label="Показывать автофильтры"
          checked={showAuto}
          onChange={(e) => setShowAuto(e.target.checked)}
        />
      </SettingsRow>

      {isPending && <SettingsSkeleton rows={3} />}
      {isError && <SettingsError>Не удалось загрузить правила. Обновите страницу.</SettingsError>}

      {!isPending && visible.length === 0 && (
        <SettingsEmpty>
          Правил пока нет. Фильтр раскладывает входящие письма по папкам, помечает их и пересылает
          копии — всё это без вашего участия.
        </SettingsEmpty>
      )}

      <div className={styles.list}>
        {visible.map((rule, index) => (
          <div key={rule.id} className={styles.rule}>
            <div className={styles.order}>
              <IconButton
                label="Выше"
                disabled={index === 0 || reorder.isPending}
                onClick={() => applyOrder(rule.id, 'up')}
              >
                <IconArrowUp size={14} />
              </IconButton>
              <IconButton
                label="Ниже"
                disabled={index === visible.length - 1 || reorder.isPending}
                onClick={() => applyOrder(rule.id, 'down')}
              >
                <IconArrowDown size={14} />
              </IconButton>
            </div>

            <Switch
              aria-label={rule.enabled ? 'Выключить правило' : 'Включить правило'}
              checked={rule.enabled}
              onChange={(e) => saveRule.mutate({ ...rule, enabled: e.target.checked })}
            />

            <button
              type="button"
              className={styles.conditions}
              onClick={() => setEditing(structuredClone(rule))}
            >
              {describeConditions(rule)}
              {rule.auto && <span className={styles.autoBadge}>автофильтр</span>}
            </button>

            <ul className={styles.actions}>
              {describeActions(rule, folders ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            <IconButton
              label="Удалить правило"
              className={styles.delete}
              disabled={deleteRule.isPending}
              onClick={() => deleteRule.mutate(rule.id)}
            >
              <IconTrash />
            </IconButton>
          </div>
        ))}
      </div>

      {editing && (
        <FilterDialog
          initial={editing}
          folders={folders ?? []}
          saving={saveRule.isPending}
          error={saveRule.isError ? 'Не удалось сохранить правило' : null}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            saveRule.mutate(rule, { onSuccess: () => setEditing(null) });
          }}
        />
      )}
    </>
  );
}
