/**
 * Раздел «Одноразовые адреса».
 *
 * ------------------------------------------------------------------
 * ЧТО ЭТО РЕШАЕТ
 * ------------------------------------------------------------------
 * Человек регистрируется в магазине и не хочет отдавать основной адрес.
 * Он заводит здесь `shop-2026@свой-домен`, письма приходят в его же ящик,
 * а когда адрес начинает получать спам — выключает его одним нажатием.
 * Основной адрес при этом не трогается вовсе.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ГЛАВНОЕ ДЕЙСТВИЕ — ПЕРЕКЛЮЧАТЕЛЬ, А НЕ КОРЗИНА
 * ------------------------------------------------------------------
 * Соблазн сделать главной кнопкой «удалить» велик и вреден. Удалённое имя
 * освобождается, и его может занять другой человек — а магазин ещё год
 * шлёт письма на старый адрес, и они попадут ЧУЖОМУ. Поэтому корзина
 * стоит второй, под пояснением, а на виду — переключатель: выключенный
 * адрес продолжает занимать имя и никому не достанется.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ РЯДОМ С ЧИСЛАМИ ВСЕГДА НАПИСАНО ОКНО
 * ------------------------------------------------------------------
 * «Писем не приходило» и «в сохранившемся куске журнала писем нет» — это
 * разные утверждения, и второе нельзя показывать как первое: человек
 * прочитает ноль как «адрес чистый» и оставит работать проданный адрес.
 * Поэтому число всегда идёт со словами «за N суток», а когда журнала нет
 * вовсе — не показывается ни числа, ни нуля.
 */
import { useState } from 'react';
import { Button, IconButton, Modal, Spinner, Switch, TextField } from '../../components';
import { actionErrorText } from '../../lib/errorText';
import { cx } from '../../lib/cx';
import { IconTrash } from '../../mail/icons';
import {
  formatDay,
  formatMoment,
  plural,
  type DisposableAlias,
} from '../../settings/disposableApi';
import {
  useCreateDisposable,
  useDeleteDisposable,
  useDisposable,
  useSetDisposableActive,
} from '../../settings/disposableQueries';
import {
  SettingsEmpty,
  SettingsError,
  SettingsHint,
  SettingsLead,
  SettingsTitle,
} from '../../settings/ui';
import styles from './DisposablePage.module.css';

