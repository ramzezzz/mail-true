/**
 * Настройки чужого ящика из админки: подписи, имя отправителя,
 * автоответчик, фильтры (включая пересылку), папки.
 *
 * Страница намеренно повторяет то, что видит сам пользователь в разделе
 * настроек почты: заказчик просил «как у юзера». Поля, порядок и смысл
 * тот же, отличия только там, где они вынуждены:
 *
 *  - сверху плашка: это ЧУЖОЙ ящик и всё сделанное попадёт в журнал;
 *  - «применить правило к уже полученным письмам» здесь нет — это
 *    перекладывание чужой почты по всем папкам без ведома владельца;
 *  - роль «только чтение» видит всё то же самое, но без кнопок.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Button, Checkbox } from '@web/components';
import { api } from '../api/client';
import type {
  SieveSyncState,
  UserFilterCondition,
  UserFilterRule,
  UserGeneralSettings,
  UserMailFolder,
} from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { RowActions } from '../components/RowActions';
import { IconPencil, IconTrash } from '../components/icons';
import { ErrorNotice, Field, Modal, Notice, Panel, Toolbar, ToolbarSpacer } from '../components/ui';
import { sieveNotice } from '../lib/sieveState';
import styles from './UserSettingsPage.module.css';

/** Названия полей условия — те же слова, что видит пользователь. */
const FIELD_LABELS: Record<string, string> = {
  from: 'От кого',
  to: 'Кому',
  subject: 'Тема',
  cc: 'Копия',
  size: 'Размер (КБ)',
  'resent-from': 'Переадресовано от',
  'resent-to': 'Переадресовано для',
};

const OPERATOR_LABELS: Record<string, string> = {
  contains: 'содержит',
  'not-contains': 'не содержит',
  equals: 'совпадает с',
  greater: 'больше',
  less: 'меньше',
};

/** Пустое правило для формы создания. */
function emptyRule(): UserFilterRule {
  return {
    id: '',
    enabled: true,
    auto: false,
    conditions: [{ field: 'from', operator: 'contains', value: '' }],
    actions: {
      moveToFolderId: null,
      markRead: false,
      markFlagged: false,
      applyToExistingFolderIds: [],
      forwardTo: null,
      autoReply: null,
      continueOtherFilters: true,
      applyToSpam: false,
    },
  };
}

/** Короткое описание правила для списка. */
function ruleSummary(rule: UserFilterRule, folders: UserMailFolder[]): string {
  const conditions = rule.conditions
    .map(
      (c) =>
        `${FIELD_LABELS[c.field] ?? c.field} ${OPERATOR_LABELS[c.operator] ?? c.operator} «${c.value}»`,
    )
    .join(' и ');
  const actions: string[] = [];
  if (rule.actions.moveToFolderId) {
    const folder = folders.find((f) => f.id === rule.actions.moveToFolderId);
    actions.push(`в папку «${folder?.path ?? rule.actions.moveToFolderId}»`);
  }
  if (rule.actions.markRead) actions.push('пометить прочитанным');
  if (rule.actions.markFlagged) actions.push('поставить флажок');
  if (rule.actions.forwardTo) actions.push(`переслать на ${rule.actions.forwardTo}`);
  if (rule.actions.autoReply) actions.push('ответить автоматически');
  return `${conditions || 'все письма'} → ${actions.join(', ') || 'ничего не делать'}`;
}

/**
 * Состояние переписывания файла правил — словами.
 * Сам текст живёт в lib/sieveState.ts и покрыт тестом: «не скомпилировано»
 * и «не записано» — разные беды, и путать их нельзя.
 */
function SieveNotice({ state }: { state: SieveSyncState | null }) {
  const notice = sieveNotice(state);
  if (!notice) return null;
  return <Notice tone={notice.tone}>{notice.text}</Notice>;
}

