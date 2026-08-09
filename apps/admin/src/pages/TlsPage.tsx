/**
 * Раздел «Сертификат»: что стоит сейчас и как поставить свой.
 *
 * Экран устроен в два шага и иначе устроен быть не может:
 *
 *   1) «Проверить» — разбор принесённых файлов, при котором на сервере не
 *      меняется ничего. Показываются все находки разом: подходит ли ключ,
 *      полна ли цепочка, покрыты ли имена, каков срок;
 *   2) «Применить» — то же самое с явным подтверждением.
 *
 * Одношаговая замена означала бы «нажал и узнал». Неподходящая пара ключа
 * и сертификата останавливает TLS на всех трёх службах сразу — то есть
 * почту целиком, — и узнавать об этом после применения слишком поздно.
 *
 * Правила проверки живут не здесь и не на сервере, а в общем пакете
 * (packages/shared/src/tls-certificate.ts): те же самые применяет мастер
 * первого запуска (apps/installer). Эта страница только показывает вывод.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ АВТОПРОДЛЕНИЕ ПОКАЗЫВАЕТСЯ ЗДЕСЬ, И ВТОРЫМ БЛОКОМ
 * ------------------------------------------------------------------
 * «Что стоит и до какого числа» и «продлится ли оно само» — это один
 * вопрос, заданный дважды. Человек, открывший раздел, чтобы посмотреть
 * срок, обязан тут же увидеть, отодвинется ли этот срок сам; иначе он
 * уходит с экрана, ответив только на половину.
 *
 * Выше формы «Поставить свой сертификат» — потому что за эту форму
 * берутся тогда, когда автопродление уже подвело. Показать её раньше
 * причины значило бы предложить лечение до диагноза.
 *
 * Тревога при этом живёт НЕ здесь, а в «Наблюдении»: этот раздел
 * открывают нарочно, а туда смотрят каждый день. Здесь — подробности и
 * история, там — красная строка.
 */
import { useCallback, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox } from '@web/components';
import { api } from '../api/client';
import type {
  CheckState,
  RenewalAttempt,
  TlsBundleInputDto,
  TlsCheckResult,
  TlsIssue,
  TlsOverview,
  TlsRenewal,
} from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { Badge, ErrorNotice, Field, Notice, Panel } from '../components/ui';
import { formatDateTime } from '../lib/format';
// Копирование в буфер — общее с разделом «Домены и DNS». Там же объяснено,
// почему у него есть запасной путь: админку до выпуска сертификата
// открывают по http, а navigator.clipboard там просто отсутствует.
import { copyText } from './DnsDialog';

const MUTED = { color: 'var(--mt-admin-muted)' } as const;
const MONO = {
  fontFamily: 'var(--mt-font-mono, ui-monospace, monospace)',
  fontSize: '12px',
} as const;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

const LEVEL_TONE: Readonly<Record<TlsIssue['level'], 'info' | 'error' | 'success'>> = {
  ok: 'success',
  warn: 'info',
  fail: 'error',
};

function Issues({ issues }: { issues: TlsIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {issues.map((issue) => (
        <Notice key={issue.id} tone={LEVEL_TONE[issue.level]}>
          <strong>{issue.title}</strong>
          <div style={{ whiteSpace: 'pre-wrap' }}>{issue.detail}</div>
          {issue.hint ? (
            <div style={{ ...MUTED, whiteSpace: 'pre-wrap', marginTop: 6 }}>{issue.hint}</div>
          ) : null}
        </Notice>
      ))}
    </div>
  );
}

function Facts({ result }: { result: TlsCheckResult }) {
  const cert = result.certificate;
  if (!cert) return null;
  const rows: Array<[string, string]> = [
    ['Кому выдан', cert.commonName || cert.subject],
    ['Кем выдан', cert.issuer],
    [
      'Действует до',
      `${formatDate(cert.validTo)}${
        cert.daysLeft >= 0 ? ` — это ещё ${cert.daysLeft} дн.` : ' — срок истёк'
      }`,
    ],
    ['Покрывает имена', cert.names.join(', ') || '—'],
    ['Отпечаток SHA-256', cert.fingerprint256],
  ];
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 12 }}>
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name}>
            <td style={{ ...MUTED, padding: '6px 12px 6px 0', verticalAlign: 'top', width: 200 }}>
              {name}
            </td>
            <td style={name.startsWith('Отпечаток') ? MONO : undefined}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/* Автопродление                                                        */
