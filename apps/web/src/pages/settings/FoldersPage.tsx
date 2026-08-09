/**
 * Настройки папок (эталонные снимки интерфейса): таблица «Название папки —
 * Письма — действия», кнопка «Добавить папку».
 *
 * Набор действий у каждой строки СВОЙ и зависит от роли папки: Спам и
 * Корзину нельзя переименовать, удалить можно только пользовательскую
 * папку. Логика прав — в lib/folderRights.ts, здесь она только
 * применяется.
 *
 * Очистка корзины живёт здесь же, обычной строкой таблицы, и это
 * единственное место в продукте, где корзину можно освободить целиком
 * (второе — кнопка в «Восстановлении писем», она делает ровно то же).
 * Удаление папки удаляет и вложенные в неё папки — ровно так, как
 * написано в вопросе: сервер удаляет дерево целиком.
 */

import { useState } from 'react';
import type { Folder } from '@mail-true/shared';
import { useFolders } from '../../api/queries';
import {
  useClearFolder,
  useCreateFolder,
  useDeleteFolder,
  useRenameFolder,
} from '../../api/settingsQueries';
import { Button, IconButton, Modal, SelectField, TextField, Tooltip } from '../../components';
import { cx } from '../../lib/cx';
import { folderTitle } from '../../lib/folderNames';
import { folderRights, formatFolderCount } from '../../lib/folderRights';
import { IconBroom, IconFolderRole, IconPencil, IconPlus, IconTrash } from '../../mail/icons';
import { ConfirmDialog } from '../../settings/ConfirmDialog';
import { SettingsError, SettingsRow, SettingsSkeleton, SettingsTitle } from '../../settings/ui';
import styles from './FoldersPage.module.css';

type DialogState =
  | { kind: 'create' }
  | { kind: 'rename'; folder: Folder }
  | { kind: 'delete'; folder: Folder }
  | { kind: 'clear'; folder: Folder };

