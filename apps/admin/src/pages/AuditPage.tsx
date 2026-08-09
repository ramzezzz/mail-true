/**
 * Журнал аудита и журнал входов администраторов в чужие ящики.
 * Только чтение — удалять записи нельзя никому, в API такого действия нет.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { PageTitle } from '../app/AdminLayout';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { ErrorNotice, Notice, Pager, Toolbar, ToolbarSpacer } from '../components/ui';
import { formatDateTime } from '../lib/format';

const LIMIT = 50;

const TARGET_TYPES = [
  { value: '', label: 'Все объекты' },
  { value: 'user', label: 'Ящики' },
  { value: 'alias', label: 'Алиасы' },
  { value: 'domain', label: 'Домены' },
  { value: 'admin', label: 'Администраторы' },
  { value: 'mailbox', label: 'Входы в ящики' },
];

export function AuditPage() {
  const [tab, setTab] = useState<'audit' | 'access'>('audit');
  const [search, setSearch] = useState('');
  const [targetType, setTargetType] = useState('');
  const [offset, setOffset] = useState(0);

  const audit = useQuery({
    queryKey: ['audit', search, targetType, offset],
    queryFn: () =>
      api.audit({
        search: search.trim() || undefined,
        targetType: targetType || undefined,
        limit: LIMIT,
        offset,
      }),
    enabled: tab === 'audit',
  });

  const access = useQuery({
    queryKey: ['mailbox-access', search, offset],
    queryFn: () => api.mailboxAccess({ mailbox: search.trim() || undefined, limit: LIMIT, offset }),
    enabled: tab === 'access',
  });

  return (
    <>
      <PageTitle
        title="Журнал аудита"
        subtitle="Кто, когда и что изменил. Записи не удаляются и не правятся."
      />

      <Toolbar>
        <select
          className="mt-select"
          style={{ width: 240 }}
          value={tab}
          onChange={(e) => {
            setTab(e.target.value as 'audit' | 'access');
            setOffset(0);
          }}
        >
          <option value="audit">Все действия</option>
          <option value="access">Входы администраторов в ящики</option>
        </select>
        <input
          className="mt-input"
          style={{ width: 280 }}
          placeholder={tab === 'audit' ? 'Поиск по объекту' : 'Адрес ящика'}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        {tab === 'audit' && (
          <select
            className="mt-select"
            style={{ width: 190 }}
            value={targetType}
            onChange={(e) => {
              setTargetType(e.target.value);
              setOffset(0);
            }}
          >
            {TARGET_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        )}
        <ToolbarSpacer />
      </Toolbar>

      <ErrorNotice error={audit.error ?? access.error} />

      {tab === 'audit' ? (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th className={tableStyles.nowrap}>Когда</th>
                  <th>Кто</th>
                  <th>Действие</th>
                  <th>Объект</th>
                  <th>Было</th>
                  <th>Стало</th>
                  <th>Адрес</th>
                </tr>
              </thead>
              <tbody>
                {(audit.data?.items ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td className={tableStyles.nowrap}>{formatDateTime(entry.createdAt)}</td>
                    <td>{entry.adminLogin}</td>
                    <td>{entry.actionLabel}</td>
                    <td className="mt-mono">{entry.targetLabel ?? '—'}</td>
                    {/* Полный текст — в подсказке: в колонку он не влезает,
                        а иногда это единственная копия того, что исчезло
                        (список алиасов, унесённых удалением домена). */}
                    <td className="mt-mono" title={fullValue(entry.oldValue)}>
                      {summarize(entry.oldValue)}
                    </td>
                    <td className="mt-mono" title={fullValue(entry.newValue)}>
                      {summarize(entry.newValue)}
                    </td>
                    <td className="mt-mono">{entry.ip ?? '—'}</td>
                  </tr>
                ))}
                {(audit.data?.items ?? []).length === 0 && !audit.isLoading && (
                  <EmptyRow colSpan={7}>Записей нет</EmptyRow>
                )}
              </tbody>
            </Table>
          </TableWrap>
          <Pager
            total={audit.data?.total ?? 0}
            limit={LIMIT}
            offset={offset}
            onChange={setOffset}
          />
        </>
      ) : (
        <>
          <Notice tone="info">
            Каждый вход администратора в чужой ящик требует причины и попадает сюда. Владелец ящика
            тоже видит эти входы в своей истории действий.
          </Notice>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th className={tableStyles.nowrap}>Начало</th>
                  <th className={tableStyles.nowrap}>Конец</th>
                  <th>Администратор</th>
                  <th>Ящик</th>
                  <th>Причина</th>
                  <th>Адрес</th>
                </tr>
              </thead>
              <tbody>
                {(access.data?.items ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td className={tableStyles.nowrap}>{formatDateTime(entry.startedAt)}</td>
                    <td className={tableStyles.nowrap}>
                      {entry.endedAt ? formatDateTime(entry.endedAt) : 'сеанс открыт'}
                    </td>
                    <td>{entry.adminLogin}</td>
                    <td className="mt-mono">{entry.mailboxEmail}</td>
                    <td>{entry.reason}</td>
                    <td className="mt-mono">{entry.ip ?? '—'}</td>
                  </tr>
                ))}
                {(access.data?.items ?? []).length === 0 && !access.isLoading && (
                  <EmptyRow colSpan={6}>Входов не было</EmptyRow>
                )}
              </tbody>
            </Table>
          </TableWrap>
          <Pager
            total={access.data?.total ?? 0}
            limit={LIMIT}
            offset={offset}
            onChange={setOffset}
          />
        </>
      )}
    </>
  );
}

/**
 * Значение поля записи — словами, а не «[object Object]».
 *
 * `String()` от массива объектов даёт `[object Object],[object Object]`, и
 * это не теория: удаление домена с `force=true` кладёт в запись полный
 * список уничтоженных алиасов (`aliases_removed`) — единственную копию
 * того, что исчезло. Отказ маршрута и окно подтверждения обещают
 * администратору, что список останется в журнале; в журнале же на его
 * месте была нечитаемая строка, ещё и обрезанная.
 */
function describeValue(item: unknown): string {
  if (item === null || item === undefined) return '—';
  if (Array.isArray(item)) return item.map((entry) => describeValue(entry)).join('; ');
  if (typeof item === 'object') {
    // Алиас `{source, destination, active}` — самый частый случай: его и
    // читают, когда разбираются, что унесло каскадом.
    const row = item as Record<string, unknown>;
    if (typeof row.source === 'string' && typeof row.destination === 'string') {
      return `${row.source} → ${row.destination}${row.active === false ? ' (выключен)' : ''}`;
    }
    return Object.entries(row)
      .map(([key, value]) => `${key}=${describeValue(value)}`)
      .join(', ');
  }
  /*
   * Здесь остались только простые значения: объекты и массивы разобраны
   * выше. Тип сужаем явно — иначе String() однажды снова получит объект,
   * и в журнале снова появится «[object Object]».
   */
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'bigint') {
    return String(item);
  }
  return JSON.stringify(item) ?? '—';
}

/** Значение целиком — для подсказки над ячейкой. */
function fullValue(value: Record<string, unknown> | null): string {
  if (!value) return '';
  return Object.entries(value)
    .map(([key, item]) => `${key}=${describeValue(item)}`)
    .join('\n');
}

/** Короткое представление старого/нового значения для колонки таблицы. */
function summarize(value: Record<string, unknown> | null): string {
  if (!value) return '—';
  const parts = Object.entries(value).map(([key, item]) => `${key}=${describeValue(item)}`);
  const text = parts.join(', ');
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}
