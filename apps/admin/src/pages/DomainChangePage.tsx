/**
 * Смена основного домена сервера.
 *
 * Экран устроен в два шага, как восстановление копии: сначала ПЛАН,
 * потом выполнение. Разница в том, что план здесь хранится — вместе с
 * ним выпускается ключ DKIM, и человеку нужно время опубликовать запись
 * в DNS прежде, чем нажимать вторую кнопку.
 *
 * Всё, что на этом экране написано мелким шрифтом, написано мелким
 * шрифтом только потому, что оно второстепенно. Главное — три вещи, и
 * они видны без прокрутки:
 *
 *   1. что перестанет работать сразу (почтовые программы у всех людей);
 *   2. где точка невозврата;
 *   3. что часть работы придётся доделать на сервере руками.
 *
 * Соблазн спрятать это под «подробности» велик и вреден: администратор,
 * узнавший про перенастройку клиентов от первого позвонившего, —
 * это администратор, которому продукт соврал умолчанием.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, TextField } from '@web/components';
import { cx } from '@web/lib/cx';
import { api } from '../api/client';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { Badge, ErrorNotice, Notice, Panel, Tile, Tiles } from '../components/ui';
import { formatBytes, formatDateTime, pluralize } from '../lib/format';
import type { DomainChangeJob, DomainChangeStep } from '../api/types';
import styles from './DomainChangePage.module.css';

/** Пока идёт выполнение, экран опрашивается часто: операция минутная. */
const POLL_MS = 2000;

const STEP_TONE: Record<DomainChangeStep['state'], 'ok' | 'warn' | 'fail' | 'muted'> = {
  pending: 'muted',
  running: 'warn',
  ok: 'ok',
  failed: 'fail',
  skipped: 'muted',
};

const STEP_LABEL: Record<DomainChangeStep['state'], string> = {
  pending: 'ждёт',
  running: 'идёт',
  ok: 'готово',
  failed: 'сорвалось',
  skipped: 'не выполнялся',
};

const JOB_LABEL: Record<DomainChangeJob['state'], string> = {
  planned: 'план составлен',
  running: 'выполняется',
  done: 'выполнена',
  failed: 'сорвалась',
  cancelled: 'отменена',
};

function isLive(job: DomainChangeJob | null | undefined): boolean {
  return job?.state === 'running';
}

/** Простой человеческим языком: «около минуты», а не «65 с». */
function downtimeText(seconds: { min: number; max: number }): string {
  const show = (s: number): string =>
    s < 60 ? `${String(s)} с` : `${String(Math.round(s / 60))} мин`;
  return `${show(seconds.min)} — ${show(seconds.max)}`;
}

