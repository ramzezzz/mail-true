/**
 * Сводка состояния: один экран, по которому видно, всё ли в порядке,
 * а если нет — что именно чинить.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { PageTitle, CenteredSpinner } from '../app/AdminLayout';
import { Table, TableWrap, tableStyles } from '../components/Table';
import { Badge, DnsBadge, ErrorNotice, Notice, Panel, Tile, Tiles } from '../components/ui';
import { formatBytes, formatRelative, pluralize } from '../lib/format';

export function OverviewPage() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.overview(),
    refetchInterval: 30_000,
  });

  if (isLoading) return <CenteredSpinner />;
  if (error) return <ErrorNotice error={error} />;
  if (!data) return null;

  return (
    <>
      <PageTitle
        title="Сводка"
        subtitle="Состояние сервисов, объёмы и последние действия администраторов"
      />

      {data.healthy ? (
        <Notice tone="success">Всё в порядке: сервисы отвечают, замечаний нет.</Notice>
      ) : (
        <Notice tone="error">
          <strong>Требует внимания:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}

      <Tiles>
        <Tile value={data.counters.users} label={pluralize(data.counters.users, 'ящик', 'ящика', 'ящиков')} />
        <Tile value={data.counters.usersActive} label="активных" />
        <Tile value={data.counters.usersBlocked} label="заблокированных" />
        <Tile value={data.counters.domains} label={pluralize(data.counters.domains, 'домен', 'домена', 'доменов')} />
        <Tile value={data.counters.aliases} label="алиасов" />
        <Tile value={data.counters.admins} label="администраторов" />
        <Tile value={formatBytes(data.counters.quotaTotal)} label="выделено квот" />
        <Tile value={data.counters.auditToday} label="действий за сутки" />
        <Tile value={data.counters.impersonations7d} label="входов в ящики за неделю" />
      </Tiles>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        <Panel title="Сервисы">
          <TableWrap>
            <Table>
              <tbody>
                {data.services.map((s) => (
                  <tr key={s.id}>
                    <td className={tableStyles.nowrap}>{s.title}</td>
                    <td className={tableStyles.nowrap}>
                      <Badge tone={s.state === 'ok' ? 'ok' : s.state === 'fail' ? 'fail' : 'muted'}>
                        {s.state === 'ok' ? 'работает' : s.state === 'fail' ? 'не отвечает' : 'не настроено'}
                      </Badge>
                    </td>
                    <td>{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>

        <Panel title="Домены">
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Домен</th>
                  <th className={tableStyles.numeric}>Ящиков</th>
                  <th>DNS</th>
                  <th>Проверен</th>
                </tr>
              </thead>
              <tbody>
                {data.domains.map((d) => (
                  <tr key={d.id}>
                    <td className="mt-mono">{d.name}</td>
                    <td className={tableStyles.numeric}>{d.userCount}</td>
                    <td><DnsBadge status={d.dnsOverall} /></td>
                    <td className={tableStyles.nowrap}>{formatRelative(d.dnsCheckedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      </div>

      <div style={{ marginTop: 12 }}>
        <Panel title="Последние действия">
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Действие</th>
                  <th>Объект</th>
                </tr>
              </thead>
              <tbody>
                {data.recentAudit.map((entry) => (
                  <tr key={entry.id}>
                    <td className={tableStyles.nowrap}>{formatRelative(entry.createdAt)}</td>
                    <td>{entry.adminLogin}</td>
                    <td>{entry.actionLabel}</td>
                    <td className="mt-mono">{entry.targetLabel ?? '—'}</td>
                  </tr>
                ))}
                {data.recentAudit.length === 0 && (
                  <tr>
                    <td colSpan={4} className={tableStyles.empty}>
                      Действий пока не было
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      </div>
    </>
  );
}
