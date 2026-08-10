/**
 * Настройки → «Метки»: справочник своих меток.
 *
 * Здесь метку заводят, переименовывают, меняют ей цвет и удаляют. Все
 * четыре действия правят ТОЛЬКО справочник; единственное, что доходит до
 * писем, — удаление с ответом «снять с писем», и об этом человека
 * спрашивают прямым вопросом, а не показывают «Удалить?» и делают что-то
 * на своё усмотрение.
 *
 * Ограничение хранения объяснено прямо на странице (см. SettingsHint внизу):
 * метки живут ключевыми словами IMAP, а их переживает не всякий перенос
 * между серверами и показывает не всякая почтовая программа. Это не
 * поломка и ничего не ломает, но человек, который завёл двадцать меток и
 * потом переезжает, имеет право узнать об этом заранее, а не потом.
 */

import { useState } from 'react';
import { Button, Checkbox, IconButton, Modal, TextField, Tooltip } from '../../components';
import { cx } from '../../lib/cx';
import { IconPencil, IconPlus, IconTrash } from '../../mail/icons';
import { LabelPill } from '../../mail/LabelPill';
import {
  DEFAULT_LABEL_COLOR,
  LABEL_COLORS,
  LABEL_COLOR_TITLES,
  type LabelColor,
  type MailLabel,
} from '../../mail/labelsApi';
import {
  useCreateLabel,
  useDeleteLabel,
  useLabelsState,
  useUpdateLabel,
} from '../../mail/useLabels';
import {
  SettingsEmpty,
  SettingsError,
  SettingsHint,
  SettingsLead,
  SettingsRow,
  SettingsTitle,
} from '../../settings/ui';
import pillStyles from '../../mail/LabelPill.module.css';
import styles from './LabelsPage.module.css';

type DialogState =
  { kind: 'create' } | { kind: 'edit'; label: MailLabel } | { kind: 'delete'; label: MailLabel };

