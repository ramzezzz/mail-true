/**
 * Настройки → «Шаблоны писем»: список, правка, удаление, порядок.
 *
 * Раздела нет вовсе, пока сервер не сказал, что возможность у него есть, —
 * пункт меню настроек в этом случае тоже не появляется (см.
 * settings/SettingsLayout.tsx). Общее правило продукта: кнопка появляется
 * вместе с поведением.
 *
 * ------------------------------------------------------------------
 * ПРО ПРАВКУ ТЕЛА
 * ------------------------------------------------------------------
 * Тело шаблона — это разметка, набранная в окне написания: с жирным,
 * списками и ссылками. Показать её здесь простым текстовым полем значило
 * бы либо потерять всё оформление при сохранении, либо заставить человека
 * править теги руками. Поэтому здесь тот же `contenteditable`, что и в
 * письме, и та же горстка кнопок правки текста.
 */

import { useState } from 'react';
import { Button, IconButton, Modal, TextField, Tooltip } from '../../components';
import {
  IconArrowDown,
  IconArrowUp,
  IconAttach,
  IconClearFormat,
  IconLink,
  IconListBulleted,
  IconPencil,
  IconPlus,
  IconTrash,
} from '../../mail/icons';
import { fileSizeText, templatePreview } from '../../compose/TemplateMenu';
import {
  moveTemplate,
  TEMPLATE_PLACEHOLDERS,
  type MailTemplate,
} from '../../mail/templatesApi';
import {
  useCreateTemplate,
  useDeleteTemplate,
  useReorderTemplates,
  useTemplatesState,
  useUpdateTemplate,
} from '../../mail/useTemplates';
import {
  SettingsEmpty,
  SettingsError,
  SettingsHint,
  SettingsLead,
  SettingsRow,
  SettingsTitle,
} from '../../settings/ui';
import styles from './TemplatesPage.module.css';

type DialogState =
  | { kind: 'create' }
  | { kind: 'edit'; template: MailTemplate }
  | { kind: 'delete'; template: MailTemplate };

