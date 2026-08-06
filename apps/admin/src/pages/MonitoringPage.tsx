/**
 * Наблюдение: что сломано прямо сейчас и что вот-вот сломается.
 *
 * ------------------------------------------------------------------
 * ЧЕМ ЭТОТ ЭКРАН ОТЛИЧАЕТСЯ ОТ ДАШБОРДА
 * ------------------------------------------------------------------
 * Дашборд отвечает «сколько»: загрузка, потоки, объёмы. По нему планируют.
 * Здесь отвечают «что не работает». Разница не в оформлении: истекающий
 * сертификат, молчащий резольвер и письмо, лежащее в очереди полсмены, НЕ
 * МЕНЯЮТ ни одного числа на дашборде — до того момента, когда чинить уже
 * поздно. Графиков здесь поэтому нет вовсе: график показывает изменение,
 * а тут нужен ответ «да/нет» и что делать.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПЛОХОЕ ПОДНЯТО НАВЕРХ
 * ------------------------------------------------------------------
 * Проверок больше десятка, и почти всегда все зелёные. Экран, на котором
 * единственная красная строка стоит четырнадцатой, читается как исправный:
 * до неё не долистывают. Поэтому отказы и предупреждения собраны в блок
 * над всем остальным, а полный список идёт следом — уже для проверки
 * «а это точно смотрели».
 *
 * ------------------------------------------------------------------
 * ЧЕСТНОСТЬ ПРО НЕПРОВЕРЕННОЕ
 * ------------------------------------------------------------------
 * Панель живёт в контейнере без сокета Docker и без каталога установки.
 * Часть проверок install/selfcheck.sh отсюда невозможна принципиально, и
 * они названы поимённо внизу экрана. Без этого списка зелёный экран
 * прочитался бы как «проверено всё».
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import { api } from '../api/client';
import type { CheckState, CheckSummary, HealthCheck } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { Table, TableWrap, tableStyles } from '../components/Table';
import { Badge, ErrorNotice, Notice, Panel, Toolbar, ToolbarSpacer } from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/format';
import styles from './MonitoringPage.module.css';

/** Как называется ступень словом. Цвет не единственный признак. */
const STATE_LABEL: Readonly<Record<CheckState, string>> = {
  ok: 'в порядке',
  warn: 'внимание',
  fail: 'не работает',
  unknown: 'неизвестно',
};

const STATE_TONE: Readonly<Record<CheckState, 'ok' | 'warn' | 'fail' | 'muted'>> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  unknown: 'muted',
};

/** Отказы важнее предупреждений, предупреждения — важнее неизвестного. */
const ORDER: Readonly<Record<CheckState, number>> = { fail: 0, warn: 1, unknown: 2, ok: 3 };

export function problemsFirst(checks: readonly HealthCheck[]): HealthCheck[] {
  return [...checks].filter((check) => check.state !== 'ok').sort(
    (a, b) => ORDER[a.state] - ORDER[b.state],
  );
}

/** Проверки по группам, в том порядке, в котором группы впервые встретились. */
export function byGroup(checks: readonly HealthCheck[]): Array<[string, HealthCheck[]]> {
  const groups = new Map<string, HealthCheck[]>();
  for (const check of checks) {
    const list = groups.get(check.group);
    if (list) list.push(check);
    else groups.set(check.group, [check]);
  }
  return [...groups.entries()];
}

function StateBadge({ state }: { state: CheckState }) {
  return <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>;
}

/** Строка итога: сколько чего. Читается раньше, чем сам список. */
function SummaryLine({ summary }: { summary: CheckSummary }) {
  const parts: string[] = [];
  if (summary.fail > 0) parts.push(`не работает: ${String(summary.fail)}`);
  if (summary.warn > 0) parts.push(`требует внимания: ${String(summary.warn)}`);
  if (summary.unknown > 0) parts.push(`не проверено: ${String(summary.unknown)}`);
  parts.push(`в порядке: ${String(summary.ok)}`);
  return <span className={styles.summary}>{parts.join(', ')}</span>;
}

