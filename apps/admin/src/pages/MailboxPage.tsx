/**
 * Чтение ящика пользователя администратором.
 *
 * Входят сюда кнопкой «Войти в ящик» из списка ящиков — там адрес уже
 * известен, и причина спрашивается прямо в строке списка. Отдельного
 * пункта меню у страницы нет: искать нужный адрес заново не нужно.
 *
 * Сеанс помечен плашкой, отправка писем недоступна — в этом режиме API
 * её просто не предоставляет.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '@web/components';
import { api, ApiError } from '../api/client';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { ErrorNotice, Notice, Panel } from '../components/ui';
import { formatBytes, formatDateTime } from '../lib/format';
import { folderTitle, isServiceFolder } from '../lib/folderNames';

export function MailboxPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [path, setPath] = useState('INBOX');
  const [openUid, setOpenUid] = useState<number | null>(null);

  const current = useQuery({
    queryKey: ['mailbox-session'],
    queryFn: async () => {
      try {
        return await api.mailboxSession();
      } catch (err) {
        if (err instanceof ApiError && err.isUnauthorized) return null;
        throw err;
      }
    },
    retry: false,
  });

  const active = current.data ?? null;

  const leave = useMutation({
    mutationFn: () => api.mailboxLeave(),
    onSuccess: () => {
      setOpenUid(null);
      void queryClient.invalidateQueries({ queryKey: ['mailbox-session'] });
    },
  });

  const folders = useQuery({
    queryKey: ['mailbox-folders', active?.mailboxEmail],
    queryFn: () => api.mailboxFolders(),
    enabled: active !== null,
  });

  const messages = useQuery({
    queryKey: ['mailbox-messages', active?.mailboxEmail, path],
    queryFn: () => api.mailboxMessages(path, 50, 0),
    enabled: active !== null,
  });

  const message = useQuery({
    queryKey: ['mailbox-message', active?.mailboxEmail, path, openUid],
    queryFn: () => api.mailboxMessage(path, openUid ?? 0),
    enabled: active !== null && openUid !== null,
  });

  if (!session?.masterAccess) {
    return (
      <>
        <PageTitle title="Ящик пользователя" />
        <Notice tone="error">
          Служебный доступ Dovecot не настроен, поэтому войти в чужой ящик нельзя.
          <br />
          Задайте <code className="mt-mono">DOVECOT_MASTER_USER</code> и{' '}
          <code className="mt-mono">DOVECOT_MASTER_PASSWORD</code> в <code className="mt-mono">infra/.env</code>{' '}
          и в окружении API, затем перезапустите dovecot. Подменять пароль пользователя
          админка не будет — это оставило бы владельца без доступа.
        </Notice>
      </>
    );
  }

  // Сеанса нет — сюда попали по прямой ссылке или после выхода из ящика.
  // Вход начинается в списке ящиков: там адрес уже известен.
  if (!active) {
    return (
      <>
        <PageTitle title="Ящик пользователя" />
        <Notice tone="info">
          Сейчас вы не в чужом ящике. Войти в него можно кнопкой «Войти в ящик» в строке
          нужного ящика — в разделе «Пользователи».
        </Notice>
        <Panel>
          <Link to="/users">
            <Button mode="secondary" size="s">
              К списку ящиков
            </Button>
          </Link>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageTitle title={`Ящик ${active.mailboxEmail}`} />

      <Notice tone="error">
        <strong>Вы вошли как администратор в ящик {active.mailboxEmail}.</strong>
        <br />
        Причина: {active.reason}. Начало сеанса: {formatDateTime(active.startedAt)}.
        Отправка писем запрещена.{' '}
        <Button mode="secondary" size="s" disabled={leave.isPending} onClick={() => leave.mutate()}>
          {leave.isPending ? 'Выходим…' : 'Выйти из ящика'}
        </Button>
      </Notice>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12 }}>
        <Panel title="Папки">
          <TableWrap>
            <Table>
              <tbody>
                {/* Служебные каталоги почтового сервера человеку не показываем:
                    он может принять их за папки и удалить. */}
                {(folders.data?.folders ?? [])
                  .filter((folder) => !isServiceFolder(folder))
                  .map((folder) => (
                  <tr key={folder.path}>
                    <td>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          color:
                            folder.path === path
                              ? 'var(--mt-color-text-link)'
                              : 'var(--mt-color-text-primary)',
                          fontWeight: folder.path === path ? 500 : 400,
                        }}
                        onClick={() => {
                          setPath(folder.path);
                          setOpenUid(null);
                        }}
                      >
                        {folderTitle(folder)}
                      </button>
                    </td>
                    <td className={tableStyles.numeric}>{folder.messages}</td>
                  </tr>
                ))}
                {(folders.data?.folders ?? []).length === 0 && <EmptyRow colSpan={2}>—</EmptyRow>}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>

        <Panel title={`Письма — ${path}`}>
          <ErrorNotice error={messages.error} />
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th className={tableStyles.nowrap}>Дата</th>
                  <th>От кого</th>
                  <th>Тема</th>
                  <th className={tableStyles.numeric}>Размер</th>
                </tr>
              </thead>
              <tbody>
                {(messages.data?.items ?? []).map((item) => (
                  <tr
                    key={item.uid}
                    className={item.uid === openUid ? tableStyles.selected : undefined}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setOpenUid(item.uid)}
                  >
                    <td className={tableStyles.nowrap}>{formatDateTime(item.date)}</td>
                    <td className="mt-mono">{item.from}</td>
                    <td>{item.subject}</td>
                    <td className={tableStyles.numeric}>{formatBytes(item.size, '0 Б')}</td>
                  </tr>
                ))}
                {(messages.data?.items ?? []).length === 0 && !messages.isLoading && (
                  <EmptyRow colSpan={4}>В этой папке писем нет</EmptyRow>
                )}
              </tbody>
            </Table>
          </TableWrap>

          {openUid !== null && message.data && (
            <div style={{ marginTop: 12 }}>
              <Panel title={message.data.message.subject}>
                <p style={{ margin: '0 0 8px', color: 'var(--mt-color-text-secondary)' }}>
                  От {message.data.message.from} → {message.data.message.to},{' '}
                  {formatDateTime(message.data.message.date)}
                </p>
                <pre
                  className="mt-mono"
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    margin: 0,
                    maxHeight: 400,
                    overflow: 'auto',
                  }}
                >
                  {message.data.message.text}
                </pre>
              </Panel>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