export function TemplatesPage() {
  const { available, reason, items } = useTemplatesState();
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const remove = useDeleteTemplate();
  const reorder = useReorderTemplates();
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const applyOrder = (id: number, direction: 'up' | 'down') => {
    reorder.mutate(moveTemplate(items, id, direction).map((t) => t.id));
  };

  return (
    <>
      <SettingsTitle>Шаблоны писем</SettingsTitle>
      <SettingsLead>
        Шаблон — это заготовленные тема и текст, которые вставляются в письмо одним нажатием:
        кнопка «Шаблоны» стоит в панели написания. Вставка идёт в позицию курсора и не затирает
        уже набранное.
      </SettingsLead>

      {!available && (
        <SettingsError>
          {reason ?? 'Шаблоны сейчас недоступны — сервер не отдал список.'}
        </SettingsError>
      )}

      {available && (
        <>
          <SettingsRow className={styles.topRow}>
            <Button before={<IconPlus />} onClick={() => setDialog({ kind: 'create' })}>
              Создать шаблон
            </Button>
          </SettingsRow>

          {items.length === 0 && (
            <SettingsEmpty>
              Шаблонов пока нет. Проще всего завести первый прямо из письма: напишите обычный
              ответ и выберите «Шаблоны → Сохранить как шаблон».
            </SettingsEmpty>
          )}

          <div className={styles.list}>
            {items.map((template, index) => (
              <div key={template.id} className={styles.item}>
                {/*
                  Порядок — стрелками, как у правил фильтрации: он задаёт
                  порядок строк в меню «Шаблоны», и ходовые заготовки
                  человек ставит наверх.
                */}
                <div className={styles.order}>
                  <IconButton
                    label="Выше"
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => applyOrder(template.id, 'up')}
                  >
                    <IconArrowUp size={14} />
                  </IconButton>
                  <IconButton
                    label="Ниже"
                    disabled={index === items.length - 1 || reorder.isPending}
                    onClick={() => applyOrder(template.id, 'down')}
                  >
                    <IconArrowDown size={14} />
                  </IconButton>
                </div>

                <button
                  type="button"
                  className={styles.body}
                  onClick={() => setDialog({ kind: 'edit', template })}
                >
                  <span className={styles.name}>{template.name}</span>
                  {template.subject !== '' && (
                    <span className={styles.subject}>Тема: {template.subject}</span>
                  )}
                  <span className={styles.preview}>
                    {templatePreview(template.bodyHtml, 140) || 'Без текста'}
                  </span>
                  {template.attachments.length > 0 && (
                    <span className={styles.files}>
                      <IconAttach size={14} />
                      {template.attachments
                        .map((a) => `${a.filename} (${fileSizeText(a.size)})`)
                        .join(', ')}
                    </span>
                  )}
                </button>

                <div className={styles.actions}>
                  <Tooltip text="Изменить шаблон">
                    <IconButton
                      label="Изменить шаблон"
                      onClick={() => setDialog({ kind: 'edit', template })}
                    >
                      <IconPencil />
                    </IconButton>
                  </Tooltip>
                  <Tooltip text="Удалить шаблон">
                    <IconButton
                      label="Удалить шаблон"
                      onClick={() => setDialog({ kind: 'delete', template })}
                    >
                      <IconTrash />
                    </IconButton>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>

          <SettingsHint>
            Получатели в шаблон не сохраняются: одну и ту же заготовку отправляют разным людям, и
            запомненный адрес однажды ушёл бы не тому. Вложения, наоборот, сохраняются копией —
            они живут вместе с шаблоном и прикрепляются при каждой вставке. Шаблоны видны только
            в этом интерфейсе: по IMAP сторонняя почтовая программа их не покажет.
          </SettingsHint>
        </>
      )}

      {dialog?.kind === 'create' && (
        <TemplateDialog
          title="Новый шаблон"
          confirmText="Создать"
          busy={create.isPending}
          error={create.isError ? create.error.message : null}
          onClose={() => setDialog(null)}
          onSubmit={(draft) =>
            create.mutate(
              { ...draft, attachmentIds: [] },
              { onSuccess: () => setDialog(null) },
            )
          }
        />
      )}

      {dialog?.kind === 'edit' && (
        <TemplateDialog
          title="Изменить шаблон"
          confirmText="Сохранить"
          initial={dialog.template}
          busy={update.isPending}
          error={update.isError ? update.error.message : null}
          onClose={() => setDialog(null)}
          onSubmit={(draft) =>
            /*
             * Про вложения здесь не сказано ни слова — и это намеренно:
             * сервер трогает их, только когда о них просят. Правка текста
             * шаблона не должна стирать приложенный прайс, которого в этом
             * окне даже не видно целиком.
             */
            update.mutate(
              { id: dialog.template.id, patch: draft },
              { onSuccess: () => setDialog(null) },
            )
          }
          onDropAttachments={
            dialog.template.attachments.length > 0
              ? () =>
                  update.mutate({
                    id: dialog.template.id,
                    patch: { attachmentIds: [] },
                  })
              : undefined
          }
          attachments={dialog.template.attachments}
        />
      )}

      {dialog?.kind === 'delete' && (
        <Modal
          title={`Удалить шаблон «${dialog.template.name}»?`}
          onClose={() => setDialog(null)}
          className={styles.dialog}
          footer={
            <>
              <Button
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(dialog.template.id, { onSuccess: () => setDialog(null) })
                }
              >
                {remove.isPending ? 'Удаляем…' : 'Удалить'}
              </Button>
              <Button mode="secondary" disabled={remove.isPending} onClick={() => setDialog(null)}>
                Отменить
              </Button>
            </>
          }
        >
          <p className={styles.deleteNote}>
            Шаблон исчезнет из меню в окне написания вместе с сохранёнными в нём вложениями.
            Письма, отправленные по нему раньше, останутся как были — шаблон в них не ссылка,
            а копия текста.
          </p>
          {remove.isError && <SettingsError>{remove.error.message}</SettingsError>}
        </Modal>
      )}
    </>
  );
}

/* --- Окно правки ------------------------------------------------------ */

interface TemplateDialogProps {
  title: string;
  confirmText: string;
  initial?: MailTemplate;
  attachments?: MailTemplate['attachments'];
  busy: boolean;
  error: string | null;
  onClose(): void;
  onSubmit(draft: { name: string; subject: string; bodyHtml: string }): void;
  /** «Убрать вложения» — есть только у шаблона, у которого они уже есть. */
  onDropAttachments?: (() => void) | undefined;
}

function TemplateDialog({
  title,
  confirmText,
  initial,
  attachments = [],
  busy,
  error,
  onClose,
  onSubmit,
  onDropAttachments,
}: TemplateDialogProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  /**
   * Тело живёт в состоянии, а `contenteditable` наполняется один раз —
   * тем же приёмом, что и редактор письма (см. compose/ComposeWindow.tsx).
   * Иначе React переписывал бы разметку на каждое нажатие клавиши и
   * курсор прыгал бы в начало.
   */
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? '');
  const [initialHtml] = useState(initial?.bodyHtml ?? '');
  const trimmed = name.trim();

  /** Команда правки текста — ровно та же, что в панели окна написания. */
  const exec = (command: string, value?: string) => document.execCommand(command, false, value);

  return (
    <Modal
      title={title}
      onClose={onClose}
      className={styles.dialog}
      footer={
        <>
          <Button
            disabled={trimmed === '' || busy}
            onClick={() => onSubmit({ name: trimmed, subject, bodyHtml })}
          >
            {busy ? 'Сохраняем…' : confirmText}
          </Button>
          <Button mode="secondary" disabled={busy} onClick={onClose}>
            Отменить
          </Button>
        </>
      }
    >
      <TextField
        label="Название"
        autoFocus
        value={name}
        maxLength={120}
        wrapperClassName={styles.field}
        placeholder="Например, «Ответ о сроках»"
        onChange={(e) => setName(e.target.value)}
      />

      <TextField
        label="Тема письма"
        value={subject}
        maxLength={512}
        wrapperClassName={styles.field}
        hint="Подставится в пустую тему письма. Уже набранную тему шаблон не трогает."
        onChange={(e) => setSubject(e.target.value)}
      />

      <span className={styles.editorLabel}>Текст</span>
      {/* Кнопок ровно столько, сколько нужно для правки готового текста.
          Оформление письма делают в самом письме — и сохраняют оттуда. */}
      <div className={styles.editorBar} onMouseDown={(e) => e.preventDefault()}>
        <button type="button" className={styles.editorButton} title="Жирный" onClick={() => exec('bold')}>
          <b>Ж</b>
        </button>
        <button type="button" className={styles.editorButton} title="Наклонный" onClick={() => exec('italic')}>
          <i>К</i>
        </button>
        <button type="button" className={styles.editorButton} title="Подчёркнутый" onClick={() => exec('underline')}>
          <u>Ч</u>
        </button>
        <button
          type="button"
          className={styles.editorButton}
          title="Маркированный список"
          onClick={() => exec('insertUnorderedList')}
        >
          <IconListBulleted size={18} />
        </button>
        <button
          type="button"
          className={styles.editorButton}
          title="Вставить ссылку"
          onClick={() => {
            const url = window.prompt('Адрес ссылки');
            if (url) exec('createLink', url);
          }}
        >
          <IconLink size={18} />
        </button>
        <button
          type="button"
          className={styles.editorButton}
          title="Очистить форматирование"
          onClick={() => exec('removeFormat')}
        >
          <IconClearFormat size={18} />
        </button>
      </div>
      <div
        className={styles.editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Текст шаблона"
        onInput={(e) => setBodyHtml(e.currentTarget.innerHTML)}
        onBlur={(e) => setBodyHtml(e.currentTarget.innerHTML)}
        dangerouslySetInnerHTML={{ __html: initialHtml }}
      />

      <p className={styles.placeholders}>
        Подстановки: {TEMPLATE_PLACEHOLDERS.map((p) => `{{${p.key}}}`).join(', ')} — при вставке
        они заменятся на данные получателя, если он уже указан. Незаполненную подстановку
        письмо не даст отправить молча.
      </p>

      {attachments.length > 0 && (
        <div className={styles.dialogFiles}>
          <span className={styles.dialogFilesTitle}>
            <IconAttach size={14} />
            Вложения шаблона
          </span>
          <span className={styles.dialogFilesList}>
            {attachments.map((a) => `${a.filename} (${fileSizeText(a.size)})`).join(', ')}
          </span>
          {/*
            Заменить вложение здесь нечем — файл прикрепляют в письме, и
            путь один: вставить шаблон, поменять файл, сохранить заново.
            Поэтому кнопка ровно одна и называет, что именно делает.
          */}
          {onDropAttachments && (
            <Button mode="tertiary" size="s" disabled={busy} onClick={onDropAttachments}>
              Убрать вложения
            </Button>
          )}
        </div>
      )}

      {error && <SettingsError>{error}</SettingsError>}
    </Modal>
  );
}