export function DomainChangePage() {
  const { session } = useSession();
  const client = useQueryClient();
  const allowed = session?.permissions.includes('domainchange.run') ?? false;

  const [newDomain, setNewDomain] = useState('');
  const [confirm, setConfirm] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ['domain-change'],
    queryFn: () => api.domainChange(),
    enabled: allowed,
    refetchInterval: (query) => (isLive(query.state.data?.live) ? POLL_MS : false),
  });

  const live = overview.data?.live ?? null;
  const pendingManual = overview.data?.pendingManual ?? null;
  const plan = live?.plan ?? null;

  // Задание закончилось — подтверждение больше не должно оставаться
  // набранным: следующий план будет про другой домен.
  useEffect(() => {
    if (live === null) setConfirm('');
  }, [live]);

  const makePlan = useMutation({
    mutationFn: (domain: string) => api.domainChangePlan(domain),
    onSuccess: async () => {
      setFlash(null);
      await client.invalidateQueries({ queryKey: ['domain-change'] });
    },
  });

  const cancel = useMutation({
    mutationFn: (id: number) => api.domainChangeCancel(id),
    onSuccess: async (result) => {
      setFlash(
        result.targetDomainRemoved
          ? 'План отменён, заведённый домен убран. Сервер не изменился.'
          : 'План отменён. Сервер не изменился.',
      );
      await client.invalidateQueries({ queryKey: ['domain-change'] });
    },
  });

  const apply = useMutation({
    mutationFn: (input: { id: number; confirm: string }) =>
      api.domainChangeApply(input.id, input.confirm),
    onSuccess: async () => {
      setFlash(null);
      await client.invalidateQueries({ queryKey: ['domain-change'] });
    },
  });

  if (!allowed) {
    return (
      <>
        <PageTitle title="Смена домена" />
        <Notice tone="error">
          Смена основного домена доступна только полному доступу: она меняет адрес каждого человека
          в организации и после переноса писем не отменяется.
        </Notice>
      </>
    );
  }

  if (overview.data && !overview.data.ready) {
    return (
      <>
        <PageTitle title="Смена домена" />
        <Notice tone="error">{overview.data.reason}</Notice>
      </>
    );
  }

  const blocked = (plan?.blockers.length ?? 0) > 0;
  const canApply =
    live?.state === 'planned' && !blocked && confirm.trim().toLowerCase() === live.newDomain;

  return (
    <>
      <PageTitle
        title="Смена домена"
        subtitle={
          overview.data
            ? `Сейчас основной домен — ${overview.data.currentDomain} (сервер ${overview.data.currentHostname})`
            : 'Основной домен сервера и всё, что от него зависит'
        }
      />

      {flash && <Notice tone="success">{flash}</Notice>}
      <ErrorNotice error={makePlan.error ?? apply.error ?? cancel.error ?? overview.error} />

      {/* --- шаг 1: составить план ---------------------------------- */}
      {live === null && (
        <Panel title="Шаг 1. План">
          <p className={styles.hint}>
            План ничего не меняет: он считает, сколько ящиков, писем и настроек переедет, выпускает
            ключ DKIM для нового домена и показывает записи, которые нужно опубликовать <b>до</b>{' '}
            начала. Отказаться можно в любой момент, пока не нажата кнопка выполнения.
          </p>
          <div className={styles.confirmRow}>
            <div className={styles.confirmField}>
              <TextField
                label="Новый основной домен"
                placeholder="example.ru"
                value={newDomain}
                onChange={(event) => {
                  setNewDomain(event.target.value);
                }}
              />
            </div>
            <Button
              size="s"
              disabled={makePlan.isPending || newDomain.trim().length < 3}
              onClick={() => {
                makePlan.mutate(newDomain.trim());
              }}
            >
              {makePlan.isPending ? 'Считаю…' : 'Составить план'}
            </Button>
          </div>
          {overview.data?.canStoreKey === false && (
            <Notice tone="error">
              На сервере не задан ADMIN_SESSION_SECRET/SESSION_SECRET, поэтому выпущенный приватный
              ключ DKIM сохранить негде. План составится, но ключ придётся выпускать на сервере
              руками — иначе письма с нового домена пойдут без подписи.
            </Notice>
          )}
        </Panel>
      )}

      {/*
        Смена домена прошла, а обязательный шаг на сервере — нет.

        Раньше единственное упоминание скрипта жило внутри блока живого
        задания, и весь блок исчезал ровно в тот момент, когда шаг
        становился нужным: домен сменён, история зелёная, а письма с
        нового домена уходят без подписи DKIM.

        Плашка стоит первой и не зависит ни от какого выбора: она
        исчезнет сама, когда скрипт отработает и сервер увидит новый
        MAIL_DOMAIN.
      */}
      {pendingManual && (
        <Notice tone="error">
          <b>Смена домена не закончена.</b> В базе домен уже {pendingManual.newDomain}, а сервер
          работает со старым {pendingManual.currentDomain}. Выполните на сервере:{' '}
          <code>sudo bash infra/scripts/change-domain.sh</code> — он положит ключ DKIM в rspamd,
          перевыпустит сертификаты и перезапустит стек. До этого письма с нового домена уходят{' '}
          <b>без подписи</b>, а панель доступна по прежнему имени. Эта плашка исчезнет сама, когда
          шаг будет сделан.
        </Notice>
      )}

      {/* --- план и его последствия --------------------------------- */}
      {live && plan && (
        <>
          <Panel title={`Смена домена: ${JOB_LABEL[live.state]}`}>
            <p className={styles.arrow}>
              <span className={styles.arrowFrom}>{plan.oldDomain}</span>
              <span aria-hidden>→</span>
              <span className={styles.arrowTo}>{plan.newDomain}</span>
            </p>
            <p className={styles.hint}>
              Имя сервера: {plan.oldHostname} → {plan.newHostname}. План составил {live.adminLogin},{' '}
              {formatDateTime(live.createdAt)}.
            </p>
            <Tiles>
              <Tile value={plan.counts.mailboxes} label="ящиков переедет" />
              <Tile value={plan.counts.aliases} label="алиасов переедет" />
              <Tile value={plan.counts.messages} label="писем переносится" />
              <Tile value={formatBytes(plan.counts.bytes)} label="объём писем" />
              <Tile value={plan.counts.rows} label="строк настроек" />
              <Tile value={downtimeText(plan.downtimeSeconds)} label="примерный простой" />
            </Tiles>
            <p className={styles.hint}>
              Свободно на томе писем {formatBytes(plan.space.freeBytes)} из{' '}
              {formatBytes(plan.space.totalBytes)}; для начала нужно{' '}
              {formatBytes(plan.space.requiredBytes)}.{' '}
              {plan.space.renameOnly
                ? 'Письма переезжают переименованием каталога — место под них не требуется, ' +
                  'перенос занимает доли секунды при любом объёме.'
                : // Копирования писем в продукте НЕТ: сервер намеренно
                  // отказывается начинать переезд, когда каталоги на разных
                  // устройствах (domain-change-files.ts), и это же выводится
                  // отдельным препятствием ниже. Прежний текст обещал
                  // «просто будет дольше» — человек искал, где включить.
                  'Каталоги на разных устройствах — переезд невозможен: письма переносятся ' +
                  'переименованием каталога, а между устройствами так нельзя. Перенесите ' +
                  'каталог писем на тот же том и повторите план.'}
            </p>
          </Panel>

          {plan.blockers.length > 0 && (
            <Panel title="Начинать нельзя">
              <ul className={styles.list}>
                {plan.blockers.map((b) => (
                  <li key={b.id}>
                    <b>{b.message}</b> {b.fix}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {plan.warnings.length > 0 && (
            <Panel title="На что обратить внимание">
              <ul className={styles.list}>
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Опубликуйте эти записи ДО начала">
            <p className={styles.hint}>
              {plan.dnsSummary} Записи расходятся по интернету часами: опубликованная после переезда
              запись DKIM означает, что первые письма с нового адреса уйдут без действующей подписи.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className={styles.records}>
                <thead>
                  <tr>
                    <th>Имя</th>
                    <th>Тип</th>
                    <th>Значение</th>
                    <th>Зачем</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.dnsToPublish.map((r) => (
                    <tr key={`${r.type}:${r.name}`}>
                      <td className={styles.value}>{r.name}</td>
                      <td>
                        {r.type} {r.required && <Badge tone="fail">обязательна</Badge>}
                      </td>
                      <td className={styles.value}>{r.value}</td>
                      <td>{r.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Что перестанет работать сразу">
            <ul className={styles.list}>
              {plan.breaks.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            <Notice tone="info">
              Старый домен <b>{plan.oldDomain}</b> остаётся принимающим: на каждый ящик и на каждый
              алиас заводится запись «прежний адрес → новый», и письма на старые адреса продолжат
              приходить. Отправлять со старого адреса тоже можно — вход при этом выполняется под
              новым. Это не настройка, а обязательное поведение: смена домена без него означала бы
              потерю почты со всех визиток, договоров и чужих адресных книг.
            </Notice>
          </Panel>

          <Panel title="Что придётся сделать на сервере руками">
            <ul className={styles.list}>
              {plan.manual.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Panel>

          <Panel title="Что специально не переписывается">
            <ul className={styles.list}>
              {plan.keeps.map((k) => (
                <li key={k.what}>
                  <b>{k.what}.</b> {k.why}
                </li>
              ))}
            </ul>
            {plan.counts.freeTextHits.length > 0 && (
              <p className={styles.hint}>
                Старый домен встречается в текстах:{' '}
                {plan.counts.freeTextHits.map((h) => `${h.what} — ${String(h.rows)}`).join(', ')}.
                Их стоит просмотреть и поправить самим.
              </p>
            )}
            <details>
              <summary>Где именно переписывается адрес ({plan.counts.tables.length})</summary>
              <table className={styles.history}>
                <thead>
                  <tr>
                    <th>Что</th>
                    <th>Таблица</th>
                    <th>Строк</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.counts.tables.map((t) => (
                    <tr key={`${t.table}.${t.column}`}>
                      <td>{t.what}</td>
                      <td className={styles.value}>
                        {t.table}.{t.column}
                      </td>
                      <td>{t.rows}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Panel>

          <StepsPanel job={live} />

          {/* --- шаг 2: выполнение --------------------------------- */}
          {live.state === 'planned' && (
            <Panel title="Шаг 2. Выполнение">
              <Notice tone="error">
                После шага «Перенос писем и индексов» вернуть всё назад <b>нельзя</b>. Не «сложно» и
                не «долго» — нельзя: за секунды после переключения на новые адреса придёт почта,
                люди войдут под новыми именами, а чужие серверы запомнят новый маршрут. До этого
                шага отказ безопасен и оставляет сервер работающим.
              </Notice>
              <div className={styles.confirmRow}>
                <div className={styles.confirmField}>
                  <TextField
                    label={`Наберите ${live.newDomain} для подтверждения`}
                    value={confirm}
                    onChange={(event) => {
                      setConfirm(event.target.value);
                    }}
                  />
                </div>
                <Button
                  size="s"
                  disabled={!canApply || apply.isPending}
                  onClick={() => {
                    apply.mutate({ id: live.id, confirm: confirm.trim() });
                  }}
                >
                  {apply.isPending ? 'Запускаю…' : 'Сменить домен'}
                </Button>
                <Button
                  size="s"
                  disabled={cancel.isPending}
                  onClick={() => {
                    cancel.mutate(live.id);
                  }}
                >
                  Отказаться
                </Button>
              </div>
              {blocked && (
                <p className={styles.hint}>
                  Кнопка не сработает, пока не устранены препятствия выше.
                </p>
              )}
            </Panel>
          )}
        </>
      )}

      {/* --- завершённые смены -------------------------------------- */}
      {(overview.data?.history.length ?? 0) > 0 && (
        <Panel title="Прежние смены домена">
          <table className={styles.history}>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Что на что</th>
                <th>Состояние</th>
                <th>Перенесено</th>
                <th>Кто</th>
              </tr>
            </thead>
            <tbody>
              {(overview.data?.history ?? [])
                .filter((job) => job.id !== live?.id)
                .map((job) => (
                  <tr key={job.id}>
                    <td>{formatDateTime(job.finishedAt ?? job.createdAt)}</td>
                    <td className={styles.value}>
                      {job.oldDomain} → {job.newDomain}
                    </td>
                    <td>
                      <Badge
                        tone={
                          job.state === 'done' ? 'ok' : job.state === 'failed' ? 'fail' : 'muted'
                        }
                      >
                        {JOB_LABEL[job.state]}
                      </Badge>
                    </td>
                    <td>
                      {job.state === 'done'
                        ? `${pluralize(job.mailboxes, 'ящик', 'ящика', 'ящиков')}, ${formatBytes(job.bytes)}`
                        : (job.error ?? '—')}
                    </td>
                    <td>{job.adminLogin}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}

/**
 * Ход работ. Черта невозврата рисуется прямо между шагами — там, где она
 * и находится, а не отдельным предупреждением в конце страницы: человек
 * должен видеть, какие шаги ещё отменяемы, а какие уже нет.
 */
function StepsPanel({ job }: { job: DomainChangeJob }) {
  if (job.steps.length === 0) return null;
  return (
    <Panel title="Ход работ">
      <ul className={styles.steps}>
        {job.steps.map((step) => (
          <StepRow key={step.id} step={step} passed={job.pointOfNoReturnAt !== null} />
        ))}
      </ul>
      {job.backupPath && (
        <p className={styles.hint}>
          Резервная копия настроек снята до начала: {job.backupPath} ({formatBytes(job.backupBytes)}
          ). Внутри хэши паролей — файл секретный.
        </p>
      )}
      {job.error && <Notice tone="error">{job.error}</Notice>}
      {job.state === 'done' && (
        <Notice tone="success">
          Домен сменён. Осталось выполнить на сервере{' '}
          <code>sudo bash infra/scripts/change-domain.sh</code> — он положит ключ DKIM в rspamd,
          перевыпустит сертификаты и перезапустит стек. До этого письма с нового домена уходят без
          подписи, а панель доступна по прежнему имени.
        </Notice>
      )}
    </Panel>
  );
}

function StepRow({ step, passed }: { step: DomainChangeStep; passed: boolean }) {
  const isFiles = step.id === 'files';
  return (
    <>
      {isFiles && (
        <li className={styles.noReturn} aria-hidden={false}>
          {passed ? 'точка невозврата пройдена' : 'дальше — точка невозврата'}
        </li>
      )}
      <li className={cx(styles.step, styles[`step_${step.state}`])}>
        <div className={styles.stepTitle}>
          <Badge tone={STEP_TONE[step.state]}>{STEP_LABEL[step.state]}</Badge>
          <span>{step.title}</span>
        </div>
        {step.detail && <div className={styles.stepDetail}>{step.detail}</div>}
      </li>
    </>
  );
}
