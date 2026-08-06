/**
 * Спам: что фильтр сделал, по каким правилам и как это изменить.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ СЮДА ПРИХОДЯТ
 * ------------------------------------------------------------------
 * Не «посмотреть статистику». Приходят с одним из трёх вопросов:
 *
 *   • «письмо от партнёра ушло в спам» → разрешить отправителя и обучить
 *     фильтр на этом письме;
 *   • «нас заваливают с этого домена» → запретить домен;
 *   • «а фильтр вообще работает?» → цифры за период и последние письма.
 *
 * Экран построен под эти три, а не под полноту показа: сверху числа,
 * дальше списки с добавлением в одну строку, внизу разбор письма.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ЧЕСТНО СКАЗАНО ВСЛУХ
 * ------------------------------------------------------------------
 * 1. Числа «за период» считаются по снимкам счётчиков, а сами счётчики
 *    обнуляются при перезапуске rspamd. Число перезапусков показывается
 *    рядом: без него провал на графике выглядел бы как затишье.
 * 2. Топ правил — с момента запуска процесса, а НЕ за выбранный период.
 *    Другого источника у rspamd нет.
 * 3. Пороги показаны, но кнопки «сохранить» нет: контроллер rspamd их
 *    менять не даёт, а обходной путь завёл бы второй источник истины.
 *    Вместо кнопки — точный путь к файлу и команда применения.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type { SpamList } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { Table, TableWrap, tableStyles } from '../components/Table';
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
import { formatBytes, formatDateTime, plural } from '../lib/format';
import styles from './SpamPage.module.css';

/** Сколько времени назад, словами. Для «работает N» у самого rspamd. */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0)
    return `${String(days)} ${plural(days, 'сутки', 'суток', 'суток')} ${String(hours)} ч`;
  if (hours > 0) return `${String(hours)} ч ${String(minutes)} мин`;
  return `${String(minutes)} мин`;
}

/** Подпись поля ввода записи — своя у каждого вида списка. */
export function entryPlaceholder(value: SpamList['value']): string {
  if (value === 'address') return 'ivan@partner.example';
  if (value === 'domain') return 'partner.example';
  return '203.0.113.7 или 203.0.113.0/24';
}

/* ------------------------------------------------------------------ */
/* Один список                                                          */
/* ------------------------------------------------------------------ */