/* ------------------------------------------------------------------ */

const STATE_TONE: Readonly<Record<CheckState, 'ok' | 'warn' | 'fail' | 'muted'>> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  unknown: 'muted',
};

const STATE_LABEL: Readonly<Record<CheckState, string>> = {
  ok: 'работает',
  warn: 'внимание',
  fail: 'не работает',
  unknown: 'неизвестно',
};

/** Плашка «отказ» на весь блок, «предупреждение» — обычной заметкой. */
const NOTICE_TONE: Readonly<Record<CheckState, 'info' | 'error' | 'success'>> = {
  ok: 'success',
  warn: 'info',
  fail: 'error',
  unknown: 'info',
};

const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  renewed: 'продлён',
  'not-due': 'срок не подошёл',
  deployed: 'разложен по стеку',
  issued: 'выпущен',
  failed: 'отказ',
  'skipped-custom': 'пропущено: свой сертификат',
};

const TRIGGER_LABEL: Readonly<Record<string, string>> = {
  timer: 'по таймеру',
  manual: 'вручную',
  install: 'при установке',
};

/** Итог попытки. Незнакомое значение показывается как есть — см. типы. */
export function attemptOutcome(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome;
}

export function attemptTrigger(trigger: string): string {
  return TRIGGER_LABEL[trigger] ?? trigger;
}

