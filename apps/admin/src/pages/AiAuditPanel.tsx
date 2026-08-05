/**
 * Журнал обращений к помощнику ИИ.
 *
 * Это главный способ проверить на словах администратора, а не на честном
 * слове: сколько раз обращались, какие ответы взяты из кэша (и потому
 * наружу не уходили), сколько символов действительно ушло и покидали ли
 * данные периметр. Текстов писем здесь нет — только длина отправленного.
 *
 * Только чтение; сервер требует право audit.read, страница показывает
 * панель лишь тем, у кого оно есть, — исключительно ради удобства.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AiFeatureInfo } from '../api/types';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { Badge, ErrorNotice, Panel, Tile, Tiles, Toolbar, ToolbarSpacer } from '../components/ui';
import {
  AI_AUDIT_RANGES,
  errorLabel,
  formatCount,
  formatDuration,
  rangeSince,
  technicalTitle,
  type AiAuditRange,
} from '../lib/ai';
import { formatDateTime } from '../lib/format';
import styles from './AiPage.module.css';

const LIMITS = [50, 100, 200, 500];

export function AiAuditPanel({ features }: { features: AiFeatureInfo[] }) {
  const [accountId, setAccountId] = useState('');
  const [feature, setFeature] = useState('');
  const [range, setRange] = useState<AiAuditRange>('day');
  const [limit, setLimit] = useState(100);

  const journal = useQuery({
    queryKey: ['ai-audit', accountId, feature, range, limit],
    // Границу времени считаем в момент запроса: «за сутки» — это сутки
    // назад от сейчас, а не от того мгновения, когда открыли страницу.
    queryFn: () =>
      api.aiAudit({
        accountId: accountId.trim() || undefined,
        feature: feature || undefined,
        since: rangeSince(range),
        limit,
      }),
  });

  const items = journal.data?.items ?? [];
  const totals = journal.data?.totals;

  return (
    <div className={styles.panelGap}>
      <Panel title="Журнал обращений">
        <Toolbar>
          <input
            className="mt-input"
            style={{ width: 260 }}
            placeholder="Ящик, например ivan@example.ru"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          />
          <select
            className="mt-select"
            style={{ width: 240 }}
            value={feature}
            onChange={(event) => setFeature(event.target.value)}
          >
            <option value="">Все возможности</option>
            {features.map((info) => (
              <optgroup key={info.key} label={info.title}>
                {info.technical.map((technical) => (
                  <option key={technical} value={technical}>
                    {technical}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <select
            className="mt-select"
            style={{ width: 160 }}
            value={range}
            onChange={(event) => setRange(event.target.value as AiAuditRange)}
          >
            {AI_AUDIT_RANGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            className="mt-select"
            style={{ width: 140 }}
            value={String(limit)}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            {LIMITS.map((value) => (
              <option key={value} value={value}>
                до {value} записей
              </option>
            ))}
          </select>
          <ToolbarSpacer />
        </Toolbar>

        <ErrorNotice error={journal.error} />

        {totals && (
          <Tiles>
            <Tile value={formatCount(totals.requests)} label="обращений" />
            <Tile value={formatCount(totals.cachedRequests)} label="из кэша, наружу не уходило" />
            <Tile value={formatCount(totals.failedRequests)} label="завершились ошибкой" />
            <Tile value={formatCount(totals.outboundChars)} label="символов ушло наружу" />
            <Tile value={formatCount(totals.totalTokens)} label="токенов всего" />
            <Tile value={formatCount(totals.promptTokens)} label="токенов в запросах" />
            <Tile value={formatCount(totals.completionTokens)} label="токенов в ответах" />
          </Tiles>
        )}

        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th className={tableStyles.nowrap}>Когда</th>
                <th>Ящик</th>
                <th>Возможность</th>
                <th>Письмо</th>
                <th>Модель</th>
                <th>Адрес</th>
                <th>Внутри периметра</th>
                <th>Уходило наружу</th>
                <th className={tableStyles.numeric}>Символов</th>
                <th className={tableStyles.numeric}>Токенов</th>
                <th className={tableStyles.nowrap}>Заняло</th>
                <th>Итог</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={`${entry.at}:${entry.accountId}:${entry.feature}:${entry.messageId ?? ''}`}>
                  <td className={tableStyles.nowrap}>{formatDateTime(entry.at)}</td>
                  <td className="mt-mono">{entry.accountId}</td>
                  <td title={entry.feature}>{technicalTitle(features, entry.feature)}</td>
                  <td className="mt-mono">{entry.messageId ?? '—'}</td>
                  <td className="mt-mono">{entry.model}</td>
                  <td className="mt-mono" style={{ wordBreak: 'break-all' }}>{entry.endpoint}</td>
                  <td>
                    <Badge tone={entry.local ? 'ok' : 'warn'}>
                      {entry.local ? 'да' : 'нет, наружу'}
                    </Badge>
                  </td>
                  <td>
                    {entry.cached ? (
                      <Badge tone="ok">нет, из кэша</Badge>
                    ) : (
                      <Badge tone="muted">да, был вызов</Badge>
                    )}
                  </td>
                  <td className={tableStyles.numeric}>{formatCount(entry.outboundChars)}</td>
                  <td className={tableStyles.numeric}>
                    {formatCount(entry.usage.totalTokens)}
                    {entry.usage.estimated ? ' ≈' : ''}
                  </td>
                  <td className={tableStyles.nowrap}>{formatDuration(entry.durationMs)}</td>
                  <td>
                    {entry.ok ? (
                      <Badge tone="ok">успех</Badge>
                    ) : (
                      <Badge tone="fail">{errorLabel(entry.errorKind)}</Badge>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && !journal.isLoading && (
                <EmptyRow colSpan={12}>За выбранный период обращений не было</EmptyRow>
              )}
            </tbody>
          </Table>
        </TableWrap>

        <p className={styles.muted} style={{ marginBottom: 0 }}>
          «≈» у числа токенов означает, что сервис не сообщил расход и он посчитан оценкой.
          Столбец «Внутри периметра» показывает, покидали ли данные сервер: «нет, наружу» —
          покидали.
        </p>
      </Panel>
    </div>
  );
}
