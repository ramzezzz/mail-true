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
 */
import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type { TlsBundleInputDto, TlsCheckResult, TlsIssue } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { ErrorNotice, Field, Notice, Panel } from '../components/ui';

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

export function TlsPage() {
  const { can } = useSession();
  const mayWrite = can('serversettings.write');

  const [certificate, setCertificate] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [chain, setChain] = useState('');
  const [checked, setChecked] = useState<TlsCheckResult | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const overview = useQuery({ queryKey: ['tls'], queryFn: () => api.tls() });

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