/** Отказ красный, пропуск по своему сертификату — серый, остальное зелёное. */
export function attemptTone(outcome: string): 'ok' | 'warn' | 'fail' | 'muted' {
  if (outcome === 'failed') return 'fail';
  if (outcome === 'skipped-custom') return 'muted';
  return 'ok';
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void copyText(command).then((ok) => {
      setCopied(ok);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
      <code style={{ ...MONO, flex: 1, wordBreak: 'break-all' }}>{command}</code>
      <Button mode="secondary" size="s" onClick={onCopy}>
        {copied ? 'Скопировано' : 'Копировать'}
      </Button>
    </div>
  );
}

function Attempts({ attempts }: { attempts: RenewalAttempt[] }) {
  if (attempts.length === 0) return null;
  return (
    <>
      <h3 style={{ fontSize: 14, margin: '16px 0 6px' }}>Последние попытки</h3>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {attempts.map((attempt) => (
            <tr key={`${attempt.at}-${attempt.outcome}`}>
              <td style={{ ...MUTED, padding: '6px 12px 6px 0', verticalAlign: 'top' }}>
                {formatDateTime(attempt.at)}
              </td>
              <td style={{ ...MUTED, padding: '6px 12px 6px 0', verticalAlign: 'top' }}>
                {attemptTrigger(attempt.trigger)}
              </td>
              <td style={{ padding: '6px 12px 6px 0', verticalAlign: 'top' }}>
                <Badge tone={attemptTone(attempt.outcome)}>{attemptOutcome(attempt.outcome)}</Badge>
              </td>
              <td style={{ padding: '6px 0', verticalAlign: 'top' }}>{attempt.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Блок «Автопродление».
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЗДЕСЬ НЕТ КНОПКИ «ПРОДЛИТЬ СЕЙЧАС»
 * ------------------------------------------------------------------
 * Не потому, что до неё не дошли руки. Её нельзя сделать честно:
 *
 *   * certbot в режиме standalone занимает 80-й порт САМОЙ МАШИНЫ и на
 *     время проверки требует остановить nginx. Изнутри контейнера этого
 *     не сделать: порт принадлежит хосту;
 *   * сам скрипт (install/renew-certs.sh) лежит на хосте, в каталоге
 *     установки, который в контейнер панели не смонтирован и монтироваться
 *     не должен — там же infra/.env со всеми паролями;
 *   * посредник infra/service-agent умеет ровно две вещи (restart и
 *     recreate) и только над закрытым списком служб. Выполнения
 *     произвольной команды в нём нет и не появится: у него сокет Docker,
 *     то есть права root на всей машине, и вся его безопасность держится
 *     ровно на том, что список действий закрыт. Добавить туда «запусти
 *     скрипт» значит отдать машину целиком тому, кто найдёт дыру в панели.
 *
 * Кнопка, которая молча ничего не делает, хуже её отсутствия: после неё
 * человек уходит уверенным, что продление запущено. Поэтому вместо
 * кнопки — команда, которую можно скопировать и выполнить на сервере.
 */
/**
 * ВЫПУСК LET'S ENCRYPT ИЗ ПАНЕЛИ.
 *
 * Заказчик: «нет возможности заменить самоподписанный сертификат на
 * lets encrypt в интерфейсе». Так и было: раздел показывал срок,
 * предупреждал об истечении и принимал СВОЙ сертификат — а выпустить
 * бесплатный, ради которого всё и затевалось, отправлял на сервер.
 *
 * Здесь спрашивается ровно то, чего не знает сервер: адрес для писем об
 * истечении. Имена берутся из настроек сервера — сертификат обязан
 * покрывать то, чем сервер представляется, а не то, что попросили в
 * форме.
 */
function LetsEncryptPanel({
  current,
  onIssued,
}: {
  current: TlsOverview;
  onIssued: (message: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [staging, setStaging] = useState(false);
  const [includeOptional, setIncludeOptional] = useState(true);
  const [output, setOutput] = useState('');
  /** Согласие затереть свой сертификат — спрашивается отдельным окном. */
  const [confirmReplace, setConfirmReplace] = useState(false);
  /*
   * Право на запись проверяется и здесь. Кнопка была живой у любой роли,
   * а отказ прилетал уже от сервера — при том что на этой же странице
   * написано, что менять сертификат может только владелец.
   */
  const { can } = useSession();
  const mayWrite = can('serversettings.write');

  /*
   * Сейчас стоит СВОЙ сертификат от удостоверяющего центра.
   *
   * Выпуск Let's Encrypt разложит поверх него новый ключ, и приватный ключ
   * купленного сертификата пропадёт безвозвратно — вернуть можно только из
   * внешней копии. Консольный путь это давно закрывает (renew-certs.sh
   * требует MT_REPLACE_CUSTOM_CERT=1), а панель шла мимо: кнопка стояла
   * рядом, без подтверждения и без проверки права на запись.
   */
  const overwritesCustom = current.source === 'custom' && !staging;

  const issue = useMutation({
    mutationFn: () =>
      api.issueLetsEncrypt({
        email: email.trim(),
        staging,
        includeOptional,
        ...(overwritesCustom ? { replaceCustom: true } : {}),
      }),
    onSuccess: (result) => {
      setOutput(result.output);
      onIssued(result.message);
    },
  });

  const names = includeOptional
    ? [...current.expectedNames, ...current.optionalNames]
    : current.expectedNames;

  return (
    <Panel title="Выпустить Let's Encrypt">
      <p style={MUTED}>
        Бесплатный сертификат на 90 суток с автопродлением. Выпускается на этом же сервере:
        Let&rsquo;s Encrypt проверяет домен обращением на 80-й порт, поэтому имена{' '}
        {names.join(', ')} должны уже указывать сюда, а порт 80 быть доступен снаружи. Веб-вход при
        этом продолжает работать: подтверждение отдаёт наш же nginx, гасить его не нужно.
      </p>

      <ErrorNotice error={issue.error} />

      <div style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
        <Field
          label="Адрес для уведомлений"
          hint="Сюда Let's Encrypt напишет, если сертификат вот-вот истечёт, а продление не удалось."
        >
          <input
            className="mt-input"
            placeholder="admin@example.ru"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Checkbox
          label="Включить autoconfig и autodiscover"
          checked={includeOptional}
          onChange={(event) => setIncludeOptional(event.target.checked)}
        />
        <p style={{ ...MUTED, margin: '-6px 0 0 26px', fontSize: 12 }}>
          Без этих имён почтовые программы не находят автонастройку. Но если их записи ещё не
          созданы, выпуск сорвётся целиком — тогда снимите флажок и получите сертификат на главное.
        </p>

        <Checkbox
          label="Пробный выпуск (испытательный центр)"
          checked={staging}
          onChange={(event) => setStaging(event.target.checked)}
        />
        <p style={{ ...MUTED, margin: '-6px 0 0 26px', fontSize: 12 }}>
          Проверяет, что домен подтверждается и порт доступен, не тратя попытки настоящего
          Let&rsquo;s Encrypt (их пять в час на домен). Такой сертификат никуда не устанавливается.
        </p>

        {overwritesCustom ? (
          <Notice tone="error">
            Сейчас установлен свой сертификат от удостоверяющего центра ({current.sourceLabel}).
            Выпуск заменит его вместе с приватным ключом — вернуть прежний можно будет только из
            своей копии.
          </Notice>
        ) : null}

        {overwritesCustom ? (
          <Checkbox
            label="Да, заменить свой сертификат на Let’s Encrypt"
            checked={confirmReplace}
            onChange={(event) => setConfirmReplace(event.target.checked)}
          />
        ) : null}

        <div>
          <Button
            disabled={
              issue.isPending ||
              email.trim() === '' ||
              !mayWrite ||
              (overwritesCustom && !confirmReplace)
            }
            title={mayWrite ? undefined : 'Менять сертификат может только владелец сервера'}
            onClick={() => {
              setOutput('');
              issue.mutate();
            }}
          >
            {issue.isPending
              ? 'Выпускаем… это до минуты'
              : staging
                ? 'Проверить пробным выпуском'
                : 'Выпустить и установить'}
          </Button>
        </div>
      </div>

      {output !== '' ? (
        <pre
          style={{
            marginTop: 12,
            padding: 10,
            overflowX: 'auto',
            fontSize: 12,
            background: 'var(--mt-color-background-secondary)',
            borderRadius: 8,
          }}
        >
          {output}
        </pre>
      ) : null}
    </Panel>
  );
}

function RenewalPanel({ renewal }: { renewal: TlsRenewal }) {
  const { verdict, report } = renewal;
  const timer = report?.timer ?? null;
  const rows: Array<[string, string]> = [];
  if (timer) {
    rows.push([
      'Автопродление',
      timer.kind === 'none'
        ? 'не настроено'
        : `${timer.kind === 'cron' ? 'cron' : `таймер systemd (${timer.unit})`}, ` +
          (timer.enabled ? 'включено' : 'ВЫКЛЮЧЕНО'),
    ]);
    rows.push([
      'Следующая попытка',
      timer.nextRunAt === '' ? 'неизвестна' : formatDateTime(timer.nextRunAt),
    ]);
  }
  const last = report?.attempts[0] ?? null;
  if (last) {
    rows.push([
      'Последняя попытка',
      `${formatDateTime(last.at)}, ${attemptTrigger(last.trigger)} — ${attemptOutcome(last.outcome)}`,
    ]);
    if (last.validTo !== '') {
      rows.push(['Сертификат после неё действует до', formatDate(last.validTo)]);
    }
  }
  if (report) {
    rows.push(['Отчёт обновлён', formatDateTime(report.updatedAt)]);
  }

  return (
    <Panel title="Автопродление">
      <p style={{ marginBottom: 10 }}>
        <Badge tone={STATE_TONE[verdict.state]}>{STATE_LABEL[verdict.state]}</Badge>
      </p>
      <Notice tone={NOTICE_TONE[verdict.state]}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{verdict.detail}</div>
        {verdict.hint ? (
          <div style={{ ...MUTED, whiteSpace: 'pre-wrap', marginTop: 6 }}>{verdict.hint}</div>
        ) : null}
      </Notice>

      {rows.length > 0 ? (
        <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12 }}>
          <tbody>
            {rows.map(([name, value]) => (
              <tr key={name}>
                <td
                  style={{ ...MUTED, padding: '6px 12px 6px 0', verticalAlign: 'top', width: 260 }}
                >
                  {name}
                </td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <Attempts attempts={report?.attempts ?? []} />

      <h3 style={{ fontSize: 14, margin: '16px 0 6px' }}>Продлить сейчас</h3>
      <p style={MUTED}>
        Кнопки здесь нет намеренно. Продление выпускает сертификат через certbot, а тот занимает
        80-й порт самой машины и на время проверки останавливает nginx; и порт, и скрипт принадлежат
        серверу, а не панели — панель работает в контейнере без доступа к машине. Кнопка, которая
        молча ничего не делает, хуже её отсутствия. Выполните на сервере:
      </p>
      <CommandLine command={renewal.commands.renew} />
      <p style={{ ...MUTED, marginTop: 10 }}>
        Если продление отказывает — с принудительным перевыпуском:
      </p>
      <CommandLine command={renewal.commands.force} />
      <p style={{ ...MUTED, marginTop: 10 }}>
        Если автопродление вообще не включено (так бывает после установки из браузера: systemd живёт
        на хосте, а установщик — в контейнере):
      </p>
      <CommandLine command={renewal.commands.installTimer} />
    </Panel>
  );
}

export function TlsPage() {
  const { can } = useSession();
  const mayWrite = can('serversettings.write');

  const [certificate, setCertificate] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [chain, setChain] = useState('');
  const [checked, setChecked] = useState<TlsCheckResult | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['tls'], queryFn: () => api.tls() });

  /* После выпуска перечитываем раздел: срок и источник сертификата другие. */
  const onIssued = (message: string): void => {
    setFlash(message);
    void queryClient.invalidateQueries({ queryKey: ['tls'] });
  };

  function bundle(): TlsBundleInputDto {
    return chain.trim() === '' ? { certificate, privateKey } : { certificate, privateKey, chain };
  }

  const check = useMutation({
    mutationFn: () => api.checkTls(bundle()),
    onSuccess: (result) => setChecked(result),
  });

  const apply = useMutation({
    mutationFn: () => api.applyTls(bundle()),
    onSuccess: (result) => {
      setFlash(
        'Сертификат заменён. nginx, Postfix и Dovecot перечитают его в течение ' +
          `${result.reloadSeconds} секунд.`,
      );
      // Ключ не остаётся в памяти вкладки дольше, чем нужно.
      setCertificate('');
      setPrivateKey('');
      setChain('');
      setChecked(null);
      void overview.refetch();
    },
  });

  /** Любая правка отменяет прошлую проверку: она была уже про другие файлы. */
  function edit(setter: (value: string) => void) {
    return (event: ChangeEvent<HTMLTextAreaElement>) => {
      setter(event.target.value);
      setChecked(null);
      setFlash(null);
    };
  }

  function pickFile(setter: (value: string) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        setter(text);
        setChecked(null);
        setFlash(null);
      });
    };
  }

  const current = overview.data;
  const busy = check.isPending || apply.isPending;
  const canApply = mayWrite && checked !== null && checked.ok && !busy;

  return (
    <>
      <PageTitle
        title="Сертификат"
        subtitle="TLS для почты в браузере, панели управления и почтовых программ"
      />

      {flash ? <Notice tone="success">{flash}</Notice> : null}
      <ErrorNotice error={overview.error ?? check.error ?? apply.error} />

      <Panel title="Что стоит сейчас">
        {overview.isPending ? <p style={MUTED}>Читаем…</p> : null}
        {current ? (
          <>
            <p style={MUTED}>Источник: {current.sourceLabel}.</p>
            {current.unreadable ? (
              <Notice tone="error">Сертификат сервера не читается: {current.unreadable}</Notice>
            ) : null}
            {current.current ? (
              <>
                <Facts result={current.current} />
                <Issues issues={current.current.issues} />
              </>
            ) : null}
            <p style={{ ...MUTED, marginTop: 12 }}>
              Сертификат обязан покрывать: {current.expectedNames.join(', ')}. Желательно также{' '}
              {current.optionalNames.join(', ')} — без них не у всех клиентов заработает
              автонастройка и вход по короткому имени домена.
            </p>
          </>
        ) : null}
      </Panel>

      {current ? <RenewalPanel renewal={current.renewal} /> : null}

      {current ? <LetsEncryptPanel current={current} onIssued={onIssued} /> : null}

      <Panel title="Поставить свой сертификат">
        <p style={MUTED}>
          Файлы в формате PEM — текст, начинающийся с «-----BEGIN». Если удостоверяющий центр
          прислал .pfx или .p12, его сначала нужно перевести в PEM: проверка скажет, какой командой.
          Приватный ключ не должен быть защищён паролем — службы читают его при запуске, и спросить
          пароль не у кого.
        </p>

        <Field label="Сертификат сервера">
          <input type="file" accept=".pem,.crt,.cer,.txt" onChange={pickFile(setCertificate)} />
          <textarea
            className="mt-input"
            rows={5}
            spellCheck={false}
            style={MONO}
            value={certificate}
            onChange={edit(setCertificate)}
            placeholder="-----BEGIN CERTIFICATE-----"
          />
        </Field>

        <Field
          label="Промежуточные сертификаты (цепочка)"
          hint={
            'Файл вроде chain.pem, intermediate.crt или bundle.crt. Без него браузер покажет ' +
            'зелёный замок (промежуточные у него свои), а Outlook, почта Android и чужие ' +
            'почтовые серверы скажут «недоверенный узел» — это самая частая ошибка при ' +
            'ручной установке сертификата. Если цепочка уже внутри файла выше, поле можно ' +
            'оставить пустым.'
          }
        >
          <input type="file" accept=".pem,.crt,.cer,.txt" onChange={pickFile(setChain)} />
          <textarea
            className="mt-input"
            rows={4}
            spellCheck={false}
            style={MONO}
            value={chain}
            onChange={edit(setChain)}
            placeholder="-----BEGIN CERTIFICATE-----"
          />
        </Field>

        <Field
          label="Приватный ключ"
          hint={
            'Ключ никуда не отдаётся обратно: его нет ни в ответах сервера, ни в журнале ' +
            'аудита, ни в резервной копии настроек. После применения поле очищается.'
          }
        >
          <input type="file" accept=".pem,.key,.txt" onChange={pickFile(setPrivateKey)} />
          <textarea
            className="mt-input"
            rows={4}
            spellCheck={false}
            style={MONO}
            value={privateKey}
            onChange={edit(setPrivateKey)}
            placeholder="-----BEGIN PRIVATE KEY-----"
          />
        </Field>

        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <Button
            mode="secondary"
            disabled={busy || certificate.trim() === '' || privateKey.trim() === ''}
            onClick={() => check.mutate()}
          >
            {check.isPending ? 'Проверяем…' : 'Проверить'}
          </Button>
          <Button disabled={!canApply} onClick={() => apply.mutate()}>
            {apply.isPending ? 'Применяем…' : 'Применить'}
          </Button>
        </div>
        {!mayWrite ? (
          <p style={{ ...MUTED, marginTop: 8 }}>
            Менять сертификат может только владелец: это действие над всем сервером сразу.
          </p>
        ) : null}
      </Panel>

      {checked ? (
        <Panel title="Разбор">
          <Facts result={checked} />
          <Issues issues={checked.issues} />
          {checked.ok ? (
            <Notice tone="info">
              Применение перезапишет сертификат сервера. nginx, Postfix и Dovecot перечитают файл в
              течение десяти секунд: приём почты при этом не останавливается, но почтовые сеансы,
              начатые ровно в момент перезагрузки Postfix, могут получить отказ — отправитель
              повторит их сам.
              <br />
              После замены автопродление Let’s Encrypt на этом сервере откажется работать, чтобы не
              перезаписать ваш сертификат молча.
            </Notice>
          ) : (
            <Notice tone="error">
              Применить нельзя: сначала нужно исправить то, что отмечено как отказ.
            </Notice>
          )}
        </Panel>
      ) : null}
    </>
  );
}
