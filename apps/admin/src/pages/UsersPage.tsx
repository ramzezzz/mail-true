/**
 * Пользователи: список с поиском и фильтрами, создание, изменение,
 * блокировка, смена пароля, квота, массовые операции.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Checkbox } from '@web/components';
import { api } from '../api/client';
import type { MailUser, UserDeleteResult } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { AddressInput } from '../components/AddressInput';
import { QuotaInput } from '../components/QuotaInput';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { RowActions } from '../components/RowActions';
import {
  IconEnterMailbox,
  IconKey,
  IconLock,
  IconPencil,
  IconCard,
  IconSettings,
  IconTrash,
  IconUnlock,
} from '../components/icons';
import {
  ActiveBadge,
  ErrorNotice,
  Field,
  Modal,
  Notice,
  Pager,
  Tile,
  Tiles,
  Toolbar,
  ToolbarSpacer,
} from '../components/ui';
import { formatBytes, formatDateTime, pluralize } from '../lib/format';
import { addressProblemWhileTyping, displayNameLengthProblem } from '@shared/mailbox-limits';
import { DEFAULT_QUOTA_UNIT, quotaToBytes, splitQuota, type QuotaUnit } from '../lib/quota';

const LIMIT = 50;

export function UsersPage() {
  const { can, session } = useSession();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'blocked' | 'overquota'>('all');
  const [domainId, setDomainId] = useState<number | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  /*
   * Выбранные ящики: НОМЕР → АДРЕС, а не просто набор номеров.
   *
   * Адреса для подтверждения удаления собирались из текущей страницы
   * списка (items.filter(...)), а сам выбор страницу переживает: он не
   * сбрасывается ни при перелистывании, ни при смене поиска или фильтра.
   *
   * Отсюда и беда. Выбрал двадцать ящиков, перелистнул, отметил ещё два,
   * открыл «Действия над 22 ящиками» — а в подтверждении показаны ДВА
   * адреса, те, что видны сейчас. Человек читает короткий список, набирает
   * «удалить» и сносит двадцать два ящика, из которых видел два.
   *
   * Держим адрес рядом с номером в момент отметки: тогда список в
   * подтверждении всегда полный и всегда тот самый.
   */
  const [selected, setSelected] = useState<Map<number, string>>(new Map());

  const [createOpen, setCreateOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState<MailUser | null>(null);
  const [editing, setEditing] = useState<MailUser | null>(null);
  /**
   * Ящик, карточку которого смотрят.
   *
   * Спецификация панели требует показывать по ящику алиасы, размер и
   * число писем, и сервер это умел с самого начала (GET /users/:id и
   * /users/:id/usage). Клиентские методы тоже были объявлены — и не
   * вызывались ниоткуда: занятость была видна только в топ-20 на
   * дашборде, а по конкретному ящику из его строки — никак.
   */
  const [cardFor, setCardFor] = useState<MailUser | null>(null);
  const [enterFor, setEnterFor] = useState<MailUser | null>(null);
  const [deleting, setDeleting] = useState<MailUser | null>(null);
  /*
   * Ящик, который собираются заблокировать.
   *
   * Блокировка срабатывала сразу, одним нажатием значка 26×26 вплотную к
   * «Удалить». А последствие у неё не то, которое ожидают: карта Postfix
   * отбирает адрес по `AND active`, то есть для внешнего мира ящик
   * ПЕРЕСТАЁТ СУЩЕСТВОВАТЬ — отправитель получает «адреса не существует»,
   * и письма за весь период блокировки не восстановить ничем. «Заблокирую,
   * чтобы почта пока копилась» — самое частое ожидание, и оно неверное.
   *
   * Разблокировка вопросов не требует: она ничего не теряет.
   */
  const [blocking, setBlocking] = useState<MailUser | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  /**
   * Вход в чужой ящик доступен, только если настроен служебный доступ
   * Dovecot: без него сервер всё равно откажет, и кнопка вводила бы в
   * заблуждение.
   */
  const canEnterMailbox = can('mailbox.impersonate') && (session?.masterAccess ?? false);

  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.domains() });

  const users = useQuery({
    queryKey: ['users', search, status, domainId, offset],
    queryFn: () =>
      api.users({
        search: search.trim() || undefined,
        status,
        domainId,
        limit: LIMIT,
        offset,
      }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  };

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => api.updateUser(id, { active }),
    onSuccess: (user) => {
      setFlash(`Ящик ${user.email} ${user.active ? 'разблокирован' : 'заблокирован'}`);
      invalidate();
    },
  });

  const items = users.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((u) => selected.has(u.id));

  const selectedIds = useMemo(() => [...selected.keys()], [selected]);

  return (
    <>
      <PageTitle
        title="Пользователи"
        subtitle="Почтовые ящики: поиск, создание, блокировка, квоты и пароли"
      />

      {flash && <Notice tone="success">{flash}</Notice>}
      <ErrorNotice error={users.error ?? toggleActive.error} />

      <Toolbar>
        <input
          className="mt-input"
          style={{ width: 280 }}
          placeholder="Поиск по адресу или имени"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <select
          className="mt-select"
          style={{ width: 170 }}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as 'all' | 'active' | 'blocked' | 'overquota');
            setOffset(0);
          }}
        >
          <option value="all">Все ящики</option>
          <option value="active">Только активные</option>
          <option value="blocked">Только заблокированные</option>
          {/*
            «Почти заполненные» — ящики, занятые на девять десятых и
            больше. Значение приходит из снимка показателей: занятости
            ящика в базе нет. Фильтр был назван в спецификации панели и в
            комментарии сервера, а на деле его не существовало нигде.
          */}
          <option value="overquota">Почти заполненные</option>
        </select>
        <select
          className="mt-select"
          style={{ width: 180 }}
          value={domainId ?? ''}
          onChange={(e) => {
            setDomainId(e.target.value === '' ? undefined : Number(e.target.value));
            setOffset(0);
          }}
        >
          <option value="">Все домены</option>
          {(domains.data?.items ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>

        <ToolbarSpacer />

        {selectedIds.length > 0 && can('users.write') && (
          <Button mode="secondary" size="s" onClick={() => setBulkOpen(true)}>
            Действия над {pluralize(selectedIds.length, 'ящиком', 'ящиками', 'ящиками')}
          </Button>
        )}
        {/*
          Отмеченные ящики уезжают на страницу подписей состоянием
          перехода, а не в адресе: список номеров в адресной строке
          при сотне ящиков не помещается и в закладку не годится —
          выборка живёт ровно один переход.
        */}
        {can('usersettings.bulk') && (
          <Link to="/users/signatures" state={{ ids: selectedIds }}>
            <Button mode="secondary" size="s">
              {selectedIds.length > 0
                ? `Подпись по шаблону (${selectedIds.length})`
                : 'Подписи по шаблону'}
            </Button>
          </Link>
        )}
        {can('users.write') && (
          <>
            <Link to="/users/import">
              <Button mode="secondary" size="s">
                Импорт из CSV
              </Button>
            </Link>
            <Button size="s" onClick={() => setCreateOpen(true)}>
              Создать ящик
            </Button>
          </>
        )}
      </Toolbar>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              {can('users.write') && (
                <th style={{ width: 28 }}>
                  <Checkbox
                    checked={allSelected}
                    onChange={(e) => {
                      // «Отметить все» — про ЭТУ страницу, поэтому прежний
                      // выбор с других страниц сохраняется, а снятие
                      // убирает только видимое.
                      const next = new Map(selected);
                      for (const u of items) {
                        if (e.target.checked) next.set(u.id, u.email);
                        else next.delete(u.id);
                      }
                      setSelected(next);
                    }}
                  />
                </th>
              )}
              <th>Адрес</th>
              <th className={tableStyles.optionalNarrow}>Имя</th>
              <th className={tableStyles.numeric}>Квота</th>
              <th className={`${tableStyles.numeric} ${tableStyles.optional}`}>Алиасов</th>
              <th>Состояние</th>
              <th className={`${tableStyles.nowrap} ${tableStyles.optional}`}>Создан</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr
                key={user.id}
                className={selected.has(user.id) ? tableStyles.selected : undefined}
              >
                {can('users.write') && (
                  <td>
                    <Checkbox
                      checked={selected.has(user.id)}
                      onChange={(e) => {
                        const next = new Map(selected);
                        if (e.target.checked) next.set(user.id, user.email);
                        else next.delete(user.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                )}
                <td className="mt-mono">{user.email}</td>
                <td className={tableStyles.optionalNarrow}>{user.displayName ?? '—'}</td>
                <td className={tableStyles.numeric}>{formatBytes(user.quotaBytes)}</td>
                <td className={`${tableStyles.numeric} ${tableStyles.optional}`}>
                  {user.aliasCount}
                </td>
                <td>
                  <ActiveBadge active={user.active} />
                </td>
                <td className={`${tableStyles.nowrap} ${tableStyles.optional}`}>
                  {formatDateTime(user.createdAt)}
                </td>
                <td>
                  {/*
                    Значки, раскрывающиеся в подписи при наведении и фокусе
                    (см. components/RowActions.tsx). Шесть текстовых кнопок
                    в строку не помещались: на 1440 не хватало 47 точек,
                    на 1280 — 207, и «Войти в ящик» с «Удалить» уезжали
                    за правый край внутрь прокрутки.
                  */}
                  <RowActions
                    subject={user.email}
                    actions={[
                      ...(can('usersettings.read')
                        ? [
                            {
                              id: 'settings',
                              icon: <IconSettings />,
                              label: 'Настройки',
                              // Ссылка, а не кнопка: это переход на страницу,
                              // и открыть его в новой вкладке — законное желание.
                              to: `/users/${String(user.id)}/settings`,
                            },
                          ]
                        : []),
                      {
                        id: 'card',
                        icon: <IconCard />,
                        label: 'Карточка',
                        onClick: () => setCardFor(user),
                      },
                      ...(canEnterMailbox
                        ? [
                            {
                              id: 'enter',
                              icon: <IconEnterMailbox />,
                              label: 'Войти в ящик',
                              onClick: () => setEnterFor(user),
                            },
                          ]
                        : []),
                      ...(can('users.write')
                        ? [
                            {
                              id: 'edit',
                              icon: <IconPencil />,
                              label: 'Изменить',
                              onClick: () => setEditing(user),
                            },
                          ]
                        : []),
                      ...(can('users.password')
                        ? [
                            {
                              id: 'password',
                              icon: <IconKey />,
                              label: 'Пароль',
                              onClick: () => setPasswordFor(user),
                            },
                          ]
                        : []),
                      ...(can('users.write')
                        ? [
                            {
                              id: 'active',
                              icon: user.active ? <IconLock /> : <IconUnlock />,
                              label: user.active ? 'Заблокировать' : 'Разблокировать',
                              danger: true,
                              onClick: () => {
                                if (user.active) setBlocking(user);
                                else toggleActive.mutate({ id: user.id, active: true });
                              },
                            },
                          ]
                        : []),
                      ...(can('users.delete')
                        ? [
                            {
                              id: 'delete',
                              icon: <IconTrash />,
                              label: 'Удалить',
                              danger: true,
                              onClick: () => setDeleting(user),
                            },
                          ]
                        : []),
                    ]}
                  />
                </td>
              </tr>
            ))}
            {items.length === 0 && !users.isLoading && (
              /*
               * Колонок 7, а с колонкой отметок — 8: она условная, как и в
               * шапке. Прибитая восьмёрка растягивала пустую строку шире
               * таблицы у роли «только чтение» — таблица уезжала вправо.
               */
              /*
                ПУСТО ПО-РАЗНОМУ — И ГОВОРИТСЯ ПО-РАЗНОМУ.
                Раньше при любом отборе стояло «Ящиков пока нет»: человек,
                отобравший заблокированные в одном домене, читал, что
                ящиков на сервере нет вообще, и шёл заводить их заново.
                Отдельно назван случай «сбор показателей выключен»: там
                ответа не знает никто, и молчаливое «нет» — неправда.
              */
              <EmptyRow colSpan={can('users.write') ? 8 : 7}>
                {users.data?.metricsMissing === true
                  ? 'Сбор показателей выключен, занятость ящиков неизвестна — ' +
                    'отобрать почти заполненные нечем'
                  : search
                    ? 'По этому запросу ничего не нашлось'
                    : status !== 'all' || domainId !== undefined
                      ? 'По этому отбору ящиков нет'
                      : 'Ящиков пока нет'}
              </EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>

      <Pager total={users.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />

      {createOpen && (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onCreated={(message) => {
            setFlash(message);
            setCreateOpen(false);
            invalidate();
          }}
        />
      )}
      {cardFor !== null && <UserCardModal user={cardFor} onClose={() => setCardFor(null)} />}
      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setFlash(message);
            setEditing(null);
            invalidate();
          }}
        />
      )}
      {passwordFor && (
        <PasswordModal
          user={passwordFor}
          onClose={() => setPasswordFor(null)}
          onDone={(message) => {
            setFlash(message);
            invalidate();
          }}
        />
      )}
      {enterFor && <EnterMailboxModal user={enterFor} onClose={() => setEnterFor(null)} />}
      {blocking && (
        <BlockUserModal
          user={blocking}
          pending={toggleActive.isPending}
          onClose={() => setBlocking(null)}
          onConfirm={() => {
            toggleActive.mutate({ id: blocking.id, active: false });
            setBlocking(null);
          }}
        />
      )}
      {deleting && (
        <DeleteUserModal
          user={deleting}
          onClose={() => setDeleting(null)}
          onDone={(message) => {
            setFlash(message);
            setDeleting(null);
            setSelected(new Map());
            invalidate();
          }}
        />
      )}
      {bulkOpen && (
        <BulkModal
          ids={selectedIds}
          emails={[...selected.values()]}
          canDelete={can('users.delete')}
          onClose={() => setBulkOpen(false)}
          onDone={(message) => {
            setFlash(message);
            setBulkOpen(false);
            setSelected(new Map());
            invalidate();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Создание ящика                                                       */
/* ------------------------------------------------------------------ */

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [passwordShown, setPasswordShown] = useState(false);
  const [quotaAmount, setQuotaAmount] = useState('1');
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>(DEFAULT_QUOTA_UNIT);
  /**
   * Трогал ли человек поле квоты.
   *
   * Пока не трогал, значение НЕ отправляется, и ящик получает квоту из
   * настроек сервера (ADMIN_DEFAULT_QUOTA_BYTES). Раньше форма всегда
   * слала своё «1 ГБ», и настройка «Квота нового ящика по умолчанию»
   * не значила ничего: владелец ставил в настройках десять гигабайт, а
   * каждый ящик, заведённый кнопкой «Создать ящик», получал один. Соседний
   * раздел того же интерфейса — импорт — сделан именно так и спрашивает
   * серверное значение (ImportPage.tsx).
   */
  const [quotaTouched, setQuotaTouched] = useState(false);
  const [generated, setGenerated] = useState<{ email: string; password: string } | null>(null);

  // Домены для подстановки. Запрос тот же, что на странице, — react-query
  // отдаёт его из кеша, второго обращения к серверу не будет.
  const domainsQuery = useQuery({ queryKey: ['domains'], queryFn: () => api.domains() });
  const domainNames = (domainsQuery.data?.items ?? []).map((d) => d.name);

  /*
   * Квота из настроек сервера — чтобы показать её ДО того, как человек
   * тронет поле. Тот же запрос, что на странице импорта: react-query
   * отдаст его из кеша, второго обращения к серверу не будет.
   */
  const defaultsQuery = useQuery({
    queryKey: ['import-defaults'],
    queryFn: () => api.importDefaults(),
  });
  const serverDefaultQuota = defaultsQuery.data?.defaultQuotaBytes ?? null;

  const quotaBytes = quotaToBytes(quotaAmount, quotaUnit);
  const emailProblem = addressProblemWhileTyping(email);
  /*
   * Пароль проверяем ЗДЕСЬ, а не только на сервере. Сервер отвечает
   * отказом с разбором по полям, но узнавать «пароль короче 8 знаков»
   * после нажатия «Создать» — лишний круг: правило известно заранее.
   */
  const passwordProblem =
    password === ''
      ? null
      : password.length < 8
        ? 'Пароль короче 8 знаков'
        : passwordRepeat !== '' && password !== passwordRepeat
          ? 'Пароли не совпадают'
          : null;
  const passwordMismatch = password !== '' && passwordRepeat !== password;
  const displayNameProblem = displayNameLengthProblem(displayName);
  const create = useMutation({
    mutationFn: () =>
      api.createUser({
        email: email.trim().toLowerCase(),
        ...(password ? { password } : {}),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(quotaTouched && quotaBytes !== null ? { quotaBytes } : {}),
      }),
    onSuccess: (user) => {
      if (user.generatedPassword) {
        setGenerated({ email: user.email, password: user.generatedPassword });
      } else {
        onCreated(`Ящик ${user.email} создан`);
      }
    },
  });

  if (generated) {
    return (
      <Modal
        title="Ящик создан"
        onClose={() => onCreated(`Ящик ${generated.email} создан`)}
        footer={
          <Button onClick={() => onCreated(`Ящик ${generated.email} создан`)}>Понятно</Button>
        }
      >
        <Notice tone="info">
          Пароль показывается <strong>один раз</strong> — сохранён он нигде не будет.
        </Notice>
        <Field label="Адрес">
          <input className="mt-input mt-mono" readOnly value={generated.email} />
        </Field>
        <Field label="Пароль">
          <input className="mt-input mt-mono" readOnly value={generated.password} />
        </Field>
      </Modal>
    );
  }

  return (
    <Modal
      title="Новый почтовый ящик"
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={
              email.trim() === '' ||
              emailProblem !== null ||
              displayNameProblem !== null ||
              passwordProblem !== null ||
              (password !== '' && !passwordShown && passwordRepeat !== password) ||
              quotaBytes === null ||
              create.isPending
            }
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Создаём…' : 'Создать'}
          </Button>
        </>
      }
    >
      <ErrorNotice error={create.error} />
      {/*
        Домен подставляется сам — из тех, что заведены в разделе «Домены».
        Раньше здесь стояло одно поле с подсказкой «ivan@mail.local», и
        подсказку принимали за настоящий домен: на свежем сервере с доменом
        home.local ящик создавали как test@mail.local и получали отказ
        «домен не заведён» — при том, что домен как раз спрашивали при
        установке. Набирать руками то, что система знает, незачем.
      */}
      <Field label="Адрес" hint={emailProblem ?? 'Имя ящика — домен подставится сам'}>
        <AddressInput
          value={email}
          onChange={setEmail}
          domains={domainNames}
          autoFocus
          placeholder="ivan"
        />
      </Field>
      <Field label="Отображаемое имя" {...(displayNameProblem ? { hint: displayNameProblem } : {})}>
        <input
          className="mt-input"
          placeholder="Иван Петров"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Field>
      {/*
        Пароль скрыт, как ему и положено: раньше он набирался открытым
        текстом на глазах у всех, кто стоит рядом. Показать — кнопкой,
        она же снимает нужду в повторе, поэтому второе поле спрашивается
        только пока пароль скрыт.
      */}
      <Field
        label="Пароль"
        hint={
          passwordProblem ?? 'Оставьте пустым — сгенерируем и покажем один раз. Минимум 8 знаков'
        }
      >
        <div className="mt-input-with-action">
          <input
            className="mt-input mt-mono"
            type={passwordShown ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            mode="secondary"
            onClick={() => setPasswordShown((shown) => !shown)}
            title={passwordShown ? 'Скрыть пароль' : 'Показать пароль'}
          >
            {passwordShown ? 'Скрыть' : 'Показать'}
          </Button>
        </div>
      </Field>
      {password !== '' && !passwordShown && (
        <Field
          label="Повторите пароль"
          {...(passwordMismatch && passwordRepeat !== '' ? { hint: 'Пароли не совпадают' } : {})}
        >
          <input
            className="mt-input mt-mono"
            type="password"
            autoComplete="new-password"
            value={passwordRepeat}
            onChange={(e) => setPasswordRepeat(e.target.value)}
          />
        </Field>
      )}
      <Field
        label="Квота"
        hint={
          !quotaTouched
            ? serverDefaultQuota === null
              ? 'Как настроено на сервере'
              : `Как настроено на сервере: ${formatBytes(serverDefaultQuota)}`
            : quotaBytes === null
              ? 'Введите число, а единицу выберите рядом. 0 — без ограничения.'
              : `Будет ${formatBytes(quotaBytes)}`
        }
      >
        <QuotaInput
          amount={quotaAmount}
          unit={quotaUnit}
          onAmount={(value) => {
            setQuotaTouched(true);
            setQuotaAmount(value);
          }}
          onUnit={(value) => {
            setQuotaTouched(true);
            setQuotaUnit(value);
          }}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Изменение ящика                                                      */
/* ------------------------------------------------------------------ */

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: MailUser;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const initial = splitQuota(user.quotaBytes);
  const [quotaAmount, setQuotaAmount] = useState(String(initial.amount));
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>(initial.unit);
  const quotaBytes = quotaToBytes(quotaAmount, quotaUnit);
  const displayNameProblem = displayNameLengthProblem(displayName);

  /*
   * Нетронутая квота уходит на сервер БАЙТ В БАЙТ.
   *
   * Поля показывают число и единицу, а некруглое значение в них не
   * помещается: splitQuota округляет до двух знаков (иначе в поле стояло
   * бы «1.3969838619232178 ГБ»). Обратный перевод даёт другое число —
   * 1 500 000 000 байт превращаются в 1 503 238 554.
   *
   * Из-за этого правка ЛЮБОГО другого поля молча меняла квоту: человек
   * поправил отображаемое имя, нажал «Сохранить» — и ящику досталось на
   * три мегабайта больше, чем было. Он к квоте не прикасался.
   *
   * Некруглые квоты — не редкость: их ставят из CSV при импорте, через
   * API и при переносе с чужого сервера. Поэтому отправляем то, что
   * набрано, только если человек действительно набирал.
   */
  const quotaUntouched = quotaAmount === String(initial.amount) && quotaUnit === initial.unit;
  const quotaToSend = quotaUntouched ? user.quotaBytes : quotaBytes;

  const save = useMutation({
    mutationFn: () =>
      api.updateUser(user.id, {
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        ...(quotaToSend !== null ? { quotaBytes: quotaToSend } : {}),
      }),
    onSuccess: () => onSaved(`Ящик ${user.email} изменён`),
  });

  return (
    <Modal
      title={`Ящик ${user.email}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={save.isPending || quotaBytes === null || displayNameProblem !== null}
            onClick={() => save.mutate()}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <ErrorNotice error={save.error} />
      <Field label="Отображаемое имя" {...(displayNameProblem ? { hint: displayNameProblem } : {})}>
        <input
          className="mt-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Field>
      <Field
        label="Квота"
        hint={
          quotaBytes === null
            ? 'Введите число, а единицу выберите рядом. 0 — без ограничения.'
            : quotaUntouched
              ? `Сейчас ${formatBytes(user.quotaBytes)} — останется как есть`
              : `Сейчас ${formatBytes(user.quotaBytes)}, станет ${formatBytes(quotaBytes)}`
        }
      >
        <QuotaInput
          amount={quotaAmount}
          unit={quotaUnit}
          onAmount={setQuotaAmount}
          onUnit={setQuotaUnit}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Смена пароля                                                         */
/* ------------------------------------------------------------------ */

function PasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: MailUser;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [passwordShown, setPasswordShown] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.setUserPassword(user.id, password || undefined),
    onSuccess: (result) => {
      if (result.generatedPassword) setGenerated(result.generatedPassword);
      else {
        onDone(`Пароль ящика ${user.email} изменён`);
        onClose();
      }
    },
  });

  return (
    <Modal
      title={`Пароль ящика ${user.email}`}
      onClose={() => {
        if (generated) onDone(`Пароль ящика ${user.email} изменён`);
        onClose();
      }}
      footer={
        generated ? (
          <Button
            onClick={() => {
              onDone(`Пароль ящика ${user.email} изменён`);
              onClose();
            }}
          >
            Понятно
          </Button>
        ) : (
          <>
            <Button mode="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button disabled={change.isPending} onClick={() => change.mutate()}>
              Сменить пароль
            </Button>
          </>
        )
      }
    >
      <ErrorNotice error={change.error} />
      {generated ? (
        <>
          <Notice tone="info">Пароль показывается один раз — передайте его владельцу ящика.</Notice>
          <Field label="Новый пароль">
            <input className="mt-input mt-mono" readOnly value={generated} />
          </Field>
        </>
      ) : (
        <Field label="Новый пароль" hint="Пусто — сгенерируем сами (не короче 8 символов)">
          {/*
            Пароль набирается скрытым, с кнопкой «Показать».

            Здесь он набирался открытым текстом — в отличие от соседнего
            окна создания ящика, где это уже исправлено и объяснено. А
            пароль в панели набирают ровно в той обстановке, где рядом
            люди: администратор подошёл к столу сотрудника, чтобы завести
            ему доступ, или показывает экран на совещании. Строку,
            которая пускает в чужую переписку, не выводят на общий обзор.
          */}
          <div className="mt-input-with-action">
            <input
              className="mt-input mt-mono"
              type={passwordShown ? 'text' : 'password'}
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button
              mode="secondary"
              onClick={() => setPasswordShown((shown) => !shown)}
              title={passwordShown ? 'Скрыть пароль' : 'Показать пароль'}
            >
              {passwordShown ? 'Скрыть' : 'Показать'}
            </Button>
          </div>
        </Field>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Массовые операции                                                    */
/* ------------------------------------------------------------------ */

type BulkMode = 'quota' | 'block' | 'unblock' | 'delete';

function BulkModal({
  ids,
  emails,
  canDelete,
  onClose,
  onDone,
}: {
  ids: number[];
  /** Адреса выбранных ящиков — их показывает подтверждение удаления. */
  emails: string[];
  canDelete: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<BulkMode>('quota');
  const [quotaAmount, setQuotaAmount] = useState('1');
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>(DEFAULT_QUOTA_UNIT);
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const quotaBytes = quotaToBytes(quotaAmount, quotaUnit);

  const deleteReady = confirm.trim().toLowerCase() === 'удалить';

  /** Сколько ящиков уходит на сервер за один запрос — см. BULK_MAX_IDS. */
  const BULK_CHUNK = 200;

  /** Сколько уже сделано — длинная правка не должна выглядеть зависанием. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** Первые причины отказов: без них «не удалось — 7» ничего не объясняет. */
  const [reasons, setReasons] = useState<string[]>([]);

  const run = useMutation({
    mutationFn: async () => {
      setProgress({ done: 0, total: ids.length });
      setReasons([]);
      const failures: string[] = [];
      const noteFailure = (id: number, err: unknown): void => {
        /*
         * ПРИЧИНЫ ОТКАЗОВ НАЗЫВАЮТСЯ, А НЕ СЧИТАЮТСЯ.
         *
         * Здесь стоял пустой catch: человек читал «не удалось — 7» и не
         * мог ни понять, что случилось, ни повторить с толком. А причины
         * бывают разные и требуют разного: у одного ящика есть
         * незавершённое удаление, у другого не отвечает Dovecot, третий
         * уже удалён из соседней вкладки. Показываем первые три — этого
         * хватает, чтобы понять, общая беда или частная.
         */
        if (failures.length < 3) {
          const text = err instanceof Error ? err.message : String(err);
          failures.push(`${String(id)}: ${text}`);
        }
      };

      if (mode === 'delete') {
        /*
         * Массового удаления на сервере нет, и заводить его ради этого не
         * стоит: удаление ящика делает много всего (карантин каталога,
         * чистка Dovecot, запись об удалении), и честнее делать это по
         * одному. Ошибка на одном ящике не отменяет остальные.
         */
        let removed = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            await api.deleteUser(id, reason.trim() || undefined);
            removed += 1;
          } catch (err) {
            failed += 1;
            noteFailure(id, err);
          }
          setProgress({ done: removed + failed, total: ids.length });
        }
        setReasons(failures);
        return { changed: removed, failed };
      }

      /*
       * ПРАВКА ИДЁТ ЧАСТЯМИ.
       *
       * Тысяча ящиков одним запросом не укладывалась в таймаут прокси
       * (сто двадцать секунд): соединение рвалось, панель показывала
       * «сервер не ответил», а правка на сервере продолжалась — и было
       * непонятно ни сколько успело примениться, ни можно ли повторить.
       * Сервер теперь принимает не больше двухсот за раз (BULK_MAX_IDS),
       * а счётчик ниже показывает ход.
       */
      let changed = 0;
      let failed = 0;
      for (let from = 0; from < ids.length; from += BULK_CHUNK) {
        const part = ids.slice(from, from + BULK_CHUNK);
        try {
          const result = await api.bulkUsers({
            ids: part,
            ...(mode === 'quota' && quotaBytes !== null ? { quotaBytes } : {}),
            ...(mode === 'block' ? { active: false } : {}),
            ...(mode === 'unblock' ? { active: true } : {}),
          });
          changed += result.changed;
          failed += part.length - result.changed;
        } catch (err) {
          failed += part.length;
          noteFailure(part[0] ?? 0, err);
        }
        setProgress({ done: Math.min(from + part.length, ids.length), total: ids.length });
      }
      setReasons(failures);
      return { changed, failed };
    },
    onSuccess: (result) => {
      const what = mode === 'delete' ? 'Удалено' : 'Изменено';
      const tail = result.failed > 0 ? `, не удалось — ${result.failed}` : '';
      onDone(`${what} ${pluralize(result.changed, 'ящик', 'ящика', 'ящиков')}${tail}`);
    },
  });

  const blocked =
    run.isPending ||
    (mode === 'quota' && quotaBytes === null) ||
    (mode === 'delete' && !deleteReady);

  return (
    <Modal
      title={`Массовая операция над ${pluralize(ids.length, 'ящиком', 'ящиками', 'ящиками')}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={blocked} onClick={() => run.mutate()}>
            {run.isPending
              ? mode === 'delete'
                ? 'Удаляем…'
                : 'Применяем…'
              : mode === 'delete'
                ? `Удалить ${pluralize(ids.length, 'ящик', 'ящика', 'ящиков')}`
                : 'Применить'}
          </Button>
        </>
      }
    >
      <ErrorNotice error={run.error} />
      {/*
        Ход длинной правки. Тысяча ящиков идёт частями по двести, и без
        этой строки окно выглядело бы зависшим ровно столько, сколько
        занимает вся работа.
      */}
      {run.isPending && progress !== null && progress.total > BULK_CHUNK && (
        <Notice tone="info">
          Обработано {progress.done} из {progress.total}. Не закрывайте окно.
        </Notice>
      )}
      {reasons.length > 0 && (
        <Notice tone="error">
          Не удалось изменить часть ящиков. Причины (первые {reasons.length}):
          <ul>
            {reasons.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </Notice>
      )}
      {mode === 'block' && (
        <Notice tone="error">
          {/*
            Массовая блокировка отдела — самый дорогой случай: почта всех
            этих людей начнёт отбиваться отказом «адреса не существует», и
            письма за период не восстановить ничем.
          */}
          Входящая почта {pluralize(ids.length, 'этого ящика', 'этих ящиков', 'этих ящиков')}{' '}
          перестанет приходить: отправители будут получать отказ «адреса не существует». Письма за
          время блокировки восстановить будет нечем — они нигде не сохраняются. Если нужно только
          закрыть доступ, а почту сохранить, смените пароль.
        </Notice>
      )}
      {mode === 'delete' && (
        <>
          <Notice tone="error">
            <strong>
              Будет удалено {pluralize(ids.length, 'ящик', 'ящика', 'ящиков')} — насовсем.
            </strong>
            <DeletionConsequences />
          </Notice>
          <Field label="Какие именно">
            <textarea
              className="mt-textarea mt-mono"
              readOnly
              style={{ minHeight: 80 }}
              value={emails.join('\n')}
            />
          </Field>
          <Field label="Причина" hint="Попадёт в журнал аудита и в запись об удалении.">
            <input
              className="mt-input"
              placeholder="Обращение №1234: сотрудники уволены"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Field
            label="Наберите «удалить», чтобы подтвердить"
            hint="Слово набирается руками нарочно: случайно нажать кнопку слишком легко."
          >
            <input
              className="mt-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </>
      )}
      <Field label="Что сделать">
        <select
          className="mt-select"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as BulkMode);
            setConfirm('');
          }}
        >
          <option value="quota">Сменить квоту</option>
          <option value="block">Заблокировать</option>
          <option value="unblock">Разблокировать</option>
          {canDelete && <option value="delete">Удалить ящики</option>}
        </select>
      </Field>
      {mode === 'quota' && (
        <Field
          label="Новая квота"
          hint={
            quotaBytes === null
              ? 'Введите число, а единицу выберите рядом. 0 — без ограничения.'
              : `У всех выбранных ящиков станет ${formatBytes(quotaBytes)}`
          }
        >
          <QuotaInput
            amount={quotaAmount}
            unit={quotaUnit}
            onAmount={setQuotaAmount}
            onUnit={setQuotaUnit}
          />
        </Field>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Вход в чужой ящик                                                    */
/* ------------------------------------------------------------------ */

/**
 * Вход в ящик прямо из его строки в списке.
 *
 * Раньше для этого был отдельный раздел, где нужный адрес приходилось
 * искать заново — руками, по памяти. Адрес здесь уже известен, поэтому
 * спрашивается только причина: она обязательна, попадает в журнал аудита
 * и видна владельцу ящика.
 */
function EnterMailboxModal({ user, onClose }: { user: MailUser; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  // Тот же порог, что и на сервере: причина короче пяти значащих
  // символов объяснением не является.
  const reasonReady = reason.replace(/\s+/gu, '').length >= 5;

  const enter = useMutation({
    mutationFn: () => api.mailboxEnter(user.email, reason.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mailbox-session'] });
      onClose();
      // navigate возвращает обещание: без void его отказ (а он бывает,
      // если уход со страницы отменён) не ловит никто.
      void navigate('/mailbox');
    },
  });

  return (
    <Modal
      title={`Войти в ящик ${user.email}`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={!reasonReady || enter.isPending} onClick={() => enter.mutate()}>
            {enter.isPending ? 'Входим…' : 'Войти в ящик'}
          </Button>
        </>
      }
    >
      <ErrorNotice error={enter.error} />
      <Field
        label="Причина входа"
        hint="Обязательное поле. Запись попадёт в журнал аудита, владелец ящика её увидит."
      >
        <input
          className="mt-input"
          autoFocus
          placeholder="Обращение №1234: письмо не пришло, проверяем доставку"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Notice tone="info">
        Отправлять письма от имени владельца нельзя. Флаг «прочитано» при просмотре не ставится —
        следов в ящике не остаётся.
      </Notice>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Удаление ящика                                                       */
/* ------------------------------------------------------------------ */

/**
 * Что именно исчезает вместе с ящиком. Список один и тот же в подтверждении
 * одного удаления и массового: цену действия надо видеть до, а не после.
 */
function DeletionConsequences() {
  return (
    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
      <li>все письма и папки; каталог почты уводится в карантин, а не стирается сразу</li>
      <li>алиасы, которые вели в этот ящик</li>
      <li>пароль и возможность войти — сразу, ещё до уборки каталога</li>
      <li>настройки ящика, правила и подписи</li>
    </ul>
  );
}

/**
 * Удаление одного ящика.
 *
 * Подтверждение — набранный руками адрес: строки в списке похожи друг на
 * друга, промахнуться на одну очень легко, а отменить удаление нельзя.
 * Само удаление на сервере устроено правильно (карантин каталога, чистка
 * Dovecot, запись об удалении) — здесь только доступ к нему.
 */
/**
 * Подтверждение блокировки — с настоящим последствием, а не «вы уверены?».
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ВАЖНО СКАЗАТЬ
 * ------------------------------------------------------------------
 * Блокировка не «приостанавливает» ящик и не копит почту. Карта Postfix
 * отбирает адрес по `AND active` (infra/postfix/conf/pgsql/
 * virtual_mailboxes.cf.template), то есть для внешнего мира ящик
 * ПЕРЕСТАЁТ СУЩЕСТВОВАТЬ: отправитель получает отказ «адреса не
 * существует», письмо к нему возвращается, и восстановить его потом
 * нечем — оно нигде не сохранялось.
 *
 * Именно поэтому окно, а не мгновенное действие: значок 26×26 стоит
 * вплотную к «Удалить», промах пальцем — обычное дело, а ожидание у
 * человека ровно обратное («пусть пока копится»). На массовой блокировке
 * отдела цена ошибки — вся входящая почта отдела за период.
 */
function BlockUserModal({
  user,
  pending,
  onClose,
  onConfirm,
}: {
  user: MailUser;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={`Заблокировать ${user.email}?`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending ? 'Блокируем…' : 'Заблокировать'}
          </Button>
        </>
      }
    >
      <Notice tone="error">
        Входящая почта перестанет приходить: отправители будут получать отказ «адреса не
        существует», и письма за время блокировки восстановить будет нечем — они нигде не
        сохраняются.
      </Notice>
      <p style={{ margin: '12px 0 0', lineHeight: 1.5 }}>
        Ящик и его письма останутся на месте, вход в почту закроется сразу — в том числе в уже
        открытых вкладках и почтовых программах. Разблокировка вернёт всё, кроме писем, которые
        отбились за это время.
      </p>
      <p style={{ margin: '10px 0 0', lineHeight: 1.5 }}>
        Если нужно только закрыть человеку доступ, а почту сохранить, — смените пароль: письма
        продолжат приходить в ящик.
      </p>
    </Modal>
  );
}

function DeleteUserModal({
  user,
  onClose,
  onDone,
}: {
  user: MailUser;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<UserDeleteResult | null>(null);

  const matches = confirm.trim().toLowerCase() === user.email.toLowerCase();

  const remove = useMutation({
    mutationFn: () => api.deleteUser(user.id, reason.trim() || undefined),
    onSuccess: (data) => setResult(data),
  });

  if (result) {
    const done = (): void => onDone(`Ящик ${user.email} удалён`);
    return (
      <Modal
        title={`Ящик ${user.email} удалён`}
        onClose={done}
        footer={<Button onClick={done}>Понятно</Button>}
      >
        <Notice tone="success">Ящик удалён, войти в него больше нельзя.</Notice>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Каталог почты:{' '}
            {result.mailDirQuarantined
              ? 'уведён в карантин — письма ещё можно вернуть'
              : result.mailDirMissing
                ? 'его уже не было'
                : 'остался на месте, уберите вручную'}
          </li>
          <li>
            Индексы Dovecot:{' '}
            {result.imapPurged ? 'очищены' : 'очистить не удалось, уберите вручную'}
          </li>
          <li>Записей в базе удалено: {result.dbRowsRemoved}</li>
        </ul>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Удалить ящик ${user.email}?`}
      onClose={onClose}
      footer={
        <>
          <Button mode="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={!matches || remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? 'Удаляем…' : 'Удалить ящик'}
          </Button>
        </>
      }
    >
      <ErrorNotice error={remove.error} />
      <Notice tone="error">
        <strong>Это действие не отменяется из панели.</strong>
        <DeletionConsequences />
      </Notice>
      <Field label="Причина" hint="Попадёт в журнал аудита и в запись об удалении.">
        <input
          className="mt-input"
          placeholder="Обращение №1234: сотрудник уволен"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Field
        label="Наберите адрес ящика, чтобы подтвердить"
        hint={
          confirm.trim() === '' || matches
            ? `Полностью: ${user.email}`
            : 'Пока не совпадает с адресом ящика.'
        }
      >
        <input
          className="mt-input mt-mono"
          autoFocus
          placeholder={user.email}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Карточка ящика                                                       */
/* ------------------------------------------------------------------ */

/**
 * Что в ящике: пересылки обеих сторон, сколько занято и сколько писем.
 *
 * Занятость спрашивается отдельным запросом и только при открытии
 * карточки: она считается служебным заходом в ящик по IMAP, то есть
 * стоит времени. Показывать её в списке из полусотни строк значило бы
 * пятьдесят таких заходов на каждое открытие страницы.
 */
function UserCardModal({ user, onClose }: { user: MailUser; onClose: () => void }) {
  const card = useQuery({ queryKey: ['user-card', user.id], queryFn: () => api.user(user.id) });
  const usage = useQuery({
    queryKey: ['user-usage', user.id],
    queryFn: () => api.userUsage(user.id),
    retry: false,
  });

  const aliases = card.data?.aliases ?? [];
  const used = usage.data?.available === true ? usage.data : null;

  return (
    <Modal
      title={`Ящик ${user.email}`}
      onClose={onClose}
      footer={
        <Button mode="secondary" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      <ErrorNotice error={card.error} />

      <Tiles>
        <Tile value={formatBytes(user.quotaBytes)} label="Квота" />
        <Tile
          value={usage.isLoading ? '…' : used === null ? 'неизвестно' : formatBytes(used.bytes)}
          label="Занято"
        />
        <Tile
          value={usage.isLoading ? '…' : used === null ? 'неизвестно' : String(used.messages)}
          label="Писем"
        />
      </Tiles>

      {used === null && !usage.isLoading && (
        <Notice tone="info">
          Занятость ящика измеряется служебным доступом Dovecot. Он не настроен или недоступен —
          цифры показать нечем, остальное в карточке от этого не зависит.
        </Notice>
      )}

      <Field label="Пересылки" hint="И те, что ведут в этот ящик, и те, что идут из него">
        {aliases.length === 0 ? (
          <span className="mt-muted">нет</span>
        ) : (
          <ul>
            {aliases.map((alias) => (
              <li key={alias.id} className="mt-mono">
                {alias.source} → {alias.destination}
                {!alias.active && <span className="mt-muted"> (выключен)</span>}
              </li>
            ))}
          </ul>
        )}
        {/*
          Список может быть неполным, и молчать об этом нельзя: рядом, в
          колонке «Алиасов», стоит полное число, и человек сравнивает.
          Одноразовых адресов у активного пользователя легко больше сотни —
          их заводят по одному на сайт.
        */}
        {card.data?.aliasesTruncated === true && (
          <span className="mt-muted">
            Показаны первые 100. Остальные — в разделе «Адреса» с отбором по этому ящику.
          </span>
        )}
      </Field>
    </Modal>
  );
}