export function FoldersPage() {
  const { data: folders, isPending, isError } = useFolders();
  const create = useCreateFolder();
  const rename = useRenameFolder();
  const remove = useDeleteFolder();
  const clear = useClearFolder();

  const [dialog, setDialog] = useState<DialogState | null>(null);

  return (
    <>
      <SettingsTitle>Папки</SettingsTitle>

      <SettingsRow className={styles.topRow}>
        <Button before={<IconPlus />} onClick={() => setDialog({ kind: 'create' })}>
          Добавить папку
        </Button>
      </SettingsRow>

      {isPending && <SettingsSkeleton rows={6} />}
      {isError && <SettingsError>Не удалось загрузить папки. Обновите страницу.</SettingsError>}

      {folders && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.headCell}>Название папки</th>
              <th className={cx(styles.headCell, styles.countCell)}>Письма</th>
              <th className={cx(styles.headCell, styles.actionsCell)}>
                <span className={styles.visuallyHidden}>Действия</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {folders.map((folder) => {
              const rights = folderRights(folder);
              return (
                <tr key={folder.id} className={styles.row}>
                  <td className={styles.nameCell}>
                    <span className={styles.name} style={{ paddingLeft: `${folder.depth * 24}px` }}>
                      <span className={styles.icon}>
                        <IconFolderRole role={folder.role} />
                      </span>
                      {folderTitle(folder)}
                    </span>
                  </td>
                  <td className={styles.countCell}>{formatFolderCount(folder)}</td>
                  <td className={styles.actionsCell}>
                    {rights.canClear && (
                      <Tooltip text="Удалить все письма папки">
                        <IconButton
                          label="Очистить"
                          onClick={() => setDialog({ kind: 'clear', folder })}
                        >
                          <IconBroom />
                        </IconButton>
                      </Tooltip>
                    )}
                    {rights.canRename && (
                      <Tooltip text="Переименовать">
                        <IconButton
                          label="Переименовать"
                          onClick={() => setDialog({ kind: 'rename', folder })}
                        >
                          <IconPencil />
                        </IconButton>
                      </Tooltip>
                    )}
                    {rights.canDelete && (
                      <Tooltip text="Удалить папку">
                        <IconButton
                          label="Удалить папку"
                          onClick={() => setDialog({ kind: 'delete', folder })}
                        >
                          <IconTrash />
                        </IconButton>
                      </Tooltip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {dialog?.kind === 'create' && (
        <CreateFolderDialog
          folders={folders ?? []}
          saving={create.isPending}
          error={create.isError ? create.error.message : null}
          onClose={() => setDialog(null)}
          onCreate={(draft) => create.mutate(draft, { onSuccess: () => setDialog(null) })}
        />
      )}

      {dialog?.kind === 'rename' && (
        <RenameFolderDialog
          folder={dialog.folder}
          saving={rename.isPending}
          error={rename.isError ? rename.error.message : null}
          onClose={() => setDialog(null)}
          onRename={(name) =>
            rename.mutate({ id: dialog.folder.id, name }, { onSuccess: () => setDialog(null) })
          }
        />
      )}

      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Удалить папку?"
          text={`Папка «${folderTitle(dialog.folder)}» и все её вложенные папки будут удалены вместе с письмами. Отменить это нельзя.`}
          confirmText="Удалить"
          busy={remove.isPending}
          error={remove.isError ? remove.error.message : null}
          onClose={() => setDialog(null)}
          onConfirm={() => remove.mutate(dialog.folder.id, { onSuccess: () => setDialog(null) })}
        />
      )}

      {dialog?.kind === 'clear' && (
        <ConfirmDialog
          title={dialog.folder.role === 'trash' ? 'Очистить корзину?' : 'Очистить папку?'}
          /*
           * У корзины вопрос свой, потому что и последствия другие:
           * очищенные письма не исчезают сразу, а ждут своего срока в
           * ящике и всё это время их можно вернуть в разделе
           * «Восстановление писем» (там же видно, сколько места они
           * занимают). Обещать это на обычной папке нельзя — отсрочка
           * есть только у корзины.
           */
          text={
            dialog.folder.role === 'trash'
              ? 'Письма из корзины будут удалены. Пока включён срок хранения очищенного, их ещё несколько дней можно вернуть в настройках, в разделе «Восстановление писем», — там же видно, сколько места они занимают.'
              : `Все письма папки «${folderTitle(dialog.folder)}» будут удалены. Сама папка останется.`
          }
          confirmText="Очистить"
          busy={clear.isPending}
          error={clear.isError ? clear.error.message : null}
          onClose={() => setDialog(null)}
          onConfirm={() => clear.mutate(dialog.folder.id, { onSuccess: () => setDialog(null) })}
        />
      )}
    </>
  );
}

/* --- Окна ------------------------------------------------------------- */

function CreateFolderDialog({
  folders,
  saving,
  error,
  onClose,
  onCreate,
}: {
  folders: readonly Folder[];
  saving: boolean;
  error: string | null;
  onClose(): void;
  onCreate(draft: { name: string; parentId: string | null }): void;
}) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');

  return (
    <Modal
      title="Новая папка"
      onClose={onClose}
      className={styles.dialog}
      footer={
        <>
          <Button
            disabled={saving || name.trim().length === 0}
            onClick={() => onCreate({ name: name.trim(), parentId: parentId || null })}
          >
            {saving ? 'Создаём…' : 'Создать'}
          </Button>
          <Button mode="secondary" disabled={saving} onClick={onClose}>
            Отменить
          </Button>
        </>
      }
    >
      <TextField
        label="Название папки"
        autoFocus
        value={name}
        error={error}
        onChange={(e) => setName(e.target.value)}
      />
      <SelectField
        label="Вложить в папку"
        value={parentId}
        onChange={(e) => setParentId(e.target.value)}
      >
        <option value="">Не вкладывать</option>
        {/* Вкладывать можно только в папки верхнего уровня: три уровня
            вложенности привычный почтовый интерфейс не показывает, и мы не показываем. */}
        {folders
          .filter((f) => f.depth === 0)
          .map((f) => (
            <option key={f.id} value={f.id}>
              {folderTitle(f)}
            </option>
          ))}
      </SelectField>
    </Modal>
  );
}

function RenameFolderDialog({
  folder,
  saving,
  error,
  onClose,
  onRename,
}: {
  folder: Folder;
  saving: boolean;
  error: string | null;
  onClose(): void;
  onRename(name: string): void;
}) {
  const [name, setName] = useState(folderTitle(folder));
  return (
    <Modal
      title="Переименовать папку"
      onClose={onClose}
      className={styles.dialog}
      footer={
        <>
          <Button
            disabled={saving || name.trim().length === 0}
            onClick={() => onRename(name.trim())}
          >
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          <Button mode="secondary" disabled={saving} onClick={onClose}>
            Отменить
          </Button>
        </>
      }
    >
      <TextField
        label="Название папки"
        autoFocus
        value={name}
        error={error}
        onChange={(e) => setName(e.target.value)}
      />
    </Modal>
  );
}
