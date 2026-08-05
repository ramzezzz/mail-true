/** Алиасы: пересылка с адреса на адрес. Postfix читает таблицу напрямую. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import {
  ActiveBadge,
  ErrorNotice,
  Field,
  Modal,
  Notice,
  Pager,
  Toolbar,
  ToolbarSpacer,
} from '../components/ui';
import { formatDateTime } from '../lib/format';

const LIMIT = 50;

export function AliasesPage() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const aliases = useQuery({
    queryKey: ['aliases', search, offset],
    queryFn: () => api.aliases({ search: search.trim() || undefined, limit: LIMIT, offset }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aliases'] });
  };

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      api.setAliasActive(id, active),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteAlias(id),
    onSuccess: () => {
      setFlash('Алиас удалён');
      invalidate();
    },
  });

  const items = aliases.data?.items ?? [];

  return (
    <>
      <PageTitle title="Алиасы" subtitle="Пересылка почты с одного адреса на другой" />

      {flash && <Notice tone="success">{flash}</Notice>}
      <ErrorNotice error={aliases.error ?? toggle.error ?? remove.error} />

      <Toolbar>
        <input
          className="mt-input"
          style={{ width: 300 }}
          placeholder="Поиск по адресу"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <ToolbarSpacer />
        {can('aliases.write') && <Button size="s" onClick={() => setAddOpen(true)}>Создать алиас</Button>}
      </Toolbar>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Откуда</th>
              <th>Куда</th>
              <th>Домен</th>
              <th>Состояние</th>
              <th className={tableStyles.nowrap}>Создан</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((alias) => (
              <tr key={alias.id}>
                <td className="mt-mono">{alias.source}</td>
                <td className="mt-mono">{alias.destination}</td>
                <td className="mt-mono">{alias.domain}</td>
                <td><ActiveBadge active={alias.active} /></td>
                <td className={tableStyles.nowrap}>{formatDateTime(alias.createdAt)}</td>
                <td>
                  {can('aliases.write') && (
                    <div className={tableStyles.actions}>
                      <Button
                        mode="tertiary"
                        size="s"
                        onClick={() => toggle.mutate({ id: alias.id, active: !alias.active })}
                      >
                        {alias.active ? 'Отключить' : 'Включить'}
                      </Button>
                      <Button mode="tertiary" size="s" onClick={() => remove.mutate(alias.id)}>
                        Удалить
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && !aliases.isLoading && (
              <EmptyRow colSpan={6}>Алиасов пока нет</EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>

      <Pager total={aliases.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />

      {addOpen && (
        <AddAliasModal
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setFlash('Алиас создан');
            setAddOpen(false);
            invalidate();
          }}
        />
      )}
    </>
  );
}

function AddAliasModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');

  const add = useMutation({
    mutationFn: () => api.createAlias(source.trim().toLowerCase(), destination.trim().toLowerCase()),
    onSuccess: onAdded,
  });

  return (
    <Modal
      title="Новый алиас"
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={source.trim() === '' || destination.trim() === '' || add.isPending}
            onClick={() => add.mutate()}
          >
            Создать
          </Button>
        </>
      }
    >
      <ErrorNotice error={add.error} />
      <Field label="Откуда" hint="Адрес в вашем домене — на него будут писать">
        <input
          className="mt-input mt-mono"
          autoFocus
          placeholder="info@mail.local"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </Field>
      <Field label="Куда" hint="Куда пересылать. Может быть и внешним адресом">
        <input
          className="mt-input mt-mono"
          placeholder="ivan@mail.local"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
