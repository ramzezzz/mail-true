/**
 * «Разбор ящика» — окно двух вопросов, на которые список писем ответить
 * не может: КТО мне пишет и КУДА делось место.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ОКНО, А НЕ РАЗДЕЛ НАСТРОЕК
 * ------------------------------------------------------------------
 * в привычных почтовых интерфейсах «Управление рассылками» лежит в настройках, и это стоит
 * человеку четырёх переходов: заметил мусор в списке — ушёл в настройки —
 * разобрал — вернулся искать, что изменилось. Разбор нужен ровно там, где
 * появляется желание разобрать, — над списком писем. Так же устроен
 * «Sweep» в Outlook: он живёт в панели действий, а не в параметрах.
 *
 * ------------------------------------------------------------------
 * ЧЕМ ЗАЩИЩЕНО МАССОВОЕ УДАЛЕНИЕ
 * ------------------------------------------------------------------
 * Ни одно действие отсюда не выполняется с первого нажатия. Нажатие
 * «Удалить все» открывает подтверждение, в котором стоят НАСТОЯЩИЕ числа,
 * посчитанные сервером по тому же отбору, который и уедет (сухой прогон,
 * `dryRun`). Уезжают письма в корзину — то есть возвратимо; куда именно,
 * написано в подтверждении.
 *
 * Отдельно: отписка и удаление — два разных нажатия. Отписка меняет
 * будущее, удаление — прошлое, и склеивать их в одну кнопку «разобраться»
 * значило бы делать человеку второе, когда он просил первое.
 */

import { useMemo, useState } from 'react';
import type { Folder } from '@mail-true/shared';
import { Button, Checkbox, Modal, Spinner } from '../components';
import { useMoveMessages } from '../api/queries';
import { useUiStore } from '../app/store';
import { actionErrorText, errorText } from '../lib/errorText';
import { folderTitle } from '../lib/folderNames';
import { cx } from '../lib/cx';
import {
  SWEEP_AGES,
  formatBytes,
  lastSeenText,
  messagesWord,
  type CleanupState,
  type HeavyMessage,
  type MailingGroup,
  type SweepRequest,
  type SweepResult,
} from './mailingsApi';
import {
  useCleanupState,
  useMailingsState,
  useSweepPreview,
  useSweepRun,
  useUnsubscribeMailing,
} from './useMailings';
import { IconArchive, IconFolder, IconRefresh, IconTrash, IconUnsubscribe } from './icons';
import styles from './MailboxReview.module.css';

export type ReviewTab = 'mailings' | 'space';

export interface MailboxReviewProps {
  onClose(): void;
  /** С какой вкладки открыть. */
  initialTab?: ReviewTab;
  /** Папки ящика — для выбора «в папку» и для человеческих названий. */
  folders: readonly Folder[];
}

/**
 * Что человек собирается сделать и что он об этом узнает ДО нажатия.
 *
 * Условия и заголовок лежат вместе намеренно: подтверждение обязано
 * называть то же самое действие, по которому посчитан отбор. Разъехаться
 * этим двум вещам нельзя — иначе в окне написано «удалить рассылку», а
 * уедет что-то другое.
 */
interface PendingSweep {
  title: string;
  /** Что именно произойдёт, словами: «уедут в корзину», «уедут в Архив». */
  what: string;
  request: Omit<SweepRequest, 'dryRun' | 'scanAt'>;
}

/** Доля 0..1 процентами. Меньше десятой доли процента — так и пишем. */
function sharePercent(share: number): string {
  const value = share * 100;
  return value < 0.1 ? '<0,1 %' : `${value.toFixed(value < 10 ? 1 : 0).replace('.', ',')} %`;
}

/* ------------------------------------------------------------------ */
/* Подтверждение                                                       */
/* ------------------------------------------------------------------ */

/**
 * Экран подтверждения массового действия.
 *
 * Пока сухой прогон не ответил, кнопка выполнения ВЫКЛЮЧЕНА: соглашаться
 * можно только на известное число. Это и есть главное обещание разбора —
 * «сначала числа, потом действие», — и держится оно здесь.
 */