function ListPanel({ list, canEdit }: { list: SpamList; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['spam-lists'] });
  };

  const add = useMutation({
    mutationFn: (entry: string) => api.spamListAdd(list.id, entry),
    onSuccess: (result) => {
      setValue('');
      setError(null);
      setMessage(
        result.changed
          ? 'Запись добавлена; фильтр подхватит её в течение десяти секунд'
          : 'Такая запись здесь уже есть — ничего не изменилось',
      );
      invalidate();
    },
    onError: (err) => {
      setError(err);
      setMessage(null);
    },
  });

  const remove = useMutation({
    mutationFn: (entry: string) => api.spamListRemove(list.id, entry),
    onSuccess: () => {
      setError(null);
      setMessage('Запись убрана');
      invalidate();
    },
    onError: (err) => {
      setError(err);
      setMessage(null);
    },
  });

  const editable = list.editable && canEdit;

  return (
    <Panel title={list.title}>
      <p className={styles.hint}>
        {/* Что реально произойдёт с письмом — числом, а не словом
            «важный»: администратор должен видеть цену решения. */}
        <Badge tone={list.tone === 'allow' ? 'ok' : 'fail'}>
          {list.score > 0 ? `+${String(list.score)}` : String(list.score)} балла
        </Badge>{' '}
        {list.hint}
      </p>

      {list.problem && <Notice tone="error">{list.problem}</Notice>}

      {editable && (
        <form
          className={styles.addRow}
          onSubmit={(event) => {
            event.preventDefault();
            const entry = value.trim();
            if (entry !== '') add.mutate(entry);
          }}
        >
          <input
            className={`mt-input ${styles.addInput}`}
            value={value}
            placeholder={entryPlaceholder(list.value)}
            aria-label={`Добавить в список «${list.title}»`}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" size="s" disabled={value.trim() === '' || add.isPending}>
            {add.isPending ? 'Добавляем…' : 'Добавить'}
          </Button>
        </form>
      )}

      {!list.editable && (
        // Отключённой кнопки без объяснения здесь нет: причина уже
        // напечатана в подсказке списка выше.
        <p className={styles.readonly}>Только чтение.</p>
      )}
      {list.editable && !canEdit && (
        <p className={styles.readonly}>
          Изменение списков доступно роли с правом на настройку доменов.
        </p>
      )}

      <ErrorNotice error={error} />
      {message && <Notice tone="success">{message}</Notice>}

      {list.entries.length === 0 ? (
        <p className={styles.empty}>Список пуст.</p>
      ) : (
        <ul className={styles.entries}>
          {list.entries.map((entry) => (
            <li key={entry} className={styles.entry}>
              <span className={styles.entryValue}>{entry}</span>
              {editable && (
                <button
                  type="button"
                  className={styles.entryRemove}
                  disabled={remove.isPending}
                  title={`Убрать ${entry}`}
                  onClick={() => remove.mutate(entry)}
                >
                  Убрать
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className={styles.file}>
        Символ {list.symbol}, файл infra/rspamd/maps.d/{list.file}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Разбор письма и обучение                                             */
/* ------------------------------------------------------------------ */

function MessageTools({ canLearn }: { canLearn: boolean }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [as, setAs] = useState<'outside' | 'own'>('outside');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const check = useMutation({
    mutationFn: () => api.spamCheck(text, as),
    onSuccess: () => {
      setError(null);
      setNote(null);
    },
    onError: (err) => setError(err),
  });

  const learn = useMutation({
    mutationFn: (kind: 'spam' | 'ham') => api.spamLearn(text, kind),
    onSuccess: (result) => {
      setError(null);
      setNote(result.note);
      // Обучение меняет счётчик «обучено вручную» в сводке
      void queryClient.invalidateQueries({ queryKey: ['spam-overview'] });
    },
    onError: (err) => {
      setError(err);
      setNote(null);
    },
  });

  const ready = text.trim().length > 20;
  const verdict = check.data;

  return (
    <Panel title="Разобрать письмо">
      <p className={styles.hint}>
        Вставьте письмо целиком — вместе с заголовками (в веб-интерфейсе это «Показать оригинал», в
        почтовой программе — «Показать исходный текст»). Проверка ничего не меняет: письмо никуда не
        доставляется и ничему не обучает.
      </p>

      <textarea
        className={`mt-input ${styles.message}`}
        value={text}
        rows={8}
        placeholder={'Received: from ...\nFrom: ...\nSubject: ...\n\nтекст письма'}
        aria-label="Письмо целиком"
        onChange={(event) => setText(event.target.value)}
      />

      <Toolbar>
        <select
          className={`mt-select ${styles.control}`}
          value={as}
          onChange={(event) => setAs(event.target.value as 'outside' | 'own')}
          aria-label="От чьего имени проверять"
        >
          <option value="outside">как письмо извне</option>
          <option value="own">как письмо своего пользователя</option>
        </select>
        <Button size="s" disabled={!ready || check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? 'Проверяем…' : 'Проверить'}
        </Button>
        <ToolbarSpacer />
        {canLearn && (
          <>
            <Button
              mode="secondary"
              size="s"
              disabled={!ready || learn.isPending}
              onClick={() => learn.mutate('spam')}
            >
              Это спам
            </Button>
            <Button
              mode="secondary"
              size="s"
              disabled={!ready || learn.isPending}
              onClick={() => learn.mutate('ham')}
            >
              Это не спам
            </Button>
          </>
        )}
      </Toolbar>

      {!canLearn && (
        <p className={styles.readonly}>
          Обучение фильтра доступно роли, управляющей пользователями: оно действует на всех.
        </p>
      )}

      <ErrorNotice error={error} />
      {note && <Notice tone="success">{note}</Notice>}

      {verdict && (
        <div className={styles.verdict}>
          <Tiles>
            <Tile value={verdict.score.toFixed(2)} label="баллов набрало письмо" />
            <Tile
              value={
                <Badge
                  tone={
                    verdict.action === 'reject'
                      ? 'fail'
                      : verdict.action === 'add header'
                        ? 'warn'
                        : 'ok'
                  }
                >
                  {verdict.actionTitle}
                </Badge>
              }
              label="решение фильтра"
            />
            {Object.entries(verdict.thresholds).map(([name, value]) => (
              <Tile
                key={name}
                value={value}
                label={
                  name === 'add header'
                    ? 'порог «в Спам»'
                    : name === 'reject'
                      ? 'порог отказа'
                      : `порог «${name}»`
                }
              />
            ))}
          </Tiles>
          {/* Пороги здесь — те, что применились ИМЕННО к этому письму: у
              своих аутентифицированных отправителей они мягче, и увидеть
              это можно только так. Отправитель показан отдельно: по нему
              работают списки, и подставился он из заголовка From. */}
          <p className={styles.hint}>{verdict.note}</p>

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Правило</th>
                  <th>Баллы</th>
                  <th>Что это значит</th>
                </tr>
              </thead>
              <tbody>
                {verdict.symbols.map((symbol) => (
                  <tr key={symbol.name}>
                    <td className={tableStyles.nowrap}>{symbol.name}</td>
                    <td className={tableStyles.nowrap}>
                      <span className={symbol.score > 0 ? styles.plus : styles.minus}>
                        {symbol.score > 0 ? `+${String(symbol.score)}` : String(symbol.score)}
                      </span>
                    </td>
                    <td>{symbol.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Страница                                                             */
/* ------------------------------------------------------------------ */

export function SpamPage() {
  const { session } = useSession();
  const [hours, setHours] = useState(24);
  const canEditLists = can(session?.permissions, 'domains.write');
  const canLearn = can(session?.permissions, 'users.write');
  const canReadHistory = can(session?.permissions, 'mailbox.impersonate');

  const overview = useQuery({
    queryKey: ['spam-overview', hours],
    queryFn: () => api.spamOverview(hours),
  });
  const lists = useQuery({ queryKey: ['spam-lists'], queryFn: () => api.spamLists() });
  const history = useQuery({
    queryKey: ['spam-history'],
    queryFn: () => api.spamHistory({ limit: 30 }),
    enabled: canReadHistory,
  });

  const data = overview.data;

  return (
    <>
      <PageTitle title="Спам" subtitle="Что отсеял фильтр, по каким правилам и как это изменить" />

      <Toolbar>
        <select
          className={`mt-select ${styles.control}`}
          value={hours}
          onChange={(event) => setHours(Number(event.target.value))}
          aria-label="За какое время"
        >
          <option value={1}>за час</option>
          <option value={24}>за сутки</option>
          <option value={24 * 7}>за неделю</option>
          <option value={24 * 30}>за месяц</option>
        </select>
        <ToolbarSpacer />
        <Button
          mode="secondary"
          size="s"
          disabled={overview.isFetching}
          onClick={() => void overview.refetch()}
        >
          {overview.isFetching ? 'Обновляем…' : 'Обновить'}
        </Button>
      </Toolbar>

      <ErrorNotice error={overview.error} />

      {data && !data.available && (
        <Notice tone="error">
          {data.unavailable ??
            'Антиспам не отвечает. Почта продолжает ходить, но без проверки на спам.'}
        </Notice>
      )}

      {data?.period && (
        <>
          <Tiles>
            <Tile value={data.period.scanned} label="писем проверено" />
            <Tile value={data.period.spam} label="признано спамом" />
            <Tile
              value={
                data.period.spamPercent === null ? '—' : `${String(data.period.spamPercent)} %`
              }
              label="доля спама"
            />
            <Tile value={data.period.reject} label="отклонено при приёме" />
            <Tile value={data.period.addHeader} label="уехало в папку «Спам»" />
            <Tile value={data.manualLearns.spam + data.manualLearns.ham} label="обучений вручную" />
          </Tiles>
          <p className={styles.note}>
            {data.periodNote}
            {data.period.restarts > 0 && (
              <>
                {' '}
                За это время антиспам перезапускали {data.period.restarts}{' '}
                {plural(data.period.restarts, 'раз', 'раза', 'раз')} — счётчики при этом начинались
                заново, и числа выше могут быть занижены.
              </>
            )}
            {data.period.samples === 0 && ' Снимков за это окно ещё нет.'}
          </p>
          <p className={styles.note}>{data.selfProbeNote}</p>
        </>
      )}

      {data && !data.period && <Notice tone="info">{data.periodNote}</Notice>}

      {/* Пороги. Кнопки сохранения нет намеренно — см. шапку файла. */}
      {data && (
        <Panel title="Пороги">
          <Tiles>
            {Object.entries(data.thresholds).map(([name, value]) => (
              <Tile
                key={name}
                value={value === null ? 'выключено' : value}
                label={
                  name === 'add header'
                    ? 'помечать как спам'
                    : name === 'reject'
                      ? 'отклонять приём'
                      : name === 'greylist'
                        ? 'серый список'
                        : name === 'rewrite subject'
                          ? 'менять тему'
                          : name
                }
              />
            ))}
          </Tiles>
          <p className={styles.note}>{data.thresholdsNote}</p>
          <p className={styles.note}>{data.settingsNote}</p>
        </Panel>
      )}

      {data?.live && (
        <Panel title="Состояние фильтра">
          <Tiles>
            <Tile value={data.live.version} label="версия rspamd" />
            <Tile value={formatUptime(data.live.uptimeSeconds)} label="работает без перезапуска" />
            <Tile value={data.live.scanned} label="проверено с запуска" />
            <Tile value={data.live.learned} label="обучено всего, включая автоматическое" />
          </Tiles>
          {data.live.bayes.length > 0 && (
            <p className={styles.note}>
              Классификатор:{' '}
              {data.live.bayes
                .map((file) => `${file.symbol} (${file.type}, версия ${String(file.revision)})`)
                .join(', ')}
              . Ручное обучение за период: спам — {data.manualLearns.spam}, не спам —{' '}
              {data.manualLearns.ham}.
            </p>
          )}
          {data.collectingSince && (
            <p className={styles.note}>
              Снимки счётчиков ведутся с {formatDateTime(data.collectingSince)} — за более ранний
              период чисел нет.
            </p>
          )}
        </Panel>
      )}

      {data && data.symbols.length > 0 && (
        <Panel title="Какие правила срабатывают чаще">
          <p className={styles.note}>{data.symbolsNote}</p>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Правило</th>
                  <th>Срабатываний</th>
                  <th>Вес</th>
                </tr>
              </thead>
              <tbody>
                {data.symbols.map((symbol) => (
                  <tr key={symbol.symbol}>
                    <td>{symbol.symbol}</td>
                    <td className={tableStyles.nowrap}>{symbol.hits}</td>
                    <td className={tableStyles.nowrap}>
                      <span className={symbol.weight > 0 ? styles.plus : styles.minus}>
                        {symbol.weight > 0 ? `+${String(symbol.weight)}` : String(symbol.weight)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      )}

      {/* Списки. Разрешающие и запрещающие рядом: их и правят вместе,
          разбирая одно и то же обращение. */}
      <ErrorNotice error={lists.error} />
      {lists.data && !lists.data.available && (
        <Notice tone="error">{lists.data.unavailable}</Notice>
      )}
      {lists.data && (
        <>
          <p className={styles.note}>{lists.data.note}</p>
          <div className={styles.lists}>
            {lists.data.items.map((list) => (
              <ListPanel key={list.id} list={list} canEdit={canEditLists} />
            ))}
          </div>
        </>
      )}

      <MessageTools canLearn={canLearn} />

      {/* Последние проверенные письма: в них видны темы и адреса, поэтому
          право то же, что у журналов почты. */}
      {canReadHistory && history.data && (
        <Panel title="Последние проверенные письма">
          <p className={styles.note}>{history.data.note}</p>
          {!history.data.available ? null : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Решение</th>
                    <th>Баллы</th>
                    <th>От кого</th>
                    <th>Тема</th>
                    <th>Почему</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.items.map((item) => (
                    <tr key={`${item.at}-${item.subject}-${item.sender}`}>
                      <td className={tableStyles.nowrap}>{formatDateTime(item.at)}</td>
                      <td className={tableStyles.nowrap}>
                        <Badge
                          tone={
                            item.action === 'reject'
                              ? 'fail'
                              : item.action === 'add header'
                                ? 'warn'
                                : 'ok'
                          }
                        >
                          {item.actionTitle}
                        </Badge>
                      </td>
                      <td className={tableStyles.nowrap}>{item.score.toFixed(1)}</td>
                      <td className={styles.wrapCell}>
                        {item.sender || '—'}
                        {item.user && <span className={styles.own}>свой</span>}
                      </td>
                      <td className={styles.wrapCell}>
                        {item.subject || '(без темы)'}
                        <span className={styles.size}>{formatBytes(item.sizeBytes)}</span>
                      </td>
                      <td className={styles.wrapCell}>
                        {item.symbols.length === 0
                          ? '—'
                          : item.symbols
                              .map(
                                (symbol) =>
                                  `${symbol.name} ${
                                    symbol.score > 0
                                      ? `+${String(symbol.score)}`
                                      : String(symbol.score)
                                  }`,
                              )
                              .join(', ')}
                      </td>
                    </tr>
                  ))}
                  {history.data.items.length === 0 && (
                    <tr>
                      <td className={styles.emptyCell} colSpan={6}>
                        Писем в памяти фильтра пока нет.
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Panel>
      )}
    </>
  );
}