export function UserSettingsPage() {
  const params = useParams();
  const userId = Number(params.id);
  const { can } = useSession();
  const queryClient = useQueryClient();
  const editable = can('usersettings.write');

  const [flash, setFlash] = useState<string | null>(null);
  const [sieve, setSieve] = useState<SieveSyncState | null>(null);
  const [editingRule, setEditingRule] = useState<UserFilterRule | null>(null);
  /*
   * Правило, которое собираются удалить.
   *
   * Удаление шло сразу по нажатию — без вопроса и без возможности
   * вернуть. Значок стоит вплотную к «Изменить», промах на один значок
   * стоил человеку правила, которое он настраивал руками: условия,
   * папка, порядок в цепочке. Восстановить его неоткуда — правила
   * живут в sieve-файле ящика, а не в журнале.
   */
  const [deletingRule, setDeletingRule] = useState<UserFilterRule | null>(null);
  const [showScript, setShowScript] = useState(false);

  const bundle = useQuery({
    queryKey: ['user-settings', userId],
    queryFn: () => api.userSettings(userId),
    enabled: Number.isInteger(userId) && userId > 0,
  });

  /* Черновик формы: правится локально, уходит на сервер одной кнопкой —
     ровно как в пользовательских настройках. */
  const [draft, setDraft] = useState<UserGeneralSettings | null>(null);
  useEffect(() => {
    if (bundle.data) setDraft(bundle.data.general);
  }, [bundle.data]);

  const folders = bundle.data?.folders ?? [];
  const filters = bundle.data?.filters ?? [];

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['user-settings', userId] });
  };

  const saveGeneral = useMutation({
    mutationFn: (body: UserGeneralSettings) => api.saveUserGeneral(userId, body),
    onSuccess: (result) => {
      setFlash('Настройки ящика сохранены. Запись об этом ушла в журнал аудита.');
      setSieve(result.sieve);
      invalidate();
    },
  });

  const saveRule = useMutation({
    mutationFn: (rule: UserFilterRule) =>
      rule.id === ''
        ? api.createUserFilter(userId, rule)
        : api.updateUserFilter(userId, rule.id, rule),
    onSuccess: (result) => {
      setFlash('Правило сохранено, файл правил ящика переписан.');
      setSieve(result.sieve);
      setEditingRule(null);
      invalidate();
    },
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => api.deleteUserFilter(userId, id),
    onSuccess: (result) => {
      setFlash('Правило удалено.');
      setSieve(result.sieve);
      invalidate();
    },
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.reorderUserFilters(userId, ids),
    onSuccess: () => invalidate(),
  });

  const script = useQuery({
    queryKey: ['user-sieve', userId],
    queryFn: () => api.userSieve(userId),
    enabled: showScript,
  });

  /** Переставляет правило на одну позицию. */
  const move = (index: number, delta: number): void => {
    const ids = filters.map((r) => r.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    const moved = next[index];
    const other = next[target];
    if (moved === undefined || other === undefined) return;
    next[index] = other;
    next[target] = moved;
    reorder.mutate(next);
  };

  const mailbox = bundle.data?.mailbox;

  const busy = saveGeneral.isPending || saveRule.isPending || deleteRule.isPending;

  const error =
    bundle.error ?? saveGeneral.error ?? saveRule.error ?? deleteRule.error ?? reorder.error;

  const signatureIds = useMemo(() => new Set((draft?.signatures ?? []).map((s) => s.id)), [draft]);

  return (
    <>
      <PageTitle
        title={mailbox ? `Настройки ящика ${mailbox.email}` : 'Настройки ящика'}
        subtitle="Те же подписи, фильтры и автоответчик, которые видит сам владелец"
      />

      {/*
        Плашка не украшение: администратор правит ЧУЖИЕ настройки, и он
        должен видеть это до того, как нажмёт «Сохранить», а не узнавать
        из журнала аудита потом.
      */}
      <Notice tone="info">
        Это настройки чужого ящика{mailbox ? ` (${mailbox.email})` : ''}. Каждое изменение
        записывается в журнал аудита с указанием, чей ящик и что изменено.{' '}
        {!editable && 'Ваша роль позволяет только смотреть.'}{' '}
        <Link to="/users">К списку ящиков</Link>
      </Notice>

      {flash && <Notice tone="success">{flash}</Notice>}
      <SieveNotice state={sieve} />
      <ErrorNotice error={error} />

      {bundle.data && !bundle.data.foldersAvailable && (
        <Notice tone="error">
          Папки ящика недоступны: {bundle.data.foldersError ?? 'причина неизвестна'}. Правило
          «переложить в папку» без списка папок не задать — остальные настройки работают.
        </Notice>
      )}

      {/* ---------------- Подписи и имя отправителя ---------------- */}
      <Panel title="Имя отправителя и подписи">
        {draft && (
          <div className={styles.grid}>
            <Field label="Имя отправителя" hint="Подставляется в заголовок «От кого»">
              <input
                className="mt-input"
                value={draft.senderName}
                disabled={!editable}
                onChange={(e) => setDraft({ ...draft, senderName: e.target.value })}
              />
            </Field>

            {draft.signatures.map((signature, index) => (
              <div key={signature.id || `new-${index}`} className={styles.signature}>
                <div className={styles.signatureHead}>
                  <input
                    className={`mt-input ${styles.signatureName}`}
                    placeholder="Название подписи"
                    value={signature.name}
                    disabled={!editable}
                    onChange={(e) => {
                      const next = [...draft.signatures];
                      next[index] = { ...signature, name: e.target.value };
                      setDraft({ ...draft, signatures: next });
                    }}
                  />
                  <label className={styles.row}>
                    <Checkbox
                      checked={draft.defaultSignatureId === signature.id && signature.id !== ''}
                      disabled={!editable || signature.id === ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          defaultSignatureId: e.target.checked ? signature.id : null,
                        })
                      }
                    />
                    <span>по умолчанию</span>
                  </label>
                  {editable && (
                    <Button
                      mode="tertiary"
                      size="s"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          signatures: draft.signatures.filter((_, i) => i !== index),
                          defaultSignatureId:
                            draft.defaultSignatureId === signature.id
                              ? null
                              : draft.defaultSignatureId,
                        })
                      }
                    >
                      Удалить
                    </Button>
                  )}
                </div>
                <textarea
                  className={`mt-input ${styles.textarea}`}
                  value={signature.text}
                  disabled={!editable}
                  onChange={(e) => {
                    const next = [...draft.signatures];
                    next[index] = { ...signature, text: e.target.value };
                    setDraft({ ...draft, signatures: next });
                  }}
                />
              </div>
            ))}

            {draft.signatures.length === 0 && (
              <p className={styles.muted}>У этого ящика нет ни одной подписи.</p>
            )}

            {editable && (
              <Toolbar>
                <Button
                  mode="secondary"
                  size="s"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      signatures: [
                        ...draft.signatures,
                        // Пустой идентификатор — признак новой подписи: сервер
                        // заведёт её и вернёт настоящий номер.
                        { id: '', name: `Подпись ${String(signatureIds.size + 1)}`, text: '' },
                      ],
                    })
                  }
                >
                  Добавить подпись
                </Button>
                <ToolbarSpacer />
                <Button size="s" disabled={busy} onClick={() => saveGeneral.mutate(draft)}>
                  {saveGeneral.isPending ? 'Сохраняем…' : 'Сохранить настройки'}
                </Button>
              </Toolbar>
            )}
          </div>
        )}
      </Panel>

      {/* ---------------- Автоответчик ---------------- */}
      <Panel title="Автоответчик">
        {draft && (
          <div className={styles.grid}>
            <label className={styles.row}>
              <Checkbox
                checked={draft.autoReply.enabled}
                disabled={!editable}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    autoReply: { ...draft.autoReply, enabled: e.target.checked },
                  })
                }
              />
              <span>Отвечать автоматически на входящие письма</span>
            </label>
            <textarea
              className={`mt-input ${styles.textarea}`}
              placeholder="Текст автоответа"
              value={draft.autoReply.text}
              disabled={!editable}
              onChange={(e) =>
                setDraft({ ...draft, autoReply: { ...draft.autoReply, text: e.target.value } })
              }
            />
            <div className={styles.row}>
              <Field label="С">
                <input
                  className="mt-input"
                  type="date"
                  value={(draft.autoReply.from ?? '').slice(0, 10)}
                  disabled={!editable}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      autoReply: { ...draft.autoReply, from: e.target.value || null },
                    })
                  }
                />
              </Field>
              <Field label="По">
                <input
                  className="mt-input"
                  type="date"
                  value={(draft.autoReply.to ?? '').slice(0, 10)}
                  disabled={!editable}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      autoReply: { ...draft.autoReply, to: e.target.value || null },
                    })
                  }
                />
              </Field>
            </div>
            {editable && (
              <Toolbar>
                <ToolbarSpacer />
                <Button size="s" disabled={busy} onClick={() => saveGeneral.mutate(draft)}>
                  Сохранить автоответчик
                </Button>
              </Toolbar>
            )}
          </div>
        )}
      </Panel>

      {/* ---------------- Фильтры ---------------- */}
      <Panel title="Фильтры и пересылка">
        <Toolbar>
          <span className={styles.muted}>
            Правила действуют на новые письма: к уже полученным админка их не применяет.
          </span>
          <ToolbarSpacer />
          {editable && (
            <Button mode="secondary" size="s" onClick={() => setEditingRule(emptyRule())}>
              Добавить правило
            </Button>
          )}
        </Toolbar>
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>Порядок</th>
                <th>Правило</th>
                <th style={{ width: 110 }}>Состояние</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filters.map((rule, index) => (
                <tr key={rule.id}>
                  <td className={tableStyles.nowrap}>
                    <Button
                      mode="tertiary"
                      size="s"
                      disabled={!editable || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      mode="tertiary"
                      size="s"
                      disabled={!editable || index === filters.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </Button>
                  </td>
                  <td>{ruleSummary(rule, folders)}</td>
                  <td>{rule.enabled ? 'включено' : 'выключено'}</td>
                  <td>
                    {editable && (
                      <RowActions
                        subject={ruleSummary(rule, folders)}
                        actions={[
                          {
                            id: 'edit',
                            icon: <IconPencil />,
                            label: 'Изменить',
                            onClick: () => setEditingRule(rule),
                          },
                          {
                            id: 'delete',
                            icon: <IconTrash />,
                            label: 'Удалить',
                            danger: true,
                            onClick: () => setDeletingRule(rule),
                          },
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
              {filters.length === 0 && !bundle.isLoading && (
                <EmptyRow colSpan={4}>У этого ящика нет правил фильтрации</EmptyRow>
              )}
            </tbody>
          </Table>
        </TableWrap>
      </Panel>

      {/* ---------------- Папки и файл правил ---------------- */}
      <Panel title="Папки ящика">
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>Папка</th>
                <th className={tableStyles.numeric}>Писем</th>
                <th className={tableStyles.numeric}>Непрочитанных</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr key={folder.id}>
                  <td style={{ paddingLeft: 8 + folder.depth * 16 }}>{folder.name}</td>
                  <td className={tableStyles.numeric}>{folder.totalCount}</td>
                  <td className={tableStyles.numeric}>{folder.unreadCount}</td>
                </tr>
              ))}
              {folders.length === 0 && <EmptyRow colSpan={3}>Папки недоступны</EmptyRow>}
            </tbody>
          </Table>
        </TableWrap>
      </Panel>

      <Panel title="Действующий файл правил Dovecot">
        <Toolbar>
          <span className={styles.muted}>
            То, что на самом деле лежит в ящике. Полезно, когда «правило есть, а не работает».
          </span>
          <ToolbarSpacer />
          <Button mode="secondary" size="s" onClick={() => setShowScript(!showScript)}>
            {showScript ? 'Скрыть' : 'Показать'}
          </Button>
        </Toolbar>
        {showScript && (
          <pre className={`mt-mono ${styles.script}`}>
            {script.data?.script ?? 'Файла правил нет: у ящика нет ни фильтров, ни автоответчика.'}
          </pre>
        )}
      </Panel>

      {editingRule && (
        <RuleModal
          rule={editingRule}
          folders={folders}
          saving={saveRule.isPending}
          onClose={() => setEditingRule(null)}
          onSave={(rule) => saveRule.mutate(rule)}
        />
      )}

      {deletingRule && (
        <Modal
          title="Удалить правило?"
          onClose={() => setDeletingRule(null)}
          footer={
            <>
              <Button mode="secondary" onClick={() => setDeletingRule(null)}>
                Отмена
              </Button>
              <Button
                disabled={deleteRule.isPending}
                onClick={() => {
                  deleteRule.mutate(deletingRule.id);
                  setDeletingRule(null);
                }}
              >
                Удалить
              </Button>
            </>
          }
        >
          <Notice tone="error">
            Правило удаляется насовсем: вернуть его будет неоткуда — правила живут в файле фильтров
            ящика, а не в журнале.
          </Notice>
          <p className="mt-mono" style={{ margin: '10px 0 0' }}>
            {ruleSummary(deletingRule, folders)}
          </p>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Форма правила                                                        */
/* ------------------------------------------------------------------ */

function RuleModal({
  rule,
  folders,
  saving,
  onClose,
  onSave,
}: {
  rule: UserFilterRule;
  folders: UserMailFolder[];
  saving: boolean;
  onClose: () => void;
  onSave: (rule: UserFilterRule) => void;
}) {
  const [draft, setDraft] = useState<UserFilterRule>(rule);

  const setCondition = (index: number, patch: Partial<UserFilterCondition>): void => {
    const next = [...draft.conditions];
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, ...patch };
    setDraft({ ...draft, conditions: next });
  };

  /* Пустое условие сервер не примет (value обязателен) — говорим об этом
     здесь, а не после отправки общей фразой про «некорректные данные». */
  const problem =
    draft.conditions.length === 0
      ? 'Добавьте хотя бы одно условие'
      : draft.conditions.some((c) => c.value.trim() === '')
        ? 'У каждого условия должно быть значение'
        : null;

  return (
    <Modal
      title={rule.id === '' ? 'Новое правило' : 'Изменение правила'}
      wide
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={saving || problem !== null}
            title={problem ?? undefined}
            onClick={() => onSave(draft)}
          >
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </>
      }
    >
      {problem && <Notice tone="error">{problem}</Notice>}

      <Field label="Условия (выполняются все сразу)">
        <div>
          {draft.conditions.map((condition, index) => (
            <div key={index} className={styles.condition}>
              <select
                className="mt-select"
                style={{ width: 170 }}
                value={condition.field}
                onChange={(e) =>
                  setCondition(index, { field: e.target.value as UserFilterCondition['field'] })
                }
              >
                {Object.entries(FIELD_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                className="mt-select"
                style={{ width: 150 }}
                value={condition.operator}
                onChange={(e) =>
                  setCondition(index, {
                    operator: e.target.value as UserFilterCondition['operator'],
                  })
                }
              >
                {Object.entries(OPERATOR_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                className="mt-input"
                style={{ flex: 1, minWidth: 160 }}
                value={condition.value}
                onChange={(e) => setCondition(index, { value: e.target.value })}
              />
              <Button
                mode="tertiary"
                size="s"
                onClick={() =>
                  setDraft({
                    ...draft,
                    conditions: draft.conditions.filter((_, i) => i !== index),
                  })
                }
              >
                Убрать
              </Button>
            </div>
          ))}
          <Button
            mode="secondary"
            size="s"
            onClick={() =>
              setDraft({
                ...draft,
                conditions: [
                  ...draft.conditions,
                  { field: 'from', operator: 'contains', value: '' },
                ],
              })
            }
          >
            Добавить условие
          </Button>
        </div>
      </Field>

      <Field label="Переложить в папку">
        <select
          className="mt-select"
          value={draft.actions.moveToFolderId ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              actions: { ...draft.actions, moveToFolderId: e.target.value || null },
            })
          }
        >
          <option value="">— не перекладывать —</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.path}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Переслать копию на адрес"
        hint="Пересылка делается сервером при доставке, копия остаётся в ящике"
      >
        <input
          className="mt-input"
          placeholder="—"
          value={draft.actions.forwardTo ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              actions: { ...draft.actions, forwardTo: e.target.value.trim() || null },
            })
          }
        />
      </Field>

      <Field label="Ответить автоматически">
        <textarea
          className={`mt-input ${styles.textarea}`}
          placeholder="—"
          value={draft.actions.autoReply ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              actions: { ...draft.actions, autoReply: e.target.value || null },
            })
          }
        />
      </Field>

      <div className={styles.grid}>
        <label className={styles.row}>
          <Checkbox
            checked={draft.actions.markRead}
            onChange={(e) =>
              setDraft({ ...draft, actions: { ...draft.actions, markRead: e.target.checked } })
            }
          />
          <span>Пометить прочитанным</span>
        </label>
        <label className={styles.row}>
          <Checkbox
            checked={draft.actions.markFlagged}
            onChange={(e) =>
              setDraft({ ...draft, actions: { ...draft.actions, markFlagged: e.target.checked } })
            }
          />
          <span>Поставить флажок</span>
        </label>
        <label className={styles.row}>
          <Checkbox
            checked={draft.actions.applyToSpam}
            onChange={(e) =>
              setDraft({ ...draft, actions: { ...draft.actions, applyToSpam: e.target.checked } })
            }
          />
          <span>Применять и к письмам, помеченным как спам</span>
        </label>
        <label className={styles.row}>
          <Checkbox
            checked={draft.actions.continueOtherFilters}
            onChange={(e) =>
              setDraft({
                ...draft,
                actions: { ...draft.actions, continueOtherFilters: e.target.checked },
              })
            }
          />
          <span>После срабатывания применять остальные правила</span>
        </label>
        <label className={styles.row}>
          <Checkbox
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          <span>Правило включено</span>
        </label>
      </div>
    </Modal>
  );
}
