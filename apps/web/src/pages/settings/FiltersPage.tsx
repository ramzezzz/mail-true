/**
 * Правила фильтрации (эталонные снимки интерфейса).
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
import { useUiStore } from '../../app/store';
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
  moveVisibleRule,
  parseRulePrefill,
  type FilterRule,
} from '../../lib/filterRules';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '../../mail/icons';
import { useLabelDictionary } from '../../mail/useLabels';
import { ConfirmDialog } from '../../settings/ConfirmDialog';
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
  // Тот же справочник, что и в почте: метку правила человек выбирает из
  // своих меток, а не заводит здесь новую. Пусто — раздела меток в окне
  // не будет вовсе (нет базы или человек ещё ни одной не завёл).
  const labels = useLabelDictionary();
  const { data: rules, isPending, isError } = useFilterRules();
  const saveRule = useSaveFilterRule();
  const deleteRule = useDeleteFilterRule();
  const reorder = useReorderFilterRules();

  const showNotice = useUiStore.getState().showNotice;

  const [showAuto, setShowAuto] = useState(false);
  const [editing, setEditing] = useState<FilterRule | null>(null);
  /*
   * Правило, которое собрались удалить. Раньше корзина удаляла сразу, а
   * правило — это несколько экранов настроенных условий и действий, и
   * восстановления у нас нет: один промах мышью — и настраивать заново.
   */
  const [removing, setRemoving] = useState<FilterRule | null>(null);

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

  /*
   * Стрелка двигает правило на одну позицию В ВИДИМОМ списке, а не в
   * полном: под правилом может стоять скрытый автофильтр, и обмен с ним
   * на экране выглядел бы как «кнопка не работает» — при том что порядок
   * применения фильтров при этом менялся. См. moveVisibleRule.
   */
  const applyOrder = (id: string, direction: 'up' | 'down') => {
    if (!rules) return;
    reorder.mutate(moveVisibleRule(rules, visible, id, direction).map((r) => r.id));
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
              {describeActions(rule, folders ?? [], labels).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {rule.missingFolder && (
                /*
                 * Папку переименовали или удалили мимо нас — по IMAP это
                 * разрешено из любой почтовой программы. Правило про это
                 * не знает и при первом же письме заведёт папку со старым
                 * именем заново, рядом с настоящей. Сказать об этом
                 * обязаны здесь: сам человек увидит только две похожие
                 * папки и почту, разложенную в обе.
                 */
                <li className={styles.missingFolder}>
                  Папки «{rule.missingFolder}» в ящике нет — выберите новую
                </li>
              )}
            </ul>

            <IconButton
              label="Удалить правило"
              className={styles.delete}
              disabled={deleteRule.isPending}
              onClick={() => {
                // Отказ прошлого удаления не должен висеть в новом окне.
                deleteRule.reset();
                setRemoving(rule);
              }}
            >
              <IconTrash />
            </IconButton>
          </div>
        ))}
      </div>

      {removing && (
        <ConfirmDialog
          title="Удалить правило?"
          text={`Правило «${describeConditions(removing)}» будет удалено вместе со всеми его действиями. Восстановить его нельзя — настраивать придётся заново.`}
          confirmText="Удалить"
          busy={deleteRule.isPending}
          /*
           * Отказ сервера остаётся на глазах, а окно не закрывается.
           * Раньше результат удаления не смотрели вовсе: при отказе окон
           * не было и подавно, строка правила возвращалась на место при
           * следующем обновлении списка — и это выглядело как «оно само».
           */
          error={deleteRule.isError ? 'Не удалось удалить правило. Попробуйте ещё раз.' : null}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            deleteRule.mutate(removing.id, { onSuccess: () => setRemoving(null) });
          }}
        />
      )}

      {editing && (
        <FilterDialog
          initial={editing}
          folders={folders ?? []}
          labels={labels}
          saving={saveRule.isPending}
          error={saveRule.isError ? 'Не удалось сохранить правило' : null}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            saveRule.mutate(rule, {
              onSuccess: (saved) => {
                setEditing(null);
                /*
                 * «Применить к уже полученным письмам» идёт по тысячам
                 * писем в ящике и может оборваться — правило при этом уже
                 * сохранено. Раньше сервер отвечал на такой обрыв ошибкой,
                 * окно не закрывалось, человек жал «Сохранить» ещё раз и
                 * получал ВТОРОЕ такое же правило. Теперь окно закрывается,
                 * а о неудавшемся прогоне сказано словами.
                 */
                const warning = (saved as { applyWarning?: unknown }).applyWarning;
                if (typeof warning === 'string' && warning !== '') showNotice(warning);
              },
            });
          }}
        />
      )}
    </>
  );
}
