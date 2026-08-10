/**
 * Администраторы панели.
 *
 * ЗАЧЕМ РАЗДЕЛ. Право `admins.manage` и список на чтение были с самого
 * начала, а завести второго администратора, сменить роль, сбросить
 * пароль или ОТКЛЮЧИТЬ учётную запись уволенного можно было только из
 * консоли сервера. То есть самое срочное действие после увольнения или
 * утечки пароля требовало ssh и docker exec — а они есть не у того, кто
 * первым узнаёт об увольнении.
 *
 * Чего здесь намеренно НЕТ — удаления учётной записи. Журнал аудита
 * ссылается на администратора, и стёртая строка превратила бы историю
 * действий в «кто-то». Уволенного выключают: доступ он теряет на
 * следующем же запросе (роль и признак «действует» перечитываются из
 * базы каждый раз), а прошлые действия остаются подписанными.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type { AdminAccount, AdminRole } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import {
  ActiveBadge,
  ErrorNotice,
  Field,
  Modal,
  Notice,
  Toolbar,
  ToolbarSpacer,
} from '../components/ui';
import { ROLE_LABELS } from '../lib/access';
import { formatDateTime } from '../lib/format';

const ROLES: readonly AdminRole[] = ['owner', 'user_manager', 'readonly'];

/** Пароль администратора: тот же порог, что и на сервере. */
const MIN_PASSWORD = 12;

/** Что означает роль — словами, а не «см. документацию». */
export function roleHint(role: AdminRole): string {
  if (role === 'owner') {
    return 'Всё: ящики, домены, настройки сервера, резервные копии и эти самые администраторы';
  }
  if (role === 'user_manager') {
    return 'Ящики, алиасы, домены и настройки пользователей. Настройки сервера — нет';
  }
  return 'Только просмотр: изменить нельзя ничего';
}

