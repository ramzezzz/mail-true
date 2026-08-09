/**
 * Настройки → «Восстановление писем»: что можно вернуть после очистки
 * корзины и сколько это хранится.
 *
 * ------------------------------------------------------------------
 * ПЕРВОЕ, ЧТО ЗДЕСЬ НАПИСАНО, — ПРО КВОТУ
 * ------------------------------------------------------------------
 * Очищенные письма остаются в ящике, обычной папкой IMAP, и ЧЕСТНО ЕДЯТ
 * место. Сложить их «куда-нибудь рядом», чтобы не считались, было бы
 * ложью дважды: место на диске сервера не бесконечно, а квота ящика
 * перестала бы что-либо значить.
 *
 * Поэтому занятый объём показан числом вверху, а кнопка «удалить сразу»
 * стоит рядом с ним, а не спрятана внизу: человек, у которого кончается
 * место, приходит сюда именно за ней.
 */

import { useState } from 'react';
import { ConfirmDialog } from '../../settings/ConfirmDialog';
import { Button, Checkbox, SelectField, Spinner } from '../../components';
import { actionErrorText } from '../../lib/errorText';
import {
  formatBytes,
  formatLeft,
  formatMoment,
  plural,
  type RecoveryItem,
} from '../../settings/ownerApi';
import {
  usePurgeMessages,
  useRecovery,
  useRestoreMessages,
  useSetRecoveryDays,
} from '../../settings/ownerQueries';
import {
  SettingsEmpty,
  SettingsError,
  SettingsHint,
  SettingsLead,
  SettingsRow,
  SettingsTitle,
} from '../../settings/ui';
import styles from './RecoveryPage.module.css';

/**
 * Сроки на выбор. Ноль стоит первым и назван словами, а не «0 дней»:
 * это не число, это другое поведение — прежнее, до появления возможности.
 */
const DAY_CHOICES = [0, 1, 3, 7, 14, 30];

