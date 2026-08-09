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
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import { api } from '../api/client';
import type { CheckState, CheckSummary, HealthCheck } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { Table, TableWrap, tableStyles } from '../components/Table';
import { Badge, ErrorNotice, Field, Notice, Panel, Toolbar, ToolbarSpacer } from '../components/ui';
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
  return [...checks]
    .filter((check) => check.state !== 'ok')
    .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
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
      {/*
        Ширины колонок заданы явно. Каждая группа проверок — своя таблица,
        и без этого ширина первой колонки считалась по её собственному
        самому длинному названию: плашки «в порядке» вставали на разной
        горизонтали в «Службах», «Очереди», «Месте» и «Сертификатах» —
        глазу приходилось искать их заново в каждой группе.
      */}
      <Table>
        <colgroup>
          <col className={styles.colTitle} />
          <col className={styles.colState} />
          <col />
        </colgroup>
        <tbody>
          {checks.map((check) => (
            <tr key={check.id}>
              <td>{check.title}</td>
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

  /*
   * Сквозная проверка доставки — единственное на этом экране, что
   * запускается вручную. Она отправляет НАСТОЯЩЕЕ письмо, а раздел
   * открывают вкладками и держат часами: фоновый запуск завалил бы ящик
   * письмами собственного мониторинга.
   *
   * И запустить её может только тот, кому доверено перезапускать службы
   * (см. requireAdmin в routes/monitoring.ts): настоящее письмо через
   * живой Postfix — это действие, меняющее состояние сервера.
   *
   * Сам же раздел открыт по overview.read, и поле с кнопкой показывались
   * всем. Дежурный вводил адрес, нажимал, ждал до сорока пяти секунд —
   * и получал отказ по правам. Кнопка, которая не работает у половины
   * тех, кто её видит, хуже её отсутствия: она обещает.
   */
  const { can } = useSession();
  const canRoundtrip = can('services.restart');
  const [roundtripMailbox, setRoundtripMailbox] = useState('');
  const roundtrip = useMutation({
    mutationFn: (mailbox: string) => api.monitoringRoundtrip(mailbox),
  });

  const refreshing = health.isFetching || expiry.isFetching || failures.isFetching;
  const refresh = (): void => {
    void health.refetch();
    void expiry.refetch();
    void failures.refetch();
  };

  const allChecks: HealthCheck[] = [...(health.data?.checks ?? []), ...(expiry.data?.checks ?? [])];
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
          {health.data ? `Проверено ${formatRelative(health.data.takenAt)}` : 'Проверяем службы…'}
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

      <Panel title="Сквозная проверка доставки">
        <p className={styles.note}>
          Отправляет письмо в указанный ящик тем же путём, которым это делают почтовые программы, и
          ищет его через IMAP — глазами получателя. Остальные проверки этого раздела отвечают про
          части (порт отвечает, служба поднята); вместе они НЕ означают, что письмо дойдёт: между
          «Postfix принял» и «письмо в ящике» стоят доставка Dovecot, квота, личные правила
          фильтрации и подпись DKIM. Письмо удаляется сразу после проверки. Пароль владельца ящика
          не нужен.
        </p>
        {canRoundtrip ? (
          <>
            <Field
              label="Ящик для проверки"
              hint="Существующий ящик на этом сервере, например admin@example.org"
            >
              <input
                className="mt-input"
                type="email"
                value={roundtripMailbox}
                placeholder="admin@example.org"
                onChange={(e) => {
                  setRoundtripMailbox(e.target.value);
                }}
              />
            </Field>
            <Toolbar>
              <Button
                onClick={() => {
                  roundtrip.mutate(roundtripMailbox.trim());
                }}
                disabled={roundtrip.isPending || roundtripMailbox.trim() === ''}
              >
                {roundtrip.isPending ? 'Проверяем — до 45 секунд…' : 'Отправить проверочное письмо'}
              </Button>
            </Toolbar>
          </>
        ) : (
          /* Не пустое место, а объяснение: чего не хватает и что делать.
             Отказ после сорока пяти секунд ожидания — худший вариант. */
          <Notice tone="info">
            Запустить проверку может только владелец: она отправляет настоящее письмо через живой
            Postfix, и право на это то же, что на перезапуск служб. Попросите владельца запустить её
            и показать результат — всё остальное в этом разделе вам видно и так.
          </Notice>
        )}
        {roundtrip.error && <ErrorNotice error={roundtrip.error} />}
        {roundtrip.data && (
          <>
            <Notice tone={roundtrip.data.ok ? 'success' : 'error'}>
              {roundtrip.data.ok
                ? `Письмо прошло весь путь до ящика ${roundtrip.data.mailbox}` +
                  (roundtrip.data.seconds === null ? '' : ` за ${String(roundtrip.data.seconds)} с`)
                : 'Письмо не прошло весь путь — смотрите, на каком шаге оборвалось'}
            </Notice>
            <ul className={styles.shellOnly}>
              {roundtrip.data.steps.map((step) => (
                <li key={step.id}>
                  <span className={styles.shellOnlyTitle}>
                    <Badge tone={STATE_TONE[step.state]}>{STATE_LABEL[step.state]}</Badge>{' '}
                    {step.title}
                  </span>
                  <span className={styles.hint}>{step.detail}</span>
                  {step.hint !== undefined && <span className={styles.hint}>{step.hint}</span>}
                </li>
              ))}
            </ul>
          </>
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