export function AdminsPage() {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const [addOpen, setAddOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState<AdminAccount | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const list = useQuery({ queryKey: ['admins'], queryFn: () => api.admins() });
  const items = list.data?.items ?? [];

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { role?: AdminRole; active?: boolean } }) =>
      api.updateAdmin(id, patch),
    onSuccess: (admin) => {
      setError(null);
      setFlash(`Учётная запись «${admin.login}» изменена`);
      void queryClient.invalidateQueries({ queryKey: ['admins'] });
    },
    onError: (err: unknown) => setError(err),
  });

  return (
    <>
      <PageTitle title="Администраторы" />

      <Toolbar>
        <span className="mt-muted">
          Роль и признак «действует» читаются из базы на каждом запросе: выключенный теряет доступ
          сразу, не дожидаясь конца своей сессии.
        </span>
        <ToolbarSpacer />
        <Button onClick={() => setAddOpen(true)}>Добавить</Button>
      </Toolbar>

      {flash !== null && <Notice tone="success">{flash}</Notice>}
      <ErrorNotice error={error ?? list.error} />

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Логин</th>
              <th>Роль</th>
              <th>Последний вход</th>
              <th>Действует</th>
              <th aria-label="Действия" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <EmptyRow colSpan={5}>Администраторов нет</EmptyRow>}
            {items.map((admin) => {
              const isMe = session?.login === admin.login;
              return (
                <tr key={admin.id}>
                  <td>
                    <div className={tableStyles.primary}>
                      {admin.login}
                      {isMe && <span className="mt-muted"> — это вы</span>}
                    </div>
                    {admin.displayName !== null && admin.displayName !== '' && (
                      <div className="mt-muted">{admin.displayName}</div>
                    )}
                  </td>
                  <td>
                    <select
                      className="mt-select"
                      value={admin.role}
                      /*
                       * Свою роль сменить нельзя — и это не вежливость к
                       * начальству: сняв с себя права, человек потеряет
                       * доступ на следующем же запросе, а вернуть их будет
                       * некому. Сервер проверяет это же.
                       */
                      disabled={isMe || update.isPending}
                      onChange={(e) =>
                        update.mutate({
                          id: admin.id,
                          patch: { role: e.target.value as AdminRole },
                        })
                      }
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {admin.lastLoginAt === null ? (
                      <span className="mt-muted">ни разу</span>
                    ) : (
                      <>
                        {formatDateTime(admin.lastLoginAt)}
                        {admin.lastLoginIp !== null && (
                          <div className="mt-muted">{admin.lastLoginIp}</div>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <ActiveBadge active={admin.active} />
                  </td>
                  <td>
                    <Button
                      mode="secondary"
                      size="s"
                      disabled={isMe || update.isPending}
                      onClick={() =>
                        update.mutate({ id: admin.id, patch: { active: !admin.active } })
                      }
                    >
                      {admin.active ? 'Выключить' : 'Включить'}
                    </Button>{' '}
                    <Button mode="secondary" size="s" onClick={() => setPasswordFor(admin)}>
                      Сменить пароль
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </TableWrap>

      {addOpen && (
        <CreateAdminModal
          onClose={() => setAddOpen(false)}
          onCreated={(login) => {
            setAddOpen(false);
            setFlash(`Администратор «${login}» создан`);
            void queryClient.invalidateQueries({ queryKey: ['admins'] });
          }}
        />
      )}
      {passwordFor !== null && (
        <PasswordModal admin={passwordFor} onClose={() => setPasswordFor(null)} />
      )}
    </>
  );
}

function CreateAdminModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (login: string) => void;
}) {
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AdminRole>('readonly');
  const [error, setError] = useState<unknown>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createAdmin({
        login: login.trim().toLowerCase(),
        password,
        role,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      }),
    onSuccess: (admin) => onCreated(admin.login),
    onError: (err: unknown) => setError(err),
  });

  const passwordProblem =
    password === '' || password.length >= MIN_PASSWORD
      ? `Не короче ${String(MIN_PASSWORD)} знаков`
      : `Слишком короткий: нужно не меньше ${String(MIN_PASSWORD)} знаков`;

  return (
    <Modal
      title="Новый администратор"
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={login.trim() === '' || password.length < MIN_PASSWORD || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Создаём…' : 'Создать'}
          </Button>
        </>
      }
    >
      <ErrorNotice error={error} />
      <Field label="Логин" hint="Латиница, цифры, точка, дефис и подчёркивание">
        <input
          className="mt-input mt-mono"
          value={login}
          autoComplete="off"
          onChange={(e) => setLogin(e.target.value)}
        />
      </Field>
      <Field label="Имя" hint="Необязательно — как показывать в панели">
        <input
          className="mt-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Field>
      <Field label="Пароль" hint={passwordProblem}>
        <input
          className="mt-input mt-mono"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Роль" hint={roleHint(role)}>
        <select
          className="mt-select"
          value={role}
          onChange={(e) => setRole(e.target.value as AdminRole)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function PasswordModal({ admin, onClose }: { admin: AdminAccount; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const change = useMutation({
    mutationFn: () => api.setAdminPassword(admin.id, password),
    onSuccess: (result) => {
      /*
       * Сколько сессий закрыто — не украшение. Смена пароля здесь для
       * того и нужна, чтобы выгнать того, у кого украли cookie; молчание
       * оставило бы вопрос «а точно выгнало?».
       */
      setDone(
        result.closedSessions === null
          ? 'Пароль сменён. Сколько сессий закрыто — неизвестно: ' +
              (result.sessionsProblem ?? 'хранилище сессий недоступно')
          : `Пароль сменён, закрыто сессий: ${String(result.closedSessions)}.`,
      );
      setError(null);
    },
    onError: (err: unknown) => setError(err),
  });

  return (
    <Modal
      title={`Пароль администратора ${admin.login}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Закрыть
          </Button>
          <Button
            disabled={password.length < MIN_PASSWORD || change.isPending}
            onClick={() => change.mutate()}
          >
            {change.isPending ? 'Меняем…' : 'Сменить пароль'}
          </Button>
        </>
      }
    >
      <ErrorNotice error={error} />
      {done !== null && <Notice tone="success">{done}</Notice>}
      <Field
        label="Новый пароль"
        hint={`Не короче ${String(MIN_PASSWORD)} знаков. Все сессии этой учётной записи закроются.`}
      >
        <input
          className="mt-input mt-mono"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