function dayTitle(days: number): string {
  if (days === 0) return 'Не хранить — удалять сразу';
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

export function RecoveryPage() {
  const state = useRecovery();
  const setDays = useSetRecoveryDays();
  const restore = useRestoreMessages();
  const purge = usePurgeMessages();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** Открыто окно «удалить всё сейчас»: действие необратимо. */
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);

  const { available, reason, items, totals, days, maxDays, scheduledPurge, loading } = state;
  const error = setDays.error ?? restore.error ?? purge.error;
  const busy = restore.isPending || purge.isPending;

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const chosen = [...selected];
  const choices = DAY_CHOICES.filter((value) => value <= maxDays);

  return (
    <>
      <SettingsTitle>Восстановление писем</SettingsTitle>
      <SettingsLead>
        Когда вы очищаете корзину, письма не исчезают сразу: они лежат в ящике ещё несколько дней и
        всё это время их можно вернуть. Место в ящике они при этом занимают по-настоящему — как и
        любые другие письма.
      </SettingsLead>

      {!available && (
        <SettingsError>
          {reason ?? 'Восстановление сейчас недоступно — сервер не отдал состояние.'}
        </SettingsError>
      )}

      {available && loading && (
        <div className={styles.loading}>
          <Spinner size={22} />
        </div>
      )}

      {available && !loading && (
        <>
          {error && <SettingsError>{actionErrorText('Не получилось', error)}</SettingsError>}

          <div className={styles.summary}>
            <div>
              <span className={styles.summaryValue}>{formatBytes(totals.bytes)}</span>
              {/*
                Число стоит в конце строки, а не в начале: по-русски
                «1 письмо», «3 письма» и «5 писем» согласуются с глаголом
                по-разному, а форма «писем ждёт удаления: N» верна при
                любом числе — включая ноль.
              */}
              <span className={styles.summaryNote}>
                {totals.count === 0
                  ? 'удаления пока ничего не ждёт'
                  : `занимают письма, ждущие удаления — их ${totals.count}`}
              </span>
            </div>
            {totals.count > 0 && (
              <Button
                mode="secondary"
                onClick={() => {
                  // Спрашиваем ОБЯЗАТЕЛЬНО: кнопка стоит вплотную к строке
                  // с занятым объёмом — там же, где человек читает, сколько
                  // места едят письма, — и один промах мышью безвозвратно
                  // стирал всё, что ещё можно было вернуть. Восстановления
                  // после этого нет никакого.
                  purge.reset();
                  setConfirmPurgeAll(true);
                }}
                disabled={busy}
              >
                Удалить всё сейчас
              </Button>
            )}
          </div>

          <div className={styles.setting}>
            <SelectField
              label="Сколько хранить очищенное"
              value={String(days)}
              onChange={(event) => setDays.mutate(Number(event.target.value))}
              disabled={setDays.isPending}
            >
              {choices.map((value) => (
                <option key={value} value={value}>
                  {dayTitle(value)}
                </option>
              ))}
            </SelectField>
            {!scheduledPurge && (
              <p className={styles.warning}>
                Сейчас сервер не может удалять письма по сроку: администратор не настроил служебный
                доступ к почтовому хранилищу. Хранение работает, но освобождать место придётся
                кнопкой выше.
              </p>
            )}
          </div>

          {items.length === 0 && (
            <SettingsEmpty>
              Возвращать нечего: корзину либо не очищали, либо срок хранения уже вышел.
            </SettingsEmpty>
          )}

          {items.length > 0 && (
            <>
              <SettingsRow className={styles.actions}>
                <Button
                  onClick={() => {
                    restore.mutate(chosen);
                    setSelected(new Set());
                  }}
                  disabled={busy || chosen.length === 0}
                >
                  Вернуть в корзину
                  {chosen.length > 0 ? ` (${chosen.length})` : ''}
                </Button>
                <Button
                  mode="secondary"
                  onClick={() => {
                    purge.mutate(chosen);
                    setSelected(new Set());
                  }}
                  disabled={busy || chosen.length === 0}
                >
                  Удалить выбранные
                </Button>
              </SettingsRow>

              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.headCell} aria-label="Выбор" />
                    <th className={styles.headCell}>Письмо</th>
                    <th className={styles.headCell}>Размер</th>
                    <th className={styles.headCell}>Исчезнет</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <Row
                      key={item.id}
                      item={item}
                      checked={selected.has(item.id)}
                      onToggle={() => toggle(item.id)}
                    />
                  ))}
                </tbody>
              </table>
            </>
          )}

          <SettingsHint>
            Возврат кладёт письмо обратно в корзину — оттуда вы сами решите, куда его положить.
            Письма ждут своего срока в служебной папке ящика: в почтовой программе на телефоне или в
            Thunderbird она видна под именем «Recovery», и это не поломка.
          </SettingsHint>
        </>
      )}

      {confirmPurgeAll && (
        <ConfirmDialog
          title="Удалить всё сейчас?"
          text={`Из ящика будут окончательно удалены письма, ждущие удаления, — их ${String(totals.count)}. Это последнее место, откуда их ещё можно было вернуть: после удаления восстановить их нельзя ничем.`}
          confirmText="Удалить"
          busy={purge.isPending}
          error={purge.isError ? 'Не удалось удалить письма. Попробуйте ещё раз.' : null}
          onClose={() => setConfirmPurgeAll(false)}
          onConfirm={() => {
            purge.mutate('all', {
              onSuccess: () => {
                setConfirmPurgeAll(false);
                setSelected(new Set());
              },
            });
          }}
        />
      )}
    </>
  );
}

function Row({
  item,
  checked,
  onToggle,
}: {
  item: RecoveryItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className={styles.row}>
      <td className={styles.checkCell}>
        <Checkbox checked={checked} onChange={onToggle} aria-label="Выбрать письмо" />
      </td>
      <td className={styles.mainCell}>
        <span className={styles.subject}>{item.subject || 'Без темы'}</span>
        <span className={styles.meta}>
          {item.from || 'отправитель неизвестен'}
          {item.sentAt ? ` · ${formatMoment(item.sentAt)}` : ''}
          {` · очищено ${formatMoment(item.deletedAt)}`}
        </span>
      </td>
      <td className={styles.sizeCell}>{formatBytes(item.sizeBytes)}</td>
      <td className={styles.leftCell}>через {formatLeft(item.purgeAt)}</td>
    </tr>
  );
}