export function LabelsPage() {
  const { available, reason, items } = useLabelsState();
  const create = useCreateLabel();
  const update = useUpdateLabel();
  const remove = useDeleteLabel();
  const [dialog, setDialog] = useState<DialogState | null>(null);

  return (
    <>
      <SettingsTitle>Метки</SettingsTitle>
      <SettingsLead>
        Метка вешается на письмо, не вынимая его из папки: письмо остаётся во «Входящих», а по метке
        его можно отобрать в списке и в поиске. На одном письме меток может быть сколько угодно.
      </SettingsLead>

      {!available && (
        <SettingsError>
          {reason ?? 'Метки сейчас недоступны — сервер не отдал справочник.'}
        </SettingsError>
      )}

      {available && (
        <>
          <SettingsRow className={styles.topRow}>
            <Button before={<IconPlus />} onClick={() => setDialog({ kind: 'create' })}>
              Создать метку
            </Button>
          </SettingsRow>

          {items.length === 0 && (
            <SettingsEmpty>
              Меток пока нет. Заведите первую — например, «Оплатить» или «Спросить у юриста».
            </SettingsEmpty>
          )}

          {items.length > 0 && (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.headCell}>Метка</th>
                  <th className={styles.headCell}>Ключевое слово в письме</th>
                  <th className={cx(styles.headCell, styles.actionsCell)}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {items.map((label) => (
                  <tr key={label.key} className={styles.row}>
                    <td className={styles.nameCell}>
                      <LabelPill label={label} large />
                    </td>
                    {/*
                      Ключ показан НАРОЧНО. Именно он лежит в письме, и
                      именно его человек увидит в другой почтовой программе
                      вместо красивого имени. Спрятать его значило бы сделать
                      сюрприз из того, о чём предупреждает подсказка внизу.
                    */}
                    <td className={styles.keyCell}>{label.key}</td>
                    <td className={styles.actionsCell}>
                      <Tooltip text="Переименовать или сменить цвет">
                        <IconButton
                          label="Изменить метку"
                          onClick={() => setDialog({ kind: 'edit', label })}
                        >
                          <IconPencil />
                        </IconButton>
                      </Tooltip>
                      <Tooltip text="Удалить метку">
                        <IconButton
                          label="Удалить метку"
                          onClick={() => setDialog({ kind: 'delete', label })}
                        >
                          <IconTrash />
                        </IconButton>
                      </Tooltip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <SettingsHint>
            Метки хранятся в самих письмах — ключевыми словами IMAP. Это значит, что они видны во
            всех вкладках и на телефоне и не пропадут с переустановкой браузера. Но переезд ящика на
            другой сервер переносит ключевые слова не всегда, и не всякая сторонняя почтовая
            программа их показывает: там, где не показывает, письмо просто выглядит непомеченным — с
            ним самим ничего не происходит.
          </SettingsHint>
        </>
      )}

      {dialog?.kind === 'create' && (
        <LabelDialog
          title="Новая метка"
          confirmText="Создать"
          busy={create.isPending}
          error={create.isError ? create.error.message : null}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => create.mutate(draft, { onSuccess: () => setDialog(null) })}
        />
      )}

      {dialog?.kind === 'edit' && (
        <LabelDialog
          title="Изменить метку"
          confirmText="Сохранить"
          initial={dialog.label}
          busy={update.isPending}
          error={update.isError ? update.error.message : null}
          onClose={() => setDialog(null)}
          onSubmit={(draft) =>
            update.mutate(
              { key: dialog.label.key, patch: draft },
              { onSuccess: () => setDialog(null) },
            )
          }
        />
      )}

      {dialog?.kind === 'delete' && (
        <DeleteLabelDialog
          label={dialog.label}
          busy={remove.isPending}
          error={remove.isError ? remove.error.message : null}
          onClose={() => setDialog(null)}
          onConfirm={(purge) =>
            remove.mutate({ key: dialog.label.key, purge }, { onSuccess: () => setDialog(null) })
          }
        />
      )}
    </>
  );
}

/* --- Окна ------------------------------------------------------------- */

function LabelDialog({
  title,
  confirmText,
  initial,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  confirmText: string;
  initial?: MailLabel;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onSubmit(draft: { name: string; color: LabelColor }): void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState<LabelColor>(initial?.color ?? DEFAULT_LABEL_COLOR);
  const trimmed = name.trim();

  return (
    <Modal
      title={title}
      onClose={onClose}
      className={styles.dialog}
      footer={
        <>
          <Button mode="tertiary" onClick={onClose}>
            Отменить
          </Button>
          <Button
            disabled={trimmed === '' || busy}
            onClick={() => onSubmit({ name: trimmed, color })}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <TextField
        label="Название"
        autoFocus
        value={name}
        maxLength={64}
        wrapperClassName={styles.field}
        onChange={(e) => setName(e.target.value)}
        error={error}
      />

      <div className={styles.colors} role="radiogroup" aria-label="Цвет метки">
        {LABEL_COLORS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={color === option}
            aria-label={LABEL_COLOR_TITLES[option]}
            title={LABEL_COLOR_TITLES[option]}
            className={cx(styles.color, pillStyles[option], color === option && styles.colorActive)}
            onClick={() => setColor(option)}
          >
            <span className={styles.colorInner} />
          </button>
        ))}
      </div>

      {/* Живой вид метки: цвет без названия ничего не говорит той части
          людей, которая цвета не различает, — пусть видно будет сразу. */}
      <div className={styles.preview}>
        <LabelPill
          label={{
            key: initial?.key ?? 'mt-preview',
            name: trimmed || 'Название',
            color,
            position: 0,
          }}
          large
        />
      </div>

      {initial && (
        <SettingsHint>
          Ключевое слово в письмах ({initial.key}) при переименовании не меняется: иначе пометку
          пришлось бы переставлять на каждом помеченном письме, и на тех, до которых переделка не
          доехала бы, она пропала бы совсем.
        </SettingsHint>
      )}
    </Modal>
  );
}

/**
 * Удаление метки. Вопрос задаётся ЧЕСТНО: у него два разных исхода, и
 * человек выбирает, какой ему нужен, до нажатия, а не узнаёт после.
 */
function DeleteLabelDialog({
  label,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  label: MailLabel;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(purge: boolean): void;
}) {
  const [purge, setPurge] = useState(false);

  return (
    <Modal
      title={`Удалить метку «${label.name}»?`}
      onClose={onClose}
      className={styles.dialog}
      footer={
        <>
          <Button disabled={busy} onClick={() => onConfirm(purge)}>
            {busy ? 'Удаляем…' : 'Удалить'}
          </Button>
          <Button mode="secondary" disabled={busy} onClick={onClose}>
            Отменить
          </Button>
        </>
      }
    >
      <p className={styles.choiceText}>
        Метка исчезнет из справочника и из меню. Сами письма останутся на своих местах — метка не
        папка, писем она не хранит.
      </p>

      <div className={styles.choice}>
        <Checkbox
          label="Снять метку с помеченных писем"
          checked={purge}
          onChange={(e) => setPurge(e.target.checked)}
        />
      </div>
      <p className={styles.choiceNote}>
        {purge
          ? 'Ключевое слово будет удалено из всех писем ящика. Отменить это нельзя.'
          : 'Без этого ключевое слово останется в письмах навсегда: показывать его будет ' +
            'нечем, снять его потом тоже нечем, а новая метка с тем же именем получит ' +
            'другое ключевое слово и на прежних письмах не появится.'}
      </p>

      {error && <SettingsError>{error}</SettingsError>}
    </Modal>
  );
}
