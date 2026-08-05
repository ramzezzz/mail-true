/**
 * Домены и проверка DNS.
 *
 * Это самое частое место, где спотыкаются при установке почтового сервера,
 * поэтому по каждой записи показывается: зачем она, что должно быть
 * (готовая строка для копирования), что опубликовано на самом деле
 * и что конкретно сделать. Никаких «SPF: FAIL».
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type { DnsCheck, DnsReport, Domain } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import {
  Badge,
  DnsBadge,
  ErrorNotice,
  Field,
  Modal,
  Notice,
  Panel,
  Toolbar,
  ToolbarSpacer,
} from '../components/ui';
import { formatRelative } from '../lib/format';

export function DomainsPage() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [report, setReport] = useState<{ domain: string; data: DnsReport } | null>(null);
  const [dkimFor, setDkimFor] = useState<Domain | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.domains() });

  const check = useMutation({
    mutationFn: (domain: Domain) => api.dnsCheck(domain.id),
    onSuccess: (data) => {
      setReport({ domain: data.domain, data });
      void queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
  });

  const items = domains.data?.items ?? [];

  return (
    <>
      <PageTitle
        title="Домены и DNS"
        subtitle="Что нужно прописать у регистратора, чтобы почта ходила и не попадала в спам"
      />

      {flash && <Notice tone="success">{flash}</Notice>}
      <ErrorNotice error={domains.error ?? check.error} />

      <Toolbar>
        <ToolbarSpacer />
        {can('domains.write') && <Button size="s" onClick={() => setAddOpen(true)}>Добавить домен</Button>}
      </Toolbar>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Домен</th>
              <th className={tableStyles.numeric}>Ящиков</th>
              <th className={tableStyles.numeric}>Алиасов</th>
              <th>Селектор DKIM</th>
              <th>Состояние DNS</th>
              <th className={tableStyles.nowrap}>Проверялось</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((domain) => (
              <tr key={domain.id}>
                <td className="mt-mono">{domain.name}</td>
                <td className={tableStyles.numeric}>{domain.userCount}</td>
                <td className={tableStyles.numeric}>{domain.aliasCount}</td>
                <td className="mt-mono">{domain.dkimSelector}</td>
                <td><DnsBadge status={domain.dnsOverall} /></td>
                <td className={tableStyles.nowrap}>{formatRelative(domain.dnsCheckedAt)}</td>
                <td>
                  <div className={tableStyles.actions}>
                    <Button
                      mode="tertiary"
                      size="s"
                      onClick={() => {
                        if (domain.dnsStatus) setReport({ domain: domain.name, data: domain.dnsStatus });
                        else check.mutate(domain);
                      }}
                    >
                      Что прописать
                    </Button>
                    {can('domains.dnscheck') && (
                      <Button
                        mode="tertiary"
                        size="s"
                        disabled={check.isPending}
                        onClick={() => check.mutate(domain)}
                      >
                        {check.isPending ? 'Проверяем…' : 'Проверить DNS'}
                      </Button>
                    )}
                    {can('domains.write') && (
                      <Button mode="tertiary" size="s" onClick={() => setDkimFor(domain)}>
                        Ключ DKIM
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && !domains.isLoading && (
              <EmptyRow colSpan={7}>Доменов пока нет</EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>

      {report && (
        <Modal
          wide
          title={`DNS домена ${report.domain}`}
          onClose={() => setReport(null)}
        >
          <Notice tone={report.data.overall === 'ok' ? 'success' : 'info'}>
            Проверено {formatRelative(report.data.checkedAt)}. Итог:{' '}
            <DnsBadge status={report.data.overall} />
          </Notice>
          {report.data.checks.map((c) => (
            <DnsCheckCard key={c.id} check={c} />
          ))}
        </Modal>
      )}

      {addOpen && (
        <AddDomainModal
          onClose={() => setAddOpen(false)}
          onAdded={(name) => {
            setFlash(`Домен ${name} добавлен. Теперь проверьте DNS-записи.`);
            setAddOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['domains'] });
          }}
        />
      )}

      {dkimFor && (
        <DkimModal
          domain={dkimFor}
          onClose={() => setDkimFor(null)}
          onSaved={() => {
            setFlash(`Ключ DKIM домена ${dkimFor.name} сохранён`);
            setDkimFor(null);
            void queryClient.invalidateQueries({ queryKey: ['domains'] });
          }}
        />
      )}
    </>
  );
}

/** Карточка одной проверки: зачем, что должно быть, что есть, что делать. */
function DnsCheckCard({ check }: { check: DnsCheck }) {
  const tone = check.status === 'ok' ? 'ok' : check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : 'muted';
  return (
    <div style={{ marginBottom: 12 }}>
      <Panel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong>{check.title}</strong>
          <Badge tone={tone}>
            {check.status === 'ok'
              ? 'в порядке'
              : check.status === 'warn'
                ? 'замечание'
                : check.status === 'fail'
                  ? 'не настроено'
                  : 'неизвестно'}
          </Badge>
        </div>
        <p style={{ margin: '0 0 8px', color: 'var(--mt-color-text-secondary)' }}>{check.purpose}</p>

        <TableWrap>
          <Table>
            <tbody>
              <tr>
                <td className={tableStyles.nowrap} style={{ width: 150 }}>Имя записи</td>
                <td className="mt-mono">{check.recordName}</td>
              </tr>
              <tr>
                <td className={tableStyles.nowrap}>Тип</td>
                <td className="mt-mono">{check.recordType}</td>
              </tr>
              <tr>
                <td className={tableStyles.nowrap}>Что должно быть</td>
                <td className="mt-mono" style={{ wordBreak: 'break-all' }}>{check.expected}</td>
              </tr>
              <tr>
                <td className={tableStyles.nowrap}>Что опубликовано</td>
                <td className="mt-mono" style={{ wordBreak: 'break-all' }}>
                  {check.actual.length > 0 ? check.actual.join(' | ') : '— ничего —'}
                </td>
              </tr>
            </tbody>
          </Table>
        </TableWrap>

        <p style={{ margin: '8px 0 0' }}>{check.hint}</p>
      </Panel>
    </div>
  );
}

function AddDomainModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => api.createDomain(name.trim().toLowerCase()),
    onSuccess: (domain) => onAdded(domain.name),
  });

  return (
    <Modal
      title="Новый домен"
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={name.trim() === '' || add.isPending} onClick={() => add.mutate()}>
            Добавить
          </Button>
        </>
      }
    >
      <ErrorNotice error={add.error} />
      <Field
        label="Доменное имя"
        hint="После добавления обязательно проверьте DNS — без записей MX и SPF почта работать не будет."
      >
        <input
          className="mt-input mt-mono"
          autoFocus
          placeholder="example.ru"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

function DkimModal({
  domain,
  onClose,
  onSaved,
}: {
  domain: Domain;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selector, setSelector] = useState(domain.dkimSelector);
  const [key, setKey] = useState(domain.dkimPublicKey ?? '');

  const save = useMutation({
    mutationFn: () =>
      api.updateDomain(domain.id, {
        dkimSelector: selector.trim(),
        dkimPublicKey: key.trim() === '' ? null : key.trim(),
      }),
    onSuccess: onSaved,
  });

  return (
    <Modal
      title={`DKIM домена ${domain.name}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Сохранить
          </Button>
        </>
      }
    >
      <ErrorNotice error={save.error} />
      <Notice tone="info">
        Ключ генерирует rspamd. Готовую запись он кладёт в контейнер:
        <br />
        <code className="mt-mono">
          /var/lib/rspamd/dkim/{domain.name}.{selector}.dns.txt
        </code>
        <br />
        Скопируйте оттуда значение поля <code className="mt-mono">p=</code> — админка сверит
        его с тем, что опубликовано в DNS.
      </Notice>
      <Field label="Селектор">
        <input
          className="mt-input mt-mono"
          value={selector}
          onChange={(e) => setSelector(e.target.value)}
        />
      </Field>
      <Field label="Публичный ключ (значение p=)">
        <textarea
          className="mt-textarea"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
