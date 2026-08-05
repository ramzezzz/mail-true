/**
 * Пользователи: список с поиском и фильтрами, создание, изменение,
 * блокировка, смена пароля, квота, массовые операции.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Checkbox } from '@web/components';
import { api } from '../api/client';
import type { MailUser } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { QuotaInput } from '../components/QuotaInput';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import {
  ActiveBadge,
  ErrorNotice,
  Field,
  Modal,
  Notice,
  Pager,
  Toolbar,
  ToolbarSpacer,
} from '../components/ui';
import { formatBytes, formatDateTime, pluralize } from '../lib/format';
import { checkDisplayName, checkMailboxAddress } from '../lib/mailboxName';
import { DEFAULT_QUOTA_UNIT, quotaToBytes, splitQuota, type QuotaUnit } from '../lib/quota';

const LIMIT = 50;

export function UsersPage() {
  const { can, session } = useSession();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'blocked'>('all');
  const [domainId, setDomainId] = useState<number | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState<MailUser | null>(null);
  const [editing, setEditing] = useState<MailUser | null>(null);
  const [enterFor, setEnterFor] = useState<MailUser | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  /**
   * Вход в чужой ящик доступен, только если настроен служебный доступ
   * Dovecot: без него сервер всё равно откажет, и кнопка вводила бы в
   * заблуждение.
   */
  const canEnterMailbox = can('mailbox.impersonate') && (session?.masterAccess ?? false);

  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.domains() });

  const users = useQuery({
    queryKey: ['users', search, status, domainId, offset],
    queryFn: () =>
      api.users({
        search: search.trim() || undefined,
        status,
        domainId,
        limit: LIMIT,
        offset,
      }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  };

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      api.updateUser(id, { active }),
    onSuccess: (user) => {
      setFlash(`Ящик ${user.email} ${user.active ? 'разблокирован' : 'заблокирован'}`);
      invalidate();
    },
  });

  const items = users.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((u) => selected.has(u.id));

  const selectedIds = useMemo(() => [...selected], [selected]);

  return (
    <>
      <PageTitle
        title="Пользователи"
        subtitle="Почтовые ящики: поиск, создание, блокировка, квоты и пароли"
      />

      {flash && <Notice tone="success">{flash}</Notice>}
      <ErrorNotice error={users.error ?? toggleActive.error} />

      <Toolbar>
        <input
          className="mt-input"
          style={{ width: 280 }}
          placeholder="Поиск по адресу или имени"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <select
          className="mt-select"
          style={{ width: 170 }}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as 'all' | 'active' | 'blocked');
            setOffset(0);
          }}
        >
          <option value="all">Все ящики</option>
          <option value="active">Только активные</option>
          <option value="blocked">Только заблокированные</option>
        </select>
        <select
          className="mt-select"
          style={{ width: 180 }}
          value={domainId ?? ''}
          onChange={(e) => {
            setDomainId(e.target.value === '' ? undefined : Number(e.target.value));
            setOffset(0);
          }}
        >
          <option value="">Все домены</option>
          {(domains.data?.items ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>

        <ToolbarSpacer />

        {selectedIds.length > 0 && can('users.write') && (
          <Button mode="secondary" size="s" onClick={() => setBulkOpen(true)}>
            Действия над {pluralize(selectedIds.length, 'ящиком', 'ящиками', 'ящиками')}
          </Button>
        )}
        {can('users.write') && (
          <>
            <Link to="/users/import">
              <Button mode="secondary" size="s">
                Импорт из CSV
              </Button>
            </Link>
            <Button size="s" onClick={() => setCreateOpen(true)}>
              Создать ящик
            </Button>
          </>
        )}
      </Toolbar>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              {can('users.write') && (
                <th style={{ width: 28 }}>
                  <Checkbox
                    checked={allSelected}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(items.map((u) => u.id)) : new Set())
                    }
                  />
                </th>
              )}
              <th>Адрес</th>
              <th>Имя</th>
              <th className={tableStyles.numeric}>Квота</th>
              <th className={tableStyles.numeric}>Алиасов</th>
              <th>Состояние</th>
              <th className={tableStyles.nowrap}>Создан</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr key={user.id} className={selected.has(user.id) ? tableStyles.selected : undefined}>
                {can('users.write') && (
                  <td>
                    <Checkbox
                      checked={selected.has(user.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(user.id);
                        else next.delete(user.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                )}
                <td className="mt-mono">{user.email}</td>
                <td>{user.displayName ?? '—'}</td>
                <td className={tableStyles.numeric}>{formatBytes(user.quotaBytes)}</td>
                <td className={tableStyles.numeric}>{user.aliasCount}</td>
                <td><ActiveBadge active={user.active} /></td>
                <td className={tableStyles.nowrap}>{formatDateTime(user.createdAt)}</td>
                <td>
                  <div className={tableStyles.actions}>
                    {can('users.write') && (
                      <Button mode="tertiary" size="s" onClick={() => setEditing(user)}>
                        Изменить
                      </Button>
                    )}
                    {can('users.password') && (
                      <Button mode="tertiary" size="s" onClick={() => setPasswordFor(user)}>
                        Пароль
                      </Button>
                    )}
                    {can('users.write') && (
                      <Button
                        mode="tertiary"
                        size="s"
                        onClick={() => toggleActive.mutate({ id: user.id, active: !user.active })}
                      >
                        {user.active ? 'Заблокировать' : 'Разблокировать'}
                      </Button>
                    )}
                    {canEnterMailbox && (
                      <Button mode="tertiary" size="s" onClick={() => setEnterFor(user)}>
                        Войти в ящик
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && !users.isLoading && (
              <EmptyRow colSpan={8}>
                {search ? 'По этому запросу ничего не нашлось' : 'Ящиков пока нет'}
              </EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>

      <Pager
        total={users.data?.total ?? 0}
        limit={LIMIT}
        offset={offset}
        onChange={setOffset}
      />

      {createOpen && (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onCreated={(message) => {
            setFlash(message);
            setCreateOpen(false);
            invalidate();
          }}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setFlash(message);
            setEditing(null);
            invalidate();
          }}
        />
      )}
      {passwordFor && (
        <PasswordModal
          user={passwordFor}
          onClose={() => setPasswordFor(null)}
          onDone={(message) => {
            setFlash(message);
            invalidate();
          }}
        />
      )}
      {enterFor && (
        <EnterMailboxModal user={enterFor} onClose={() => setEnterFor(null)} />
      )}
      {bulkOpen && (
        <BulkModal
          ids={selectedIds}
          onClose={() => setBulkOpen(false)}
          onDone={(message) => {
            setFlash(message);
            setBulkOpen(false);
            setSelected(new Set());
            invalidate();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Создание ящика                                                       */
/* ------------------------------------------------------------------ */

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [quotaAmount, setQuotaAmount] = useState('1');
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>(DEFAULT_QUOTA_UNIT);
  const [generated, setGenerated] = useState<{ email: string; password: string } | null>(null);

  const quotaBytes = quotaToBytes(quotaAmount, quotaUnit);
  const emailProblem = checkMailboxAddress(email);
  const displayNameProblem = checkDisplayName(displayName);
  const create = useMutation({
    mutationFn: () =>
      api.createUser({
        email: email.trim().toLowerCase(),
        ...(password ? { password } : {}),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(quotaBytes !== null ? { quotaBytes } : {}),
      }),
    onSuccess: (user) => {
      if (user.generatedPassword) {
        setGenerated({ email: user.email, password: user.generatedPassword });
      } else {
        onCreated(`Ящик ${user.email} создан`);
      }
    },
  });

  if (generated) {
    return (
      <Modal
        title="Ящик создан"
        onClose={() => onCreated(`Ящик ${generated.email} создан`)}
        footer={
          <Button onClick={() => onCreated(`Ящик ${generated.email} создан`)}>Понятно</Button>
        }
      >
        <Notice tone="info">
          Пароль показывается <strong>один раз</strong> — сохранён он нигде не будет.
        </Notice>
        <Field label="Адрес">
          <input className="mt-input mt-mono" readOnly value={generated.email} />
        </Field>
        <Field label="Пароль">
          <input className="mt-input mt-mono" readOnly value={generated.password} />
        </Field>
      </Modal>
    );
  }

  return (
    <Modal
      title="Новый почтовый ящик"
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={
              email.trim() === '' ||
              emailProblem !== null ||
              displayNameProblem !== null ||
              quotaBytes === null ||
              create.isPending
            }
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Создаём…' : 'Создать'}
          </Button>
        </>
      }
    >
      <ErrorNotice error={create.error} />
      <Field
        label="Адрес"
        hint={emailProblem ?? 'Домен должен быть заведён в разделе «Домены»'}
      >
        <input
          className="mt-input mt-mono"
          autoFocus
          placeholder="ivan@mail.local"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Отображаемое имя" {...(displayNameProblem ? { hint: displayNameProblem } : {})}>
        <input
          className="mt-input"
          placeholder="Иван Петров"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Field>
      <Field label="Пароль" hint="Оставьте пустым — сгенерируем и покажем один раз">
        <input
          className="mt-input mt-mono"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field
        label="Квота"
        hint={
          quotaBytes === null
            ? 'Введите число, а единицу выберите рядом. 0 — без ограничения.'
            : `Будет ${formatBytes(quotaBytes)}`
        }
      >
        <QuotaInput
          amount={quotaAmount}
          unit={quotaUnit}
          onAmount={setQuotaAmount}
          onUnit={setQuotaUnit}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Изменение ящика                                                      */
/* ------------------------------------------------------------------ */

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: MailUser;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const initial = splitQuota(user.quotaBytes);
  const [quotaAmount, setQuotaAmount] = useState(String(initial.amount));
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>(initial.unit);
  const quotaBytes = quotaToBytes(quotaAmount, quotaUnit);
  const displayNameProblem = checkDisplayName(displayName);

  const save = useMutation({
    mutationFn: () =>
      api.updateUser(user.id, {
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        ...(quotaBytes !== null ? { quotaBytes } : {}),
      }),
    onSuccess: () => onSaved(`Ящик ${user.email} изменён`),
  });

  return (
    <Modal
      title={`Ящик ${user.email}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={save.isPending || quotaBytes === null || displayNameProblem !== null}
            onClick={() => save.mutate()}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <ErrorNotice error={save.error} />
      <Field label="Отображаемое имя" {...(displayNameProblem ? { hint: displayNameProblem } : {})}>
        <input
          className="mt-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Field>
      <Field
        label="Квота"
        hint={
          quotaBytes === null
            ? 'Введите число, а единицу выберите рядом. 0 — без ограничения.'
            : `Сейчас ${formatBytes(user.quotaBytes)}, станет ${formatBytes(quotaBytes)}`
        }
      >
        <QuotaInput
          amount={quotaAmount}
          unit={quotaUnit}
          onAmount={setQuotaAmount}
          onUnit={setQuotaUnit}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Смена пароля                                                         */
/* ------------------------------------------------------------------ */

function PasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: MailUser;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [generated, setGenerated] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.setUserPassword(user.id, password || undefined),
    onSuccess: (result) => {
      if (result.generatedPassword) setGenerated(result.generatedPassword);
      else {
        onDone(`Пароль ящика ${user.email} изменён`);
        onClose();
      }
    },
  });

  return (
    <Modal
      title={`Пароль ящика ${user.email}`}
      onClose={() => {
        if (generated) onDone(`Пароль ящика ${user.email} изменён`);
        onClose();
      }}
      footer={
        generated ? (
          <Button
            onClick={() => {
              onDone(`Пароль ящика ${user.email} изменён`);
              onClose();
            }}
          >
            Понятно
          </Button>
        ) : (
          <>
            <Button mode="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button disabled={change.isPending} onClick={() => change.mutate()}>
              Сменить пароль
            </Button>
          </>
        )
      }
    >
      <ErrorNotice error={change.error} />
      {generated ? (
        <>
          <Notice tone="info">Пароль показывается один раз — передайте его владельцу ящика.</Notice>
          <Field label="Новый пароль">
            <input className="mt-input mt-mono" readOnly value={generated} />
          </Field>
        </>
      ) : (
        <Field label="Новый пароль" hint="Пусто — сгенерируем сами (не короче 8 символов)">
          <input
            className="mt-input mt-mono"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Массовые операции                                                    */
/* ------------------------------------------------------------------ */

function BulkModal({
  ids,
  onClose,
  onDone,
}: {
  ids: number[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<'quota' | 'block' | 'unblock'>('quota');
  const [quotaAmount, setQuotaAmount] = useState('1');
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>(DEFAULT_QUOTA_UNIT);
  const quotaBytes = quotaToBytes(quotaAmount, quotaUnit);

  const run = useMutation({
    mutationFn: () =>
      api.bulkUsers({
        ids,
        ...(mode === 'quota' && quotaBytes !== null ? { quotaBytes } : {}),
        ...(mode === 'block' ? { active: false } : {}),
        ...(mode === 'unblock' ? { active: true } : {}),
      }),
    onSuccess: (result) =>
      onDone(`Изменено ${pluralize(result.changed, 'ящик', 'ящика', 'ящиков')}`),
  });

  return (
    <Modal
      title={`Массовая операция над ${pluralize(ids.length, 'ящиком', 'ящиками', 'ящиками')}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={run.isPending || (mode === 'quota' && quotaBytes === null)}
            onClick={() => run.mutate()}
          >
            Применить
          </Button>
        </>
      }
    >
      <ErrorNotice error={run.error} />
      <Field label="Что сделать">
        <select
          className="mt-select"
          value={mode}
          onChange={(e) => setMode(e.target.value as 'quota' | 'block' | 'unblock')}
        >
          <option value="quota">Сменить квоту</option>
          <option value="block">Заблокировать</option>
          <option value="unblock">Разблокировать</option>
        </select>
      </Field>
      {mode === 'quota' && (
        <Field
          label="Новая квота"
          hint={
            quotaBytes === null
              ? 'Введите число, а единицу выберите рядом. 0 — без ограничения.'
              : `У всех выбранных ящиков станет ${formatBytes(quotaBytes)}`
          }
        >
          <QuotaInput
            amount={quotaAmount}
            unit={quotaUnit}
            onAmount={setQuotaAmount}
            onUnit={setQuotaUnit}
          />
        </Field>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Вход в чужой ящик                                                    */
/* ------------------------------------------------------------------ */

/**
 * Вход в ящик прямо из его строки в списке.
 *
 * Раньше для этого был отдельный раздел, где нужный адрес приходилось
 * искать заново — руками, по памяти. Адрес здесь уже известен, поэтому
 * спрашивается только причина: она обязательна, попадает в журнал аудита
 * и видна владельцу ящика.
 */
function EnterMailboxModal({ user, onClose }: { user: MailUser; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  // Тот же порог, что и на сервере: причина короче пяти значащих
  // символов объяснением не является.
  const reasonReady = reason.replace(/\s+/gu, '').length >= 5;

  const enter = useMutation({
    mutationFn: () => api.mailboxEnter(user.email, reason.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mailbox-session'] });
      onClose();
      navigate('/mailbox');
    },
  });

  return (
    <Modal
      title={`Войти в ящик ${user.email}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={!reasonReady || enter.isPending} onClick={() => enter.mutate()}>
            {enter.isPending ? 'Входим…' : 'Войти в ящик'}
          </Button>
        </>
      }
    >
      <ErrorNotice error={enter.error} />
      <Field
        label="Причина входа"
        hint="Обязательное поле. Запись попадёт в журнал аудита, владелец ящика её увидит."
      >
        <input
          className="mt-input"
          autoFocus
          placeholder="Обращение №1234: письмо не пришло, проверяем доставку"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Notice tone="info">
        Отправлять письма от имени владельца нельзя. Флаг «прочитано» при просмотре не
        ставится — следов в ящике не остаётся.
      </Notice>
    </Modal>
  );
}