function SweepConfirm({
  pending,
  preview,
  pendingPreview,
  previewError,
  running,
  onCancel,
  onRetry,
  onRun,
}: {
  pending: PendingSweep;
  preview: SweepResult | null;
  pendingPreview: boolean;
  /**
   * Отказ подсчёта. Раньше его не показывали вовсе: счёт падал, окно
   * оставалось с одним заголовком и мёртвой кнопкой «Убрать» — ни числа,
   * ни причины, ни что делать дальше. Человек, уже согласившийся на
   * массовое действие, видел пустоту и уходил перезагружать страницу.
   */
  previewError: string | null;
  running: boolean;
  onCancel(): void;
  onRetry(): void;
  onRun(): void;
}) {
  return (
    <div className={styles.confirm}>
      <h3 className={styles.confirmTitle}>{pending.title}</h3>
      {pendingPreview && (
        <p className={styles.confirmPending}>
          <Spinner size={16} /> Считаем, сколько писем это затронет…
        </p>
      )}
      {!pendingPreview && previewError !== null && (
        <p className={styles.confirmError} role="alert">
          {previewError}. Пока не посчитали, сколько писем это затронет, убирать нельзя.
        </p>
      )}
      {!pendingPreview && preview && preview.count === 0 && (
        <p className={styles.confirmCount}>Под эти условия не подходит ни одно письмо.</p>
      )}
      {!pendingPreview && preview && preview.count > 0 && (
        <>
          <p className={styles.confirmCount}>
            {pending.what}: <b>{messagesWord(preview.count)}</b>, {formatBytes(preview.bytes)}.
          </p>
          <ul className={styles.confirmDetails}>
            {preview.oldest && preview.newest && (
              <li>
                с {new Date(preview.oldest).toLocaleDateString('ru-RU')} по{' '}
                {new Date(preview.newest).toLocaleDateString('ru-RU')}
              </li>
            )}
            {/* Непрочитанное и помеченное называются отдельно: это ровно то,
                о чём человек пожалеет, если не заметит. */}
            {preview.unread > 0 && <li>из них непрочитанных: {String(preview.unread)}</li>}
            {preview.flagged > 0 && <li>из них с флажком: {String(preview.flagged)}</li>}
          </ul>
        </>
      )}
      <div className={styles.confirmActions}>
        <Button
          mode="primary"
          onClick={onRun}
          disabled={pendingPreview || running || !preview || preview.count === 0}
        >
          {running ? 'Убираем…' : 'Убрать'}
        </Button>
        {/* Повтор — рядом с отказом: сбой счёта чаще всего минутный
            (сервер перечитывает ящик), и уходить со страницы незачем. */}
        {previewError !== null && !pendingPreview && (
          <Button mode="secondary" onClick={onRetry} disabled={running}>
            Посчитать ещё раз
          </Button>
        )}
        <Button mode="secondary" onClick={onCancel} disabled={running}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Вкладка «Рассылки»                                                  */
/* ------------------------------------------------------------------ */

function MailingRow({
  group,
  folders,
  onSweep,
}: {
  group: MailingGroup;
  folders: readonly Folder[];
  onSweep(pending: PendingSweep): void;
}) {
  const unsubscribe = useUnsubscribeMailing();
  const [moveOpen, setMoveOpen] = useState(false);

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle} title={group.address}>
          {group.title}
          {group.kind === 'list' && <span className={styles.badge}>рассылка</span>}
        </div>
        <div className={styles.rowAddress}>{group.address}</div>
        <div className={styles.rowStats}>
          <b>{messagesWord(group.count)}</b>
          <span>{formatBytes(group.bytes)}</span>
          {group.quotaShare !== null && group.quotaShare >= 0.01 && (
            <span>{sharePercent(group.quotaShare)} ящика</span>
          )}
          {group.unread > 0 && <span>непрочитанных: {String(group.unread)}</span>}
          <span>последнее {lastSeenText(group.lastDate)}</span>
        </div>
      </div>
      <div className={styles.rowActions}>
        {/*
          «Отписаться» есть только там, где отписаться ЕСТЬ ЧЕМ. Кнопка,
          которая на половине рассылок отвечает «нечем», — это та самая
          мёртвая кнопка, от которых продукт избавляется.
        */}
        {group.canUnsubscribe && (
          <Button
            mode="secondary"
            size="s"
            before={<IconUnsubscribe />}
            onClick={() => unsubscribe.mutate(group.key)}
            disabled={unsubscribe.isPending}
            title={
              group.oneClick
                ? 'Отписка уйдёт запросом с сервера — ваш адрес отправителю не покажется'
                : 'Отписка уйдёт письмом или откроет страницу отправителя'
            }
          >
            {unsubscribe.isPending ? 'Отписываемся…' : 'Отписаться'}
          </Button>
        )}
        <Button
          mode="secondary"
          size="s"
          before={<IconTrash />}
          onClick={() =>
            onSweep({
              title: `Удалить письма «${group.title}»?`,
              what: 'Уедет в корзину',
              request: { groupKey: group.key, targetFolderId: 'trash' },
            })
          }
        >
          Удалить все
        </Button>
        <Button
          mode="secondary"
          size="s"
          before={<IconArchive />}
          onClick={() =>
            onSweep({
              title: `Оставить только последнее письмо «${group.title}»?`,
              what: 'Уедет в корзину',
              request: { groupKey: group.key, keepLatest: 1, targetFolderId: 'trash' },
            })
          }
          title="Всё, кроме самого свежего письма, уедет в корзину"
        >
          Кроме последнего
        </Button>
        {/*
          «В папку» раскрывается на месте, а не выпадающим меню: список
          папок бывает длинным, а окно и так прокручивается — второй
          прокручиваемый слой поверх первого промахивается мышью.
        */}
        <Button
          mode="secondary"
          size="s"
          before={<IconFolder />}
          onClick={() => setMoveOpen((v) => !v)}
        >
          В папку
        </Button>
      </div>
      {moveOpen && (
        <div className={styles.folderPicker}>
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className={styles.folderButton}
              onClick={() => {
                setMoveOpen(false);
                onSweep({
                  title: `Переложить письма «${group.title}» в «${folderTitle(folder)}»?`,
                  what: `Уедет в «${folderTitle(folder)}»`,
                  request: { groupKey: group.key, targetFolderId: folder.id },
                });
              }}
            >
              {folderTitle(folder)}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Вкладка «Свободное место»                                           */
/* ------------------------------------------------------------------ */

function QuotaBar({ cleanup }: { cleanup: CleanupState }) {
  const quota = cleanup.quota;
  if (!quota || quota.limitBytes <= 0) {
    return (
      <p className={styles.note}>
        Почтовый сервер не сообщает предел ящика — сказать, сколько места освободится в долях,
        нельзя. Размеры писем ниже настоящие.
      </p>
    );
  }
  const share = Math.min(1, quota.usedBytes / quota.limitBytes);
  return (
    <div className={styles.quota}>
      <div className={styles.quotaHead}>
        <span>
          Занято <b>{formatBytes(quota.usedBytes)}</b> из {formatBytes(quota.limitBytes)}
        </span>
        <span className={styles.quotaPercent}>{sharePercent(share)}</span>
      </div>
      <div className={styles.quotaTrack}>
        <div
          className={cx(styles.quotaFill, share > 0.9 && styles.quotaFillFull)}
          style={{ width: `${String(Math.max(share * 100, 0.5))}%` }}
        />
      </div>
      {/* Число берётся у почтового сервера, а не складывается из размеров
          писем: именно его человек видит в профиле, и обещание «столько
          освободится» должно быть выражено в тех же единицах. */}
      <p className={styles.quotaSource}>Считает сам почтовый сервер, а не мы</p>
    </div>
  );
}

function HeavyRow({
  message,
  checked,
  onToggle,
  folders,
}: {
  message: HeavyMessage;
  checked: boolean;
  onToggle(): void;
  folders: readonly Folder[];
}) {
  const folder = folders.find((f) => f.id === message.folderId);
  return (
    <li className={styles.heavyRow}>
      <Checkbox checked={checked} onChange={onToggle} label="" />
      <div className={styles.heavyMain}>
        <div className={styles.heavySubject}>{message.subject || '(без темы)'}</div>
        <div className={styles.heavyMeta}>
          {message.from.name ?? message.from.address}
          {' · '}
          {new Date(message.date).toLocaleDateString('ru-RU')}
          {folder ? ` · ${folderTitle(folder)}` : ''}
          {!message.seen && ' · непрочитанное'}
          {message.flagged && ' · с флажком'}
        </div>
      </div>
      <div className={styles.heavySize}>{formatBytes(message.size)}</div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Окно целиком                                                        */
/* ------------------------------------------------------------------ */

export function MailboxReview({ onClose, initialTab = 'mailings', folders }: MailboxReviewProps) {
  const [tab, setTab] = useState<ReviewTab>(initialTab);
  const [onlyMailings, setOnlyMailings] = useState(true);
  const [pending, setPending] = useState<PendingSweep | null>(null);
  const [checkedHeavy, setCheckedHeavy] = useState<ReadonlySet<string>>(new Set());
  const [ageDays, setAgeDays] = useState<number>(365);
  const [keepUnread, setKeepUnread] = useState(true);
  const [keepFlagged, setKeepFlagged] = useState(true);

  const mailings = useMailingsState(tab === 'mailings');
  const cleanup = useCleanupState(tab === 'space');
  const previewMutation = useSweepPreview();
  const runMutation = useSweepRun();
  const moveMessages = useMoveMessages();
  const showNotice = useUiStore((s) => s.showNotice);

  /** Отметка разбора, которую человек сейчас видит. */
  const scanAt = tab === 'space' ? cleanup.data.at : mailings.data.at;

  const startSweep = (next: PendingSweep): void => {
    setPending(next);
    previewMutation.reset();
    previewMutation.mutate({ ...next.request, scanAt });
  };

  /** Повторный подсчёт для того же отбора — после отказа сервера. */
  const retryPreview = (): void => {
    if (!pending) return;
    previewMutation.reset();
    previewMutation.mutate({ ...pending.request, scanAt });
  };

  const runSweep = (): void => {
    if (!pending) return;
    runMutation.mutate(
      { ...pending.request, scanAt },
      {
        onSuccess: () => {
          setPending(null);
          setCheckedHeavy(new Set());
        },
      },
    );
  };

  /** Отбор для показа: рассылки или вообще все, кто пишет. */
  const groups = useMemo(
    () => mailings.data.groups.filter((g) => (onlyMailings ? g.mailing : true)),
    [mailings.data.groups, onlyMailings],
  );

  const heavyChosen = cleanup.data.heaviest.filter((m) => checkedHeavy.has(m.id));
  const heavyBytes = heavyChosen.reduce((sum, m) => sum + m.size, 0);

  /** Папки, куда имеет смысл перекладывать: без корзины и черновиков. */
  const moveTargets = folders.filter(
    (f) => f.role !== 'trash' && f.role !== 'drafts' && f.role !== 'snoozed',
  );

  const deleteHeavy = (): void => {
    if (heavyChosen.length === 0) return;
    moveMessages.mutate(
      { ids: heavyChosen.map((m) => m.id), targetFolderId: 'trash' },
      {
        onSuccess: (result) => {
          setCheckedHeavy(new Set());
          showNotice(`Убрали в корзину: ${messagesWord(result.moved)}, ${formatBytes(heavyBytes)}`);
        },
      },
    );
  };

  const loading = tab === 'mailings' ? mailings.isPending : cleanup.isPending;
  const failure = tab === 'mailings' ? mailings.error : cleanup.error;
  const state = tab === 'mailings' ? mailings.data : cleanup.data;

  return (
    <Modal title="Разбор ящика" onClose={onClose} className={styles.modal}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'mailings'}
          className={cx(styles.tab, tab === 'mailings' && styles.tabActive)}
          onClick={() => setTab('mailings')}
        >
          Кто мне пишет
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'space'}
          className={cx(styles.tab, tab === 'space' && styles.tabActive)}
          onClick={() => setTab('space')}
        >
          Свободное место
        </button>
        <div className={styles.tabsSpacer} />
        <Button
          mode="tertiary"
          size="s"
          before={<IconRefresh />}
          onClick={mailings.refresh}
          disabled={mailings.isFetching || cleanup.isFetching}
        >
          Обновить
        </Button>
      </div>

      {pending ? (
        <SweepConfirm
          pending={pending}
          preview={previewMutation.data ?? null}
          pendingPreview={previewMutation.isPending}
          previewError={
            previewMutation.isError
              ? actionErrorText('Не удалось посчитать отбор', previewMutation.error)
              : null
          }
          running={runMutation.isPending}
          onCancel={() => setPending(null)}
          onRetry={retryPreview}
          onRun={runSweep}
        />
      ) : (
        <>
          {loading && (
            <div className={styles.centered}>
              <Spinner />
              <p className={styles.note}>Смотрим ящик целиком — это дольше, чем открыть папку.</p>
            </div>
          )}

          {!loading && failure !== null && failure !== undefined && (
            <p className={styles.error}>Не удалось разобрать ящик. {errorText(failure)}</p>
          )}

          {!loading && !failure && (
            <>
              <p className={styles.scanNote}>
                Осмотрено {messagesWord(state.scanned)} из {String(state.total)}
                {state.truncated && (
                  <>
                    {' '}
                    — <b>это не весь ящик</b>: разбор смотрит не больше {String(state.limit)} писем
                    за раз, начиная со свежих. Числа ниже относятся к осмотренной части.
                  </>
                )}
              </p>

              {tab === 'mailings' ? (
                <>
                  <label className={styles.filter}>
                    <Checkbox
                      checked={onlyMailings}
                      onChange={() => setOnlyMailings((v) => !v)}
                      label="Только рассылки"
                    />
                    <span className={styles.filterHint}>
                      Рассылка — это письмо с адресом отписки или с признаком списка. Снимите
                      галочку, чтобы увидеть всех, кто вам пишет.
                    </span>
                  </label>

                  {groups.length === 0 ? (
                    <p className={styles.note}>
                      {onlyMailings
                        ? 'Рассылок в ящике не нашлось — разбирать нечего.'
                        : 'В ящике нет писем.'}
                    </p>
                  ) : (
                    <ul className={styles.list}>
                      {groups.map((group) => (
                        <MailingRow
                          key={group.key}
                          group={group}
                          folders={moveTargets}
                          onSweep={startSweep}
                        />
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <QuotaBar cleanup={cleanup.data} />

                  <section className={styles.section}>
                    <h3 className={styles.sectionTitle}>Что занимает место</h3>
                    <ul className={styles.folderStats}>
                      {cleanup.data.folders
                        .filter((f) => f.scanned > 0)
                        .map((f) => {
                          const folder = folders.find((x) => x.id === f.folderId);
                          return (
                            <li key={f.folderId}>
                              <span>{folder ? folderTitle(folder) : f.name}</span>
                              <span className={styles.folderStatValue}>
                                {messagesWord(f.scanned)} · {formatBytes(f.bytes)}
                              </span>
                            </li>
                          );
                        })}
                    </ul>
                  </section>

                  <section className={styles.section}>
                    <h3 className={styles.sectionTitle}>Убрать всё старое разом</h3>
                    <div className={styles.sweepForm}>
                      <select
                        className={styles.select}
                        value={String(ageDays)}
                        aria-label="Возраст писем"
                        onChange={(e) => setAgeDays(Number(e.target.value))}
                      >
                        {SWEEP_AGES.map((age) => (
                          <option key={age.days} value={String(age.days)}>
                            Письма {age.title}
                          </option>
                        ))}
                      </select>
                      <Checkbox
                        checked={keepUnread}
                        onChange={() => setKeepUnread((v) => !v)}
                        label="Оставить непрочитанные"
                      />
                      <Checkbox
                        checked={keepFlagged}
                        onChange={() => setKeepFlagged((v) => !v)}
                        label="Оставить с флажком"
                      />
                      <Button
                        mode="secondary"
                        before={<IconTrash />}
                        onClick={() =>
                          startSweep({
                            title: `Убрать письма ${
                              SWEEP_AGES.find((a) => a.days === ageDays)?.title ?? ''
                            }?`,
                            what: 'Уедет в корзину',
                            request: {
                              olderThanDays: ageDays,
                              keepUnread,
                              keepFlagged,
                              targetFolderId: 'trash',
                            },
                          })
                        }
                      >
                        Посчитать и убрать
                      </Button>
                    </div>
                    <p className={styles.note}>
                      Корзина, черновики и отложенные письма не убираются никогда — ни при каких
                      условиях.
                    </p>
                  </section>

                  <section className={styles.section}>
                    <h3 className={styles.sectionTitle}>Самые тяжёлые письма</h3>
                    {cleanup.data.heaviest.length === 0 ? (
                      <p className={styles.note}>Тяжёлых писем не нашлось.</p>
                    ) : (
                      <>
                        <ul className={styles.heavyList}>
                          {cleanup.data.heaviest.map((message) => (
                            <HeavyRow
                              key={message.id}
                              message={message}
                              folders={folders}
                              checked={checkedHeavy.has(message.id)}
                              onToggle={() =>
                                setCheckedHeavy((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(message.id)) next.delete(message.id);
                                  else next.add(message.id);
                                  return next;
                                })
                              }
                            />
                          ))}
                        </ul>
                        {/* Кнопка называет число и место ДО нажатия — то же
                            правило, что и у остальной уборки. */}
                        <Button
                          mode="secondary"
                          before={<IconTrash />}
                          disabled={heavyChosen.length === 0 || moveMessages.isPending}
                          onClick={deleteHeavy}
                        >
                          {heavyChosen.length === 0
                            ? 'Выберите письма'
                            : `Убрать в корзину: ${messagesWord(heavyChosen.length)}, ${formatBytes(heavyBytes)}`}
                        </Button>
                      </>
                    )}
                  </section>

                  {cleanup.data.staleMailings.length > 0 && (
                    <section className={styles.section}>
                      <h3 className={styles.sectionTitle}>Рассылки, которые давно молчат</h3>
                      <ul className={styles.list}>
                        {cleanup.data.staleMailings.map((group) => (
                          <MailingRow
                            key={group.key}
                            group={group}
                            folders={moveTargets}
                            onSweep={startSweep}
                          />
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
