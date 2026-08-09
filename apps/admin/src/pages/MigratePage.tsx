/**
 * Перенос почты с чужого сервера (Kerio Connect, Exchange, Zimbra, Dovecot).
 *
 * Раздел отвечает на четыре вопроса, и порядок на экране — их порядок:
 *   1. «Достучимся ли мы вообще?» — проверка связи ДО начала;
 *   2. «Что именно поедет?» — разбор списка ящиков с предпросмотром;
 *   3. «Оно движется?» — числа и текущая папка, а не крутящийся кружок;
 *   4. «Что не доехало и как это повторить?» — отчёт по каждому ящику.
 *
 * ------------------------------------------------------------------
 * ПАРОЛИ И БРАУЗЕР
 *
 * Пароли вводятся здесь и уходят на сервер — обратно они не приходят
 * никогда. Список ящиков отправляется ТЕКСТОМ, а разбирает его сервер:
 * выгрузка Kerio содержит пароли всех сотрудников открытым текстом, и
 * разбор в браузере означал бы держать их в памяти вкладки и слать
 * обратно на каждый шаг. Предпросмотр показывает адреса и признак
 * «пароль в строке есть» — самих паролей в ответе нет.
 *
 * Пароли ящиков-ПРИЁМНИКОВ не спрашиваются вовсе: панель кладёт письма
 * служебным доступом Dovecot, которым она и так открывает чужие ящики.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, TextAreaField, TextField } from '@web/components';
import { cx } from '@web/lib/cx';
import { api } from '../api/client';
import type { MigrationCheck, MigrationListPreview } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap } from '../components/Table';
import {
  Badge,
  ErrorNotice,
  Notice,
  Panel,
  Tile,
  Tiles,
  Toolbar,
  ToolbarSpacer,
} from '../components/ui';
import { can } from '../lib/access';
import { formatDateTime } from '../lib/format';
import {
  ITEM_STATE_LABELS,
  ITEM_STATE_TONES,
  JOB_STATE_LABELS,
  JOB_STATE_TONES,
  currentActivity,
  isJobLive,
  jobProgress,
  readinessProblems,
  retryableItems,
} from '../lib/migration';
import styles from './MigratePage.module.css';

/**
 * Как часто перечитывать идущее задание.
 *
 * Три секунды — не «чтобы плавно», а потому что перенос идёт часами
 * и человек смотрит на экран урывками: за три секунды числа успевают
 * заметно измениться, и экран не выглядит замершим. Завершённое задание
 * не опрашивается вовсе (см. refetchInterval ниже).
 */
const POLL_MS = 3000;

/**
 * Сколько заданий переноса показывает список.
 *
 * Раньше число стояло прямо в запросе, и обрезка была молчаливой: на
 * двадцать первом задании список выглядел полным, а старые переносы
 * просто исчезали — при том что искать в них приходится именно старое
 * («когда мы переезжали с того сервера»). Теперь предел назван и виден
 * человеку, а кнопка показывает больше.
 */
const JOBS_PAGE = 20;

