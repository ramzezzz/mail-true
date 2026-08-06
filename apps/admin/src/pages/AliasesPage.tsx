/** Алиасы: пересылка с адреса на адрес. Postfix читает таблицу напрямую. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type { Alias } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { RowActions } from '../components/RowActions';
import { IconPower, IconTrash } from '../components/icons';
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
  /**
   * Алиас, который собираются удалить.
   *
   * Подтверждение здесь появилось не для симметрии с ящиками. Значок
   * корзины стоит вплотную к «Отключить», кнопки 26×26 с зазором 2 px, и
   * промах пальцем удалял пересылку без единого вопроса и без отмены.
   * Последствие тихое и потому злое: письма на прежний адрес начинают
   * отбиваться, а заметят это через дни — по жалобе снаружи.
   */
  const [removing, setRemoving] = useState<Alias | null>(null);

  const aliases = useQuery({
    queryKey: ['aliases', search, offset],
    queryFn: () => api.aliases({ search: search.trim() || undefined, limit: LIMIT, offset }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aliases'] });
  };

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => api.setAliasActive(id, active),
    // Об успехе сообщаем, как в списке ящиков: молчание после нажатия
    // неотличимо от «кнопка не сработала», и человек жмёт ещё раз.
    onSuccess: (_data, variables) => {
      setFlash(variables.active ? 'Алиас включён' : 'Алиас отключён');
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteAlias(id),
    onSuccess: () => {
      setFlash('Алиас удалён');
      setRemoving(null);
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
        {can('aliases.write') && (
          <Button size="s" onClick={() => setAddOpen(true)}>
            Создать алиас
          </Button>
        )}
      </Toolbar>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Откуда</th>
              <th>Куда</th>
              {/*
                Домен виден в самом адресе, дата создания на телефоне
                не нужна: без этого колонка действий уезжала за правый
                край внутрь прокрутки (замер на 390 — за краем обе кнопки).
              */}
              <th className={tableStyles.optionalNarrow}>Домен</th>
              <th>Состояние</th>
              <th className={`${tableStyles.nowrap} ${tableStyles.optional}`}>Создан</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((alias) => (
              <tr key={alias.id}>
                <td className="mt-mono">{alias.source}</td>
                <td className="mt-mono">{alias.destination}</td>
                <td className={`mt-mono ${tableStyles.optionalNarrow}`}>{alias.domain}</td>
                <td>
                  <ActiveBadge active={alias.active} />
                </td>
                <td className={`${tableStyles.nowrap} ${tableStyles.optional}`}>
                  {formatDateTime(alias.createdAt)}
                </td>
                <td>
                  {can('aliases.write') && (
                    <RowActions
                      subject={alias.source}
                      actions={[
                        {
                          id: 'active',
                          icon: <IconPower />,
                          label: alias.active ? 'Отключить' : 'Включить',
                          onClick: () => toggle.mutate({ id: alias.id, active: !alias.active }),
                        },
                        {
                          id: 'delete',
                          icon: <IconTrash />,
                          label: 'Удалить',
                          danger: true,
                          onClick: () => {
                            remove.reset();
                            setRemoving(alias);
                          },
                        },
                      ]}
                    />
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

      {removing && (
        <Modal
          title="Удалить алиас"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button mode="secondary" onClick={() => setRemoving(null)}>
                Отмена
              </Button>
              <Button disabled={remove.isPending} onClick={() => remove.mutate(removing.id)}>
                {remove.isPending ? 'Удаляем…' : 'Удалить алиас'}
              </Button>
            </>
          }
        >
          <ErrorNotice error={remove.error} />
          <Notice tone="error">
            Письма, приходящие на <span className="mt-mono">{removing.source}</span>, перестанут
            попадать на <span className="mt-mono">{removing.destination}</span> и будут отбиваться
            отправителям. Восстановить пересылку можно только заново создав алиас.
          </Notice>
        </Modal>
      )}

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
    mutationFn: () =>
      api.createAlias(source.trim().toLowerCase(), destination.trim().toLowerCase()),
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