export function DisposablePage() {
  const { available, reason, items, domain, limit, used, loading } = useDisposable();
  const create = useCreateDisposable();
  const setActive = useSetDisposableActive();
  const remove = useDeleteDisposable();
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DisposableAlias | null>(null);

  const error = setActive.error ?? remove.error;
  const full = used >= limit;

  return (
    <>
      <SettingsTitle>Одноразовые адреса</SettingsTitle>
      <SettingsLead>
        Адрес, который можно отдать сайту вместо основного. Письма приходят в этот же ящик, а
        когда на адрес начинает идти спам — выключите его, и основная почта останется нетронутой.
      </SettingsLead>

      {!available && (
        <SettingsError>
          {reason ?? 'Одноразовые адреса сейчас недоступны — сервер их не отдал.'}
        </SettingsError>
      )}

      {available && loading && (
        <div className={styles.loading}>
          <Spinner size={22} />
        </div>
      )}

      {available && !loading && (
        <>
          {error && <SettingsError>{actionErrorText('Не получилось', error)}</SettingsError>}

          <div className={styles.toolbar}>
            <Button onClick={() => setCreating(true)} disabled={full}>
              Завести адрес
            </Button>
            <span className={styles.counter}>
              Занято {used} из {limit}
            </span>
          </div>

          {full && (
            <SettingsError>
              Больше {limit} адресов на ящик заводить нельзя. Удалите ненужные — выключенные тоже
              занимают место, потому что имя за ними остаётся.
            </SettingsError>
          )}

          {items.length === 0 && (
            <SettingsEmpty>
              Пока ни одного. Заведите адрес перед тем, как регистрироваться там, где не хотите
              оставлять основной.
            </SettingsEmpty>
          )}

          {items.length > 0 && (
            <ul className={styles.list}>
              {items.map((alias) => (
                <Row
                  key={alias.id}
                  alias={alias}
                  busy={setActive.isPending}
                  onToggle={(active) => setActive.mutate({ id: alias.id, active })}
                  onDelete={() => setConfirmDelete(alias)}
                />
              ))}
            </ul>
          )}

          <SettingsHint>
            Выключенный адрес не пропадает молча: сервер отвечает отправителю отказом сразу, на
            этапе приёма, — письмо не теряется и не лежит неделю в неизвестности. При этом отказ
            дословно совпадает с ответом на несуществующий адрес, поэтому по нему нельзя понять,
            что адрес когда-то был. Имя за выключенным адресом остаётся занятым: освободить его
            значило бы отдать другому человеку почту, которую на него ещё шлют.
          </SettingsHint>
        </>
      )}

      {creating && (
        <CreateDialog
          domain={domain}
          busy={create.isPending}
          error={create.isError ? create.error.message : null}
          onClose={() => {
            create.reset();
            setCreating(false);
          }}
          onSubmit={(draft) =>
            create.mutate(draft, {
              onSuccess: () => setCreating(false),
            })
          }
        />
      )}

      {confirmDelete && (
        <Modal
          title="Удалить адрес?"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(
                    { id: confirmDelete.id, address: confirmDelete.address },
                    { onSuccess: () => setConfirmDelete(null) },
                  )
                }
              >
                {remove.isPending ? 'Удаляем…' : 'Удалить'}
              </Button>
              <Button mode="secondary" disabled={remove.isPending} onClick={() => setConfirmDelete(null)}>
                Отменить
              </Button>
            </>
          }
        >
          <p className={styles.dialogText}>
            Адрес <b>{confirmDelete.address}</b> перестанет существовать, а его имя снова станет
            свободным — и его сможет занять другой человек этого сервера. Почта, которую на него
            ещё шлют, попадёт тогда не вам.
          </p>
          <p className={styles.dialogText}>
            Если нужно просто перестать получать письма, <b>выключите</b> адрес: имя останется за
            вами навсегда, а отправитель будет получать отказ.
          </p>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Строка списка                                                        */
/* ------------------------------------------------------------------ */

function Row({
  alias,
  busy,
  onToggle,
  onDelete,
}: {
  alias: DisposableAlias;
  busy: boolean;
  onToggle(active: boolean): void;
  onDelete(): void;
}) {
  const traffic = alias.traffic;
  return (
    <li className={cx(styles.row, !alias.active && styles.rowOff)}>
      <div className={styles.main}>
        <div className={styles.addressLine}>
          <span className={styles.address}>{alias.address}</span>
          {!alias.active && <span className={styles.badge}>выключен</span>}
        </div>

        {alias.note !== '' && <div className={styles.note}>{alias.note}</div>}

        <div className={styles.meta}>
          <span>Заведён {formatDay(alias.createdAt)}</span>
          {alias.disabledAt && <span>Выключен {formatDay(alias.disabledAt)}</span>}
        </div>

        {traffic && (
          <div className={styles.traffic}>
            {traffic.received === 0 && traffic.rejected === 0 ? (
              <span className={styles.quiet}>
                За {traffic.windowDays}{' '}
                {plural(traffic.windowDays, 'сутки', 'суток', 'суток')} писем не было
              </span>
            ) : (
              <>
                {traffic.received > 0 && (
                  <span>
                    {traffic.received}{' '}
                    {plural(traffic.received, 'письмо', 'письма', 'писем')} за {traffic.windowDays}{' '}
                    {plural(traffic.windowDays, 'сутки', 'суток', 'суток')}
                    {traffic.lastAt && `, последнее ${formatMoment(traffic.lastAt)}`}
                  </span>
                )}
                {/*
                 * Отказы показываются отдельной строкой и только когда они
                 * есть: «после выключения постучались ещё 40 раз» —
                 * это ответ на вопрос «правильно ли я его выключил».
                 */}
                {traffic.rejected > 0 && (
                  <span className={styles.rejected}>
                    Отклонено {traffic.rejected}{' '}
                    {plural(traffic.rejected, 'попытка', 'попытки', 'попыток')}
                  </span>
                )}
              </>
            )}

            {traffic.senders.length > 0 && (
              <div className={styles.senders}>
                Писали:{' '}
                {traffic.senders.map((s, i) => (
                  <span key={s.address}>
                    {i > 0 && ', '}
                    <span className={styles.sender}>{s.address}</span>
                    {s.count > 1 && ` (${s.count})`}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <Switch
          checked={alias.active}
          disabled={busy}
          onChange={(e) => onToggle(e.currentTarget.checked)}
          aria-label={alias.active ? `Выключить ${alias.address}` : `Включить ${alias.address}`}
        />
        <IconButton label={`Удалить ${alias.address}`} onClick={onDelete}>
          <IconTrash />
        </IconButton>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Окно создания                                                        */
/* ------------------------------------------------------------------ */

function CreateDialog({
  domain,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  domain: string;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onSubmit(draft: { name: string; note: string }): void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');

  return (
    <Modal
      title="Новый одноразовый адрес"
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={() => onSubmit({ name: name.trim(), note })}>
            {busy ? 'Заводим…' : 'Завести'}
          </Button>
          <Button mode="secondary" disabled={busy} onClick={onClose}>
            Отменить
          </Button>
        </>
      }
    >
      {error && <SettingsError>{error}</SettingsError>}

      <TextField
        label="Имя адреса"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        placeholder="shop-2026"
        hint={
          /*
           * Домен показан рядом с полем, а не подставлен в подсказку:
           * человек должен видеть адрес целиком до того, как нажмёт
           * «Завести», иначе он узнает его вид только из списка.
           */
          name.trim() === ''
            ? `Оставьте пустым — придумаем сами. Домен: @${domain}`
            : `Получится ${name.trim()}@${domain}`
        }
      />

      <TextField
        label="Кому выдаёте"
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
        placeholder="Магазин обуви"
        hint="Пометка для себя: через год по ней будет видно, кто продал адрес. Администратору она не показывается."
      />
    </Modal>
  );
}