export function MigratePage() {
  const { session } = useSession();
  const mayRun = can(session?.permissions, 'migration.run');
  const client = useQueryClient();

  /* --- настройки исходного сервера --- */
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [secure, setSecure] = useState(true);
  const [allowInsecureTls, setAllowInsecureTls] = useState(true);
  /**
   * Служебный доступ включён по умолчанию: это правильный путь, и человек
   * должен увидеть его первым, а не найти в конце формы. Один пароль на
   * весь перенос вместо пароля каждого владельца.
   */
  const [useMaster, setUseMaster] = useState(true);
  const [masterUser, setMasterUser] = useState('');
  const [masterSeparator, setMasterSeparator] = useState('*');
  const [masterPassword, setMasterPassword] = useState('');

  /* --- проверка связи --- */
  const [probeUser, setProbeUser] = useState('');
  const [probePassword, setProbePassword] = useState('');
  const [probe, setProbe] = useState<MigrationCheck | null>(null);

  /* --- список ящиков --- */
  const [listText, setListText] = useState('');
  const [sourceDomain, setSourceDomain] = useState('');
  const [destDomain, setDestDomain] = useState('');
  const [preview, setPreview] = useState<MigrationListPreview | null>(null);

  const [openJob, setOpenJob] = useState<number | null>(null);

  /*
   * Разбор списка и проверка связи относятся к ТЕМ значениям формы, при
   * которых их получили. Поменяли форму — прежний ответ больше не про
   * неё, и показывать его нельзя.
   *
   * ------------------------------------------------------------------
   * ЧТО БЫЛО
   * ------------------------------------------------------------------
   * Оба ответа переживали любую правку. На экране висело зелёное «Связь
   * есть» — про ДРУГОЙ сервер, и таблица «Откуда → Куда» — про другой
   * домен, а «Начать перенос» уезжал с текущими значениями. Человек
   * читал подтверждение, которого никто не давал.
   *
   * В соседнем импорте ровно это сделано наоборот и намеренно: правка
   * файла гасит предпросмотр.
   */
  useEffect(() => {
    setProbe(null);
  }, [host, port, secure, allowInsecureTls, useMaster, masterUser, masterSeparator]);

  useEffect(() => {
    setPreview(null);
  }, [listText, sourceDomain, destDomain]);

  const settings = useQuery({
    queryKey: ['migrate-settings'],
    queryFn: () => api.migrateSettings(),
  });
  /** Сколько заданий просим сейчас: растёт по кнопке «Показать ещё». */
  const [jobsLimit, setJobsLimit] = useState(JOBS_PAGE);

  const jobs = useQuery({
    queryKey: ['migrate-jobs', jobsLimit],
    queryFn: () => api.migrateJobs(jobsLimit),
    // Пока хоть одно задание идёт, список сам обновляется: иначе человек
    // видит «в очереди» и не понимает, взялся ли кто-нибудь за работу.
    refetchInterval: (query) => ((query.state.data?.jobs ?? []).some(isJobLive) ? POLL_MS : false),
  });

  const details = useQuery({
    queryKey: ['migrate-job', openJob],
    queryFn: () => api.migrateJob(openJob ?? 0),
    enabled: openJob !== null,
    refetchInterval: (query) =>
      query.state.data && isJobLive(query.state.data.job) ? POLL_MS : false,
  });

  // Открытое задание закончилось — список заданий должен это показать сразу,
  // а не через минуту: иначе «Идёт» в списке спорит с «Завершено» ниже.
  const openState = details.data?.job.state;
  useEffect(() => {
    if (openState !== undefined && openState !== 'running' && openState !== 'queued') {
      void client.invalidateQueries({ queryKey: ['migrate-jobs'] });
    }
  }, [openState, client]);

  const sourceBody = useMemo(
    () => ({
      host: host.trim(),
      port: Number.parseInt(port, 10) || 993,
      secure,
      allowInsecureTls,
      ...(useMaster && masterUser.trim() !== ''
        ? { masterUser: masterUser.trim(), masterSeparator }
        : {}),
    }),
    [host, port, secure, allowInsecureTls, useMaster, masterUser, masterSeparator],
  );

  const listBody = useMemo(
    () => ({
      text: listText,
      ...(sourceDomain.trim() !== '' ? { sourceDomain: sourceDomain.trim() } : {}),
      ...(destDomain.trim() !== '' ? { destDomain: destDomain.trim() } : {}),
    }),
    [listText, sourceDomain, destDomain],
  );

  const doCheck = useMutation({
    mutationFn: () =>
      api.migrateCheck({
        ...sourceBody,
        user: probeUser.trim(),
        // В служебном режиме проверяется служебный пароль: он и будет
        // использован при переносе, проверять что-то другое бессмысленно.
        password: useMaster ? masterPassword : probePassword,
      }),
    onSuccess: (data) => setProbe(data),
  });

  const doParse = useMutation({
    mutationFn: () => api.migrateParse(listBody),
    onSuccess: (data) => setPreview(data),
  });

  const doStart = useMutation({
    mutationFn: () =>
      api.migrateStart({
        source: sourceBody,
        list: listBody,
        ...(useMaster && masterPassword !== '' ? { masterPassword } : {}),
      }),
    onSuccess: (data) => {
      setOpenJob(data.jobId);
      // Пароль больше не нужен ни для чего: он уже уехал на сервер
      // зашифрованным. Держать его в памяти вкладки — лишний риск.
      setMasterPassword('');
      setProbePassword('');
      void client.invalidateQueries({ queryKey: ['migrate-jobs'] });
    },
  });

  const doStop = useMutation({
    mutationFn: (id: number) => api.migrateStop(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['migrate-jobs'] });
      void client.invalidateQueries({ queryKey: ['migrate-job'] });
    },
  });

  const doRetry = useMutation({
    mutationFn: (id: number) =>
      api.migrateRetry(id, {
        /*
         * Служебный пароль отправляется, только если режим включён —
         * ровно как при запуске.
         *
         * Здесь проверки `useMaster` не было, и повтор слал пароль в
         * режиме, где его быть не должно. Сервер отвечал отказом про
         * поле, которого на экране уже нет: флажок снят, поле спрятано,
         * очистить его нечем — только включить режим обратно, стереть
         * пароль и выключить снова.
         */
        ...(useMaster && masterPassword !== '' ? { masterPassword } : {}),
        ...(listText.trim() !== '' ? { list: listBody } : {}),
      }),
    onSuccess: (data) => {
      setOpenJob(data.jobId);
      setMasterPassword('');
      void client.invalidateQueries({ queryKey: ['migrate-jobs'] });
    },
  });

  const problems = settings.data ? readinessProblems(settings.data) : [];
  const items = details.data?.items ?? [];
  const job = details.data?.job ?? null;
  const activity = job && isJobLive(job) ? currentActivity(items) : null;
  const bad = retryableItems(items);

  return (
    <>
      <PageTitle
        title="Перенос почты"
        subtitle="Переезд ящиков с другого почтового сервера по IMAP: Kerio Connect, Exchange, Zimbra, Dovecot"
      />

      {problems.length > 0 && (
        <Notice tone="error">
          <strong>Перенос пока недоступен.</strong>
          <ul>
            {problems.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </Notice>
      )}

      {mayRun && (
        <Panel title="Новый перенос">
          <div className={styles.grid}>
            <TextField
              label="Адрес исходного сервера"
              placeholder="kerio.staraya-firma.ru"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
            <TextField
              label="Порт IMAP"
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          <Toolbar>
            <Checkbox
              checked={secure}
              onChange={(e) => setSecure(e.target.checked)}
              label="Сразу TLS (обычно порт 993)"
            />
            <Checkbox
              checked={allowInsecureTls}
              onChange={(e) => setAllowInsecureTls(e.target.checked)}
              label="Принимать собственный сертификат сервера"
            />
          </Toolbar>

          <h3>Чем входим в чужие ящики</h3>
          <Toolbar>
            <Checkbox
              checked={useMaster}
              onChange={(e) => setUseMaster(e.target.checked)}
              label="Служебный доступ (один пароль на весь перенос)"
            />
          </Toolbar>
          <p className={styles.why}>
            {useMaster
              ? 'Служебный пользователь исходного сервера открывает чужие ящики без их паролей. ' +
                'Это лучший путь: один секрет вместо сотни, и ни один пароль сотрудника не ' +
                'приходится ни узнавать, ни менять. У Kerio Connect это «Login as user», ' +
                'у Dovecot и Zimbra — master user.'
              : 'Без служебного доступа нужен пароль каждого ящика. Принесите их списком — ' +
                'например, выгрузкой пользователей Kerio Connect (в ней пароли лежат открытым ' +
                'текстом). Они уйдут на сервер зашифрованными и будут стёрты, как только ' +
                'задание закончится.'}
          </p>

          {useMaster && (
            <div className={styles.grid}>
              <TextField
                label="Служебный пользователь"
                placeholder="admin"
                value={masterUser}
                onChange={(e) => setMasterUser(e.target.value)}
              />
              <TextField
                label="Разделитель"
                hint="Между ящиком и служебным именем: ящик*служебный"
                value={masterSeparator}
                onChange={(e) => setMasterSeparator(e.target.value)}
              />
              <TextField
                label="Пароль служебного пользователя"
                type="password"
                autoComplete="new-password"
                value={masterPassword}
                onChange={(e) => setMasterPassword(e.target.value)}
              />
            </div>
          )}

          <h3>Проверка связи</h3>
          <p className={styles.why}>
            Секунда сейчас против потерянной ночи потом: перенос запускают на ночь, и опечатка в
            адресе или неверный пароль иначе обнаружатся утром, когда задание встало на первом же
            ящике.
          </p>
          <div className={styles.grid}>
            <TextField
              label="Ящик для проверки"
              placeholder="ivan@staraya-firma.ru"
              value={probeUser}
              onChange={(e) => setProbeUser(e.target.value)}
            />
            {!useMaster && (
              <TextField
                label="Пароль этого ящика"
                type="password"
                autoComplete="new-password"
                value={probePassword}
                onChange={(e) => setProbePassword(e.target.value)}
              />
            )}
          </div>
          <Toolbar>
            <Button
              mode="secondary"
              disabled={host.trim() === '' || probeUser.trim() === '' || doCheck.isPending}
              onClick={() => doCheck.mutate()}
            >
              {doCheck.isPending ? 'Проверяем…' : 'Проверить связь'}
            </Button>
          </Toolbar>
          <ErrorNotice error={doCheck.error} />
          {probe && (
            <Notice tone={probe.ok ? 'success' : 'error'}>
              {probe.ok ? (
                <>
                  Связь есть. Вход выполнен как{' '}
                  <span className={styles.mono}>{probe.loginName}</span>; папок —{' '}
                  {probe.folders ?? 0}, писем — {probe.messages ?? 0}.
                </>
              ) : (
                <>
                  Связи нет. Вход пробовали как{' '}
                  <span className={styles.mono}>{probe.loginName}</span>. {probe.error}
                </>
              )}
            </Notice>
          )}

          <h3>Какие ящики переносим</h3>
          <TextAreaField
            label="Список"
            wrapperClassName={styles.wide}
            rows={8}
            placeholder={
              'ivan@staraya-firma.ru\npetr@staraya-firma.ru\n\n' +
              'или пары: ivan@staraya-firma.ru -> i.petrov@novaya.ru\n' +
              'или CSV с колонками source_user,dest_user\n' +
              'или выгрузка пользователей Kerio Connect как есть'
            }
            value={listText}
            onChange={(e) => setListText(e.target.value)}
          />
          <div className={styles.grid}>
            <TextField
              label="Домен исходного сервера"
              hint="Подставится к логинам без «@»"
              placeholder="staraya-firma.ru"
              value={sourceDomain}
              onChange={(e) => setSourceDomain(e.target.value)}
            />
            <TextField
              label="Наш домен"
              hint="Куда переезжают ящики, если адрес не задан явно"
              placeholder="novaya.ru"
              value={destDomain}
              onChange={(e) => setDestDomain(e.target.value)}
            />
          </div>
          <Toolbar>
            <Button
              mode="secondary"
              disabled={listText.trim() === '' || doParse.isPending}
              onClick={() => doParse.mutate()}
            >
              Разобрать список
            </Button>
            <ToolbarSpacer />
            <Button
              disabled={
                problems.length > 0 ||
                host.trim() === '' ||
                listText.trim() === '' ||
                doStart.isPending
              }
              onClick={() => doStart.mutate()}
            >
              {doStart.isPending ? 'Запускаем…' : 'Начать перенос'}
            </Button>
          </Toolbar>
          <ErrorNotice error={doParse.error} />
          <ErrorNotice error={doStart.error} />

          {preview && (
            <>
              <Tiles>
                <Tile value={preview.total} label="ящиков в списке" />
                <Tile value={preview.withPassword} label="строк с паролем" />
                <Tile value={preview.problems.length} label="замечаний" />
              </Tiles>
              {preview.problems.length > 0 && (
                <Notice tone="info">
                  <ul>
                    {preview.problems.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                </Notice>
              )}
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <th>Откуда</th>
                      <th>Куда</th>
                      <th>Пароль в списке</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 200).map((row) => (
                      <tr key={`${row.sourceUser}->${row.destUser}`}>
                        <td className={styles.mono}>{row.sourceUser}</td>
                        <td className={styles.mono}>{row.destUser}</td>
                        <td>{row.hasPassword ? 'есть' : '—'}</td>
                      </tr>
                    ))}
                    {preview.rows.length === 0 && <EmptyRow colSpan={3}>Ни одного ящика</EmptyRow>}
                  </tbody>
                </Table>
              </TableWrap>
            </>
          )}
        </Panel>
      )}

      <Panel title="Задания переноса">
        <ErrorNotice error={jobs.error} />
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>№</th>
                <th>Откуда</th>
                <th>Состояние</th>
                <th>Ящиков</th>
                <th>Писем перенесено</th>
                <th>Пропущено</th>
                <th>Ошибок</th>
                <th>Начато</th>
              </tr>
            </thead>
            <tbody>
              {(jobs.data?.jobs ?? []).map((row) => (
                <tr
                  key={row.id}
                  className={cx(styles.jobRow, row.id === openJob && styles.jobRow_active)}
                  onClick={() => setOpenJob(row.id)}
                >
                  <td>{row.id}</td>
                  <td className={styles.mono}>
                    {row.sourceHost}
                    {row.masterUser ? ` (служебный: ${row.masterUser})` : ''}
                  </td>
                  <td>
                    <Badge tone={JOB_STATE_TONES[row.state]}>{JOB_STATE_LABELS[row.state]}</Badge>
                  </td>
                  <td>
                    {row.done} / {row.total}
                  </td>
                  <td>{row.copied}</td>
                  <td>{row.skipped}</td>
                  <td>{row.failed}</td>
                  <td>{formatDateTime(row.startedAt ?? row.createdAt)}</td>
                </tr>
              ))}
              {(jobs.data?.jobs ?? []).length === 0 && (
                <EmptyRow colSpan={8}>Переносов ещё не было</EmptyRow>
              )}
            </tbody>
          </Table>
        </TableWrap>
        {/*
          Признак обрезки. Список ровно в предел — верный признак того,
          что за ним что-то есть: молчаливая обрезка читается как «это
          всё», и старые переносы человек считает пропавшими.
        */}
        {(jobs.data?.jobs ?? []).length >= jobsLimit && (
          <div style={{ marginTop: 8 }}>
            <Button mode="secondary" size="s" onClick={() => setJobsLimit((n) => n + JOBS_PAGE)}>
              Показано последних {jobsLimit} — показать ещё
            </Button>
          </div>
        )}
      </Panel>

      {job && (
        <Panel title={`Задание №${String(job.id)}: ${job.sourceHost}`}>
          <Tiles>
            <Tile value={`${String(job.done)} / ${String(job.total)}`} label="ящиков готово" />
            <Tile value={job.copied} label="писем перенесено" />
            <Tile value={job.skipped} label="пропущено как дубли" />
            <Tile value={job.failed} label="ошибок" />
          </Tiles>

          <div
            className={styles.bar}
            role="progressbar"
            aria-valuenow={Math.round(jobProgress(job, items) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className={cx(
                styles.barFill,
                job.state === 'stopped' && styles.barFill_stopped,
                job.state === 'failed' && styles.barFill_failed,
              )}
              style={{ width: `${String(Math.round(jobProgress(job, items) * 100))}%` }}
            />
          </div>
          {/* Строка движения. Без неё часовой перенос одного большого ящика
              неотличим от зависшего задания. У идущего задания она в одну
              строку (меняется несколько раз в секунду), у завершённого —
              с переносами: там лежит объяснение, и обрезать его нельзя. */}
          <div className={isJobLive(job) ? styles.activity : styles.finalNote}>
            {activity ??
              (isJobLive(job)
                ? job.live
                  ? 'Ожидание: работник взял задание'
                  : 'Задание ждёт работника (после перезапуска сервера это занимает до минуты)'
                : (job.error ?? 'Задание завершено'))}
          </div>

          <Toolbar>
            {mayRun && isJobLive(job) && (
              <Button
                mode="secondary"
                disabled={job.stopRequested || doStop.isPending}
                onClick={() => doStop.mutate(job.id)}
              >
                {job.stopRequested ? 'Останавливается…' : 'Остановить'}
              </Button>
            )}
            {mayRun && !isJobLive(job) && bad.length > 0 && (
              <Button
                mode="secondary"
                disabled={doRetry.isPending}
                onClick={() => doRetry.mutate(job.id)}
              >
                Повторить неудавшиеся ({bad.length})
              </Button>
            )}
            <ToolbarSpacer />
            <span className={styles.activity}>
              {job.finishedAt ? `Завершено ${formatDateTime(job.finishedAt)}` : ''}
            </span>
          </Toolbar>
          {mayRun && !isJobLive(job) && bad.length > 0 && (
            <p className={styles.why}>
              Пароль нужно ввести заново — он стёрт вместе с завершённым заданием и не хранится «на
              случай повтора». Повтор безопасен: уже перенесённые письма пропускаются, они не поедут
              дважды.
              {!useMaster && ' Для повтора с паролями ящиков оставьте список выше на месте.'}
            </p>
          )}
          <ErrorNotice error={doStop.error} />
          <ErrorNotice error={doRetry.error} />

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Откуда</th>
                  <th>Куда</th>
                  <th>Состояние</th>
                  <th>Перенесено</th>
                  <th>Дубли</th>
                  <th>Ошибок</th>
                  <th>Что происходит</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.position}>
                    <td className={styles.mono}>{item.sourceUser}</td>
                    <td className={styles.mono}>{item.destUser}</td>
                    <td>
                      <Badge tone={ITEM_STATE_TONES[item.state]}>
                        {ITEM_STATE_LABELS[item.state]}
                      </Badge>
                    </td>
                    <td>
                      {item.copied}
                      {item.total > 0 ? ` / ${String(item.total)}` : ''}
                    </td>
                    <td>{item.skipped}</td>
                    <td>{item.failed}</td>
                    <td>
                      {item.state === 'running' && item.currentFolder
                        ? `папка «${item.currentFolder}»`
                        : ''}
                      {item.errors.length > 0 && (
                        <ul className={styles.errors}>
                          {item.errors.slice(0, 5).map((text, index) => (
                            <li key={`${String(item.position)}-${String(index)}`}>{text}</li>
                          ))}
                          {item.errors.length > 5 && <li>…и ещё {item.errors.length - 5}</li>}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && <EmptyRow colSpan={7}>Ящиков в задании нет</EmptyRow>}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      )}
    </>
  );
}