function ChecksTable({ checks }: { checks: readonly HealthCheck[] }) {
  return (
    <TableWrap>
      <Table>
        <tbody>
          {checks.map((check) => (
            <tr key={check.id}>
              <td className={tableStyles.nowrap}>{check.title}</td>
              <td className={tableStyles.nowrap}>
                <StateBadge state={check.state} />
              </td>
              <td>
                {check.detail}
                {check.hint && <div className={styles.hint}>{check.hint}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

export function MonitoringPage() {
  const [hours, setHours] = useState(24);

  const health = useQuery({
    queryKey: ['monitoring-health'],
    queryFn: () => api.monitoringHealth(),
  });
  const expiry = useQuery({
    queryKey: ['monitoring-expiry'],
    queryFn: () => api.monitoringExpiry(),
  });
  const failures = useQuery({
    queryKey: ['monitoring-failures', hours],
    queryFn: () => api.monitoringFailures(hours),
  });

  const refreshing = health.isFetching || expiry.isFetching || failures.isFetching;
  const refresh = (): void => {
    void health.refetch();
    void expiry.refetch();
    void failures.refetch();
  };

  const allChecks: HealthCheck[] = [
    ...(health.data?.checks ?? []),
    ...(expiry.data?.checks ?? []),
  ];
  const problems = problemsFirst(allChecks);
  const loaded = health.data !== undefined && expiry.data !== undefined;

  return (
    <>
      <PageTitle
        title="Наблюдение"
        subtitle="Исправность сервера: что сломано сейчас и что сломается на днях"
      />

      <Toolbar>
        <span className={styles.taken}>
          {health.data
            ? `Проверено ${formatRelative(health.data.takenAt)}`
            : 'Проверяем службы…'}
        </span>
        <ToolbarSpacer />
        <Button mode="secondary" size="s" disabled={refreshing} onClick={refresh}>
          {refreshing ? 'Проверяем…' : 'Проверить заново'}
        </Button>
      </Toolbar>

      <ErrorNotice error={health.error ?? expiry.error} />

      {/* Итог одной строкой. Зелёная плашка ставится только когда
          проверено ВСЁ доступное: частичный ответ «всё хорошо» — ложь. */}
      {loaded &&
        (problems.length === 0 ? (
          <Notice tone="success">
            Из того, что видно из панели, всё работает. Проверок: {allChecks.length}. Ниже
            перечислено, чего панель проверить не может.
          </Notice>
        ) : (
          <Panel title="Требует внимания">
            <ChecksTable checks={problems} />
          </Panel>
        ))}

      {/* Полный список по группам: службы, очередь, место, сертификаты, DNS */}
      {health.data && (
        <Panel title="Службы, очередь и место">
          <p className={styles.note}>
            <SummaryLine summary={health.data.summary} />
          </p>
          {byGroup(health.data.checks).map(([group, checks]) => (
            <div key={group} className={styles.group}>
              <h3 className={styles.groupTitle}>{group}</h3>
              <ChecksTable checks={checks} />
            </div>
          ))}
        </Panel>
      )}

      {expiry.data && (
        <Panel title="Сроки: сертификаты и записи DNS">
          <p className={styles.note}>
            <SummaryLine summary={expiry.data.summary} />
          </p>
          {byGroup(expiry.data.checks).map(([group, checks]) => (
            <div key={group} className={styles.group}>
              <h3 className={styles.groupTitle}>{group}</h3>
              <ChecksTable checks={checks} />
            </div>
          ))}
          <p className={styles.note}>{expiry.data.certificateNote}</p>
          <p className={styles.note}>{expiry.data.dnsNote}</p>
        </Panel>
      )}

      {/* Последние отказы: не «что могло сломаться», а что уже не дошло */}
      <Panel title="Что не доставлено">
        <Toolbar>
          <select
            className={`mt-select ${styles.control}`}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            aria-label="За какое время"
          >
            <option value={1}>за час</option>
            <option value={24}>за сутки</option>
            <option value={24 * 7}>за неделю</option>
          </select>
        </Toolbar>
        <ErrorNotice error={failures.error} />
        {failures.data && !failures.data.available && (
          <Notice tone="info">{failures.data.note}</Notice>
        )}
        {failures.data?.available && (
          <>
            <p className={styles.note}>{failures.data.note}</p>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Что</th>
                    <th>Кому</th>
                    <th>Причина</th>
                  </tr>
                </thead>
                <tbody>
                  {failures.data.items.map((item) => (
                    <tr key={item.id}>
                      <td className={tableStyles.nowrap}>{formatDateTime(item.at)}</td>
                      <td className={tableStyles.nowrap}>
                        <Badge tone={item.status === 'rejected' ? 'warn' : 'fail'}>
                          {item.status === 'rejected'
                            ? 'отклонено'
                            : item.status === 'bounced'
                              ? 'возвращено'
                              : 'истёк срок'}
                        </Badge>
                      </td>
                      <td>{item.recipient ?? '—'}</td>
                      <td className={styles.reason}>{item.reason ?? item.dsn ?? '—'}</td>
                    </tr>
                  ))}
                  {failures.data.items.length === 0 && (
                    <tr>
                      <td className={styles.emptyCell} colSpan={4}>
                        Отказов и возвратов за это время не было.
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </TableWrap>
          </>
        )}

        {failures.data && failures.data.rspamdErrors.length > 0 && (
          <div className={styles.group}>
            <h3 className={styles.groupTitle}>Ошибки антиспама</h3>
            {/* Эти ошибки не видны ни в журнале Postfix, ни в истории
                доставки: письмо при них проходит «успешно», просто без
                части проверок. */}
            <TableWrap>
              <Table>
                <tbody>
                  {failures.data.rspamdErrors.map((err) => (
                    <tr key={`${err.at}-${err.message.slice(0, 40)}`}>
                      <td className={tableStyles.nowrap}>{formatDateTime(err.at)}</td>
                      <td className={tableStyles.nowrap}>{err.module}</td>
                      <td className={styles.reason}>{err.message}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </div>
        )}
      </Panel>

      {health.data && (
        <Panel title="Чего этот раздел не проверяет">
          <p className={styles.note}>{health.data.shellOnlyNote}</p>
          <ul className={styles.shellOnly}>
            {health.data.shellOnly.map((item) => (
              <li key={item.title}>
                <span className={cx(styles.shellOnlyTitle)}>{item.title}</span>
                <span className={styles.hint}>{item.why}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
