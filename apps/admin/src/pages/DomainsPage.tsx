/**
 * Домены и проверка DNS.
 *
 * Это самое частое место, где спотыкаются при установке почтового сервера,
 * поэтому по каждой записи показывается: зачем она, что должно быть
 * (готовая строка для копирования), что опубликовано на самом деле
 * и что конкретно сделать. Никаких «SPF: FAIL».
 *
 * Кнопка одна. Раньше их было две — «Проверить DNS» и «Что прописать», —
 * и они отвечали на разные половины одного вопроса: первая говорила
 * «не настроено», не говоря что именно, вторая показывала, что должно
 * быть, ничего не зная о том, что есть. Сравнивать приходилось в голове.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type { DnsReport, Domain } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { RowActions } from '../components/RowActions';
import { IconKey, IconShieldCheck, IconTrash } from '../components/icons';
import {
  DnsBadge,
  ErrorNotice,
  Field,
  Modal,
  Notice,
  Toolbar,
  ToolbarSpacer,
} from '../components/ui';
import { formatRelative } from '../lib/format';
import { DnsDialog } from './DnsDialog';

export function DomainsPage() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  /** Открытый диалог: домен и последний известный отчёт (может быть null). */
  const [opened, setOpened] = useState<{ domain: Domain; report: DnsReport | null } | null>(null);
  const [dkimFor, setDkimFor] = useState<Domain | null>(null);
  const [removing, setRemoving] = useState<Domain | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.domains() });

  const check = useMutation({
    mutationFn: (domain: Domain) => api.dnsCheck(domain.id),
    onSuccess: (data, domain) => {
      setOpened({ domain, report: data });
      void queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
  });

  /**
   * Точечная перепроверка одной записи.
   *
   * Идущие проверки держим списком, а не одним флагом: перепроверка одной
   * строки не должна замораживать остальной диалог, и человек вправе
   * запустить сразу две. Результат вклеивается на место старого — весь
   * отчёт при этом не перечитывается, иначе ответы по другим записям
   * подменились бы новыми и потеряли своё время.
   */
  const [checkingIds, setCheckingIds] = useState<string[]>([]);
  const checkOne = useMutation({
    mutationFn: ({ domain, checkId }: { domain: Domain; checkId: string }) =>
      api.dnsCheckOne(domain.id, checkId),
    onMutate: ({ checkId }) => {
      setCheckingIds((ids) => (ids.includes(checkId) ? ids : [...ids, checkId]));
    },
    onSuccess: (data) => {
      setOpened((prev) => {
        if (!prev?.report) return prev;
        return {
          ...prev,
          report: {
            ...prev.report,
            overall: data.overall,
            resolver: data.resolver,
            checks: prev.report.checks.map((c) => (c.id === data.check.id ? data.check : c)),
          },
        };
      });
      void queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
    onSettled: (_data, _error, { checkId }) => {
      setCheckingIds((ids) => ids.filter((x) => x !== checkId));
    },
  });

  /**
   * Открытие диалога. Прежний отчёт показывается сразу, чтобы не смотреть
   * на пустой экран, и тут же запускается свежая проверка: устаревшая
   * картина DNS вводит в заблуждение сильнее, чем её отсутствие.
   */
  const openFor = (domain: Domain): void => {
    setOpened({ domain, report: domain.dnsStatus });
    if (can('domains.dnscheck')) check.mutate(domain);
  };

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
              {/*
                На узком экране счётчики, селектор и дата проверки уходят:
                иначе колонка действий уезжает за правый край внутрь
                прокрутки и до неё не добраться (замер на 390: за краем
                оказывались обе кнопки, включая первую).
              */}
              <th className={`${tableStyles.numeric} ${tableStyles.optional}`}>Ящиков</th>
              <th className={`${tableStyles.numeric} ${tableStyles.optional}`}>Алиасов</th>
              <th className={tableStyles.optionalNarrow}>Селектор DKIM</th>
              <th>Состояние DNS</th>
              <th className={`${tableStyles.nowrap} ${tableStyles.optional}`}>Проверялось</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((domain) => (
              <tr key={domain.id}>
                <td className="mt-mono">{domain.name}</td>
                <td className={`${tableStyles.numeric} ${tableStyles.optional}`}>{domain.userCount}</td>
                <td className={`${tableStyles.numeric} ${tableStyles.optional}`}>{domain.aliasCount}</td>
                <td className={`mt-mono ${tableStyles.optionalNarrow}`}>{domain.dkimSelector}</td>
                <td><DnsBadge status={domain.dnsOverall} /></td>
                <td className={`${tableStyles.nowrap} ${tableStyles.optional}`}>
                  {formatRelative(domain.dnsCheckedAt)}
                </td>
                <td>
                  <RowActions
                    subject={domain.name}
                    actions={[
                      {
                        id: 'dns',
                        icon: <IconShieldCheck />,
                        label: 'Проверить DNS',
                        onClick: () => openFor(domain),
                      },
                      ...(can('domains.write')
                        ? [
                            {
                              id: 'dkim',
                              icon: <IconKey />,
                              label: 'Ключ DKIM',
                              onClick: () => setDkimFor(domain),
                            },
                            {
                              id: 'delete',
                              icon: <IconTrash />,
                              label: 'Удалить домен',
                              danger: true,
                              onClick: () => setRemoving(domain),
                            },
                          ]
                        : []),
                    ]}
                  />
                </td>
              </tr>
            ))}
            {items.length === 0 && !domains.isLoading && (
              <EmptyRow colSpan={7}>Доменов пока нет</EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>

      {opened && (
        <DnsDialog
          domainName={opened.domain.name}
          report={opened.report}
          checking={check.isPending}
          checkingIds={checkingIds}
          error={check.error ?? checkOne.error}
          canCheck={can('domains.dnscheck')}
          onRecheck={() => check.mutate(opened.domain)}
          onRecheckOne={(checkId) => checkOne.mutate({ domain: opened.domain, checkId })}
          onClose={() => {
            setOpened(null);
            check.reset();
            checkOne.reset();
          }}
        />
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

      {removing && (
        <DeleteDomainModal
          domain={removing}
          onClose={() => setRemoving(null)}
          onDeleted={(name, aliasesRemoved) => {
            setFlash(
              aliasesRemoved > 0
                ? `Домен ${name} удалён вместе с ${String(aliasesRemoved)} алиас(ами). ` +
                  'Список удалённых алиасов остался в журнале аудита.'
                : `Домен ${name} удалён.`,
            );
            setRemoving(null);
            void queryClient.invalidateQueries({ queryKey: ['domains'] });
          }}
        />
      )}
    </>
  );
}

/**
 * Удаление домена.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО НЕ ПРОСТО «ЕЩЁ ОДНА КНОПКА УДАЛИТЬ»
 * ------------------------------------------------------------------
 * Домен можно было ЗАВЕСТИ из панели, но нельзя было убрать: ошибочно
 * добавленный `exampl.ru` оставался в списке навсегда, портил сводку DNS
 * красным и приучал не смотреть на неё вовсе. Убирать его приходилось
 * из psql — то есть операция была, но пряталась за пределами инструмента.
 *
 * Сервер отвечает на отказ ПЕРЕЧНЕМ того, что мешает (routes/domains.ts):
 * адреса ящиков или пары алиасов, а не одно лишь число. Здесь этот ответ
 * показывается как есть — переписывать его в «нельзя» значило бы отнять
 * у человека ровно ту часть, ради которой отказ и составлялся.
 *
 * Ящики не сносятся ни при каком согласии: их каталоги переживают строку
 * в базе, а вернуть настройки и правила удалённого ящика неоткуда.
 * Алиасы — уносятся, но только по отдельному подтверждению, и тогда их
 * полный список остаётся в журнале аудита.
 */
function DeleteDomainModal({
  domain,
  onClose,
  onDeleted,
}: {
  domain: Domain;
  onClose: () => void;
  onDeleted: (name: string, aliasesRemoved: number) => void;
}) {
  const [withAliases, setWithAliases] = useState(false);
  const hasBoxes = domain.userCount > 0;
  const hasAliases = domain.aliasCount > 0;

  const remove = useMutation({
    mutationFn: () => api.deleteDomain(domain.id, withAliases),
    onSuccess: (data) => onDeleted(domain.name, data.aliasesRemoved),
  });

  return (
    <Modal
      title={`Удалить домен ${domain.name}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={remove.isPending || hasBoxes || (hasAliases && !withAliases)}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Удаляем…' : 'Удалить домен'}
          </Button>
        </>
      }
    >
      {/* Ответ сервера показывается целиком: в нём перечислено, ЧТО
          именно мешает, и это и есть ответ на вопрос «что делать». */}
      <ErrorNotice error={remove.error} />

      {hasBoxes ? (
        <Notice tone="error">
          В домене {domain.userCount} ящик(ов) — удалить его нельзя. Удаление уничтожило бы их
          записи вместе с настройками, подписями и правилами, а письма остались бы лежать в
          хранилище без владельца. Сначала перенесите ящики на другой домен или удалите их в
          разделе «Ящики»: там удаление ящика убирает и его почту.
        </Notice>
      ) : (
        <Notice tone="error">
          Домен исчезнет из списка вместе с настройками DKIM и последним отчётом о проверке DNS.
          Почта на адреса этого домена приниматься перестанет.
        </Notice>
      )}

      {!hasBoxes && hasAliases && (
        <Field
          label={`В домене ${domain.aliasCount} алиас(ов)`}
          hint="Они удалятся вместе с доменом — в базе у них каскадное удаление. Полный список удалённых попадёт в журнал аудита."
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={withAliases}
              onChange={(e) => setWithAliases(e.target.checked)}
            />
            <span>Да, удалить домен вместе с его алиасами</span>
          </label>
        </Field>
      )}
    </Modal>
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
