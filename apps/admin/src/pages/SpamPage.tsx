/**
 * Антиспам: что фильтр сделал, по каким правилам и как это изменить.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ СЮДА ПРИХОДЯТ
 * ------------------------------------------------------------------
 * Не «посмотреть статистику». Приходят с одним из четырёх вопросов:
 *
 *   • «письмо от партнёра ушло в спам» → разрешить отправителя и обучить
 *     фильтр на этом письме;
 *   • «нас заваливают с этого домена» → запретить домен;
 *   • «почему письмо признали спамом» → разобрать письмо, посмотреть
 *     пороги и сработавшие правила;
 *   • «а фильтр вообще работает?» → цифры за период и последние письма.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ВКЛАДКИ, А НЕ ОДНА ДЛИННАЯ СТРАНИЦА
 * ------------------------------------------------------------------
 * Раньше раздел был одним свитком: сводка, пороги, состояние, топ правил,
 * восемь списков подряд плитками, разбор письма и таблица писем. Списки
 * при этом были не таблицами, а столбиками строк с кнопкой «Убрать», без
 * поиска, — и на списке из сотни разрешённых адресов найти нужный можно
 * было только поиском по странице в браузере. Заказчик просил ровно этого:
 * таблицы на вкладках.
 *
 * Вкладки дают ещё одно, менее очевидное: измерение порогов профиля «свой
 * отправитель» стоит одного пробного письма через rspamd. На вкладке за
 * него платят только те, кто открыл пороги, а не каждый, кто зашёл в
 * раздел.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ЧЕСТНО СКАЗАНО ВСЛУХ
 * ------------------------------------------------------------------
 * 1. Числа «за период» считаются по снимкам счётчиков, а сами счётчики
 *    обнуляются при перезапуске rspamd. Число перезапусков показывается
 *    рядом: без него провал на графике выглядел бы как затишье.
 * 2. Топ правил — с момента запуска процесса, а НЕ за выбранный период.
 *    Другого источника у rspamd нет.
 * 3. Пороги показаны и объяснены, но кнопки «сохранить» нет: писать их
 *    некуда. Причина напечатана целиком, вместе с файлом, форматом строки
 *    и командой применения, — а не спрятана за отключённой кнопкой.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import { api } from '../api/client';
import type { SpamList, SpamThresholdItem, SpamThresholdProfile } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
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

/**
 * Поиск по списку — подстрокой и без учёта регистра.
 *
 * Именно подстрокой, а не «начинается с»: ищут обычно по домену внутри
 * адреса («кто у нас разрешён из partner.example»), и поиск по началу
 * строки на такой вопрос не отвечает вовсе.
 */
export function filterEntries(entries: readonly string[], search: string): string[] {
  const needle = search.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((entry) => entry.toLowerCase().includes(needle));
}

/** Вес правила со знаком: минус у разрешающих, плюс у запрещающих. */
export function scoreText(score: number): string {
  return score > 0 ? `+${String(score)}` : String(score);
}

/**
 * Счёт со словом: «+10 баллов», «-1 балл», «-2,5 балла».
 *
 * Слово «балла» было приписано к числу намертво, и списки показывали
 * «-10 балла» — то есть неграмотно ровно там, где администратор
 * взвешивает, чего стоит запись в списке.
 *
 * Дробный счёт склоняется в единственном числе родительного падежа
 * («-2,5 балла»), поэтому целое проверяется отдельно, а не через общий
 * счётчик: у 2,5 последняя цифра 5, и обычное правило дало бы «баллов».
 */
export function scoreWithWord(score: number): string {
  const text = scoreText(score);
  if (!Number.isInteger(score)) return `${text} балла`;
  return `${text} ${plural(score, 'балл', 'балла', 'баллов')}`;
}

/* ------------------------------------------------------------------ */
/* Вкладки                                                              */
/* ------------------------------------------------------------------ */

type TabId = 'summary' | 'thresholds' | 'lists' | 'check' | 'history';

function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  items: ReadonlyArray<{ id: T; title: string; count?: number }>;
  label: string;
}) {
  return (
    <div className={styles.tabs} role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          className={cx(styles.tab, value === item.id && styles.tabActive)}
          onClick={() => onChange(item.id)}
        >
          {item.title}
          {item.count !== undefined && <span className={styles.tabCount}>{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Пороги                                                               */
/* ------------------------------------------------------------------ */

/** Один рубеж строкой таблицы: число слева, последствия справа. */
function ThresholdRow({ item }: { item: SpamThresholdItem }) {
  const off = item.value === null;
  return (
    <tr>
      <td className={styles.wrapCell}>{item.title}</td>
      <td className={tableStyles.nowrap}>
        {off ? (
          <Badge tone="muted">выключено</Badge>
        ) : (
          <>
            <span className={styles.thresholdValue}>{item.value}</span>
            {/* «Необычно» — не ошибка, а повод перепроверить: коридор это
                мнение продукта, а не ограничение rspamd. */}
            {item.unusual && <Badge tone="warn">необычно</Badge>}
          </>
        )}
        {item.advice && (
          <span className={styles.advice}>
            обычно {item.advice[0]}–{item.advice[1]}
          </span>
        )}
      </td>
      <td className={styles.wrapCell}>
        <p className={styles.effect}>{off ? item.off : item.effect}</p>
        {!off && (
          <>
            <p className={styles.sub}>{item.visible}</p>
            {item.higher !== '—' && (
              <p className={styles.sub}>
                <span className={styles.subKey}>Поднять порог:</span> {item.higher}
              </p>
            )}
            {item.lower !== '—' && (
              <p className={styles.sub}>
                <span className={styles.subKey}>Опустить порог:</span> {item.lower}
              </p>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

function ThresholdProfilePanel({ profile }: { profile: SpamThresholdProfile }) {
  return (
    <Panel title={profile.title}>
      <p className={styles.hint}>{profile.note}</p>
      {profile.measured && (
        // Откуда числа — важно: измеренное пробным письмом может отличаться
        // от прочитанного у контроллера, и списывать разницу на ошибку
        // панели не надо.
        <p className={styles.note}>
          Числа получены прогоном пробного письма: профили настроек контроллер rspamd отдельно не
          показывает.
        </p>
      )}
      {profile.problem && <Notice tone="error">{profile.problem}</Notice>}

      {profile.warnings.length > 0 && (
        <Notice tone="error">
          <strong>Замечания к набору порогов</strong>
          <ul className={styles.warnings}>
            {profile.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Рубеж</th>
              <th>С какого балла</th>
              <th>Что происходит с письмом</th>
            </tr>
          </thead>
          <tbody>
            {profile.items.map((item) => (
              <ThresholdRow key={item.id} item={item} />
            ))}
            {profile.items.length === 0 && (
              <EmptyRow colSpan={3}>
                Пороги не прочитаны: антиспам не ответил. Почта при этом продолжает ходить, но без
                проверки.
              </EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>
    </Panel>
  );
}

function ThresholdsTab() {
  const thresholds = useQuery({
    queryKey: ['spam-thresholds'],
    queryFn: () => api.spamThresholds(),
  });
  const data = thresholds.data;

  return (
    <>
      <ErrorNotice error={thresholds.error} />
      {data && !data.available && (
        <Notice tone="error">
          {data.unavailable ?? 'Антиспам не отвечает — пороги прочитать не удалось.'}
        </Notice>
      )}

      {data && (
        <>
          <p className={styles.note}>{data.scaleNote}</p>
          {data.profiles.map((profile) => (
            <ThresholdProfilePanel key={profile.id} profile={profile} />
          ))}

          {/* Почему нет кнопки «Сохранить». Причина напечатана целиком:
              отключённая кнопка без объяснения читается как «сломано». */}
          <Panel title="Как изменить пороги">
            <p className={styles.hint}>{data.whyReadonly}</p>
            <dl className={styles.howTo}>
              <dt>Файл</dt>
              <dd>
                <code>{data.howTo.file}</code>
              </dd>
              <dt>Строка</dt>
              <dd>
                <code>{data.howTo.format}</code>
              </dd>
              <dt>Применить</dt>
              <dd>
                <code>{data.howTo.command}</code>
              </dd>
            </dl>
            <p className={styles.note}>{data.howTo.note}</p>
            <p className={styles.note}>{data.probeNote}</p>
          </Panel>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Один список — таблицей                                               */
/* ------------------------------------------------------------------ */

function ListTable({ list, canEdit }: { list: SpamList; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [search, setSearch] = useState('');
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
    onSuccess: (result) => {
      setError(null);
      /*
       * Сервер отвечает `changed: false`, когда убирать было нечего:
       * строку уже удалили из соседней вкладки или правкой файла карты.
       * Прежнее безусловное «Запись убрана» означало, что человек
       * закрывает раздел в уверенности, будто адрес больше не в списке,
       * — а если строка на самом деле осталась (несовпадение написания,
       * например), письма от него по-прежнему летят мимо фильтра.
       * Добавление это различает с самого начала; удаление — нет.
       */
      setMessage(
        result.changed
          ? 'Запись убрана; фильтр подхватит изменение в течение десяти секунд'
          : 'Такой записи в списке не было — ничего не изменилось',
      );
      invalidate();
    },
    onError: (err) => {
      setError(err);
      setMessage(null);
    },
  });

  const editable = list.editable && canEdit;
  const shown = filterEntries(list.entries, search);

  return (
    <Panel title={list.title}>
      <p className={styles.hint}>
        {/* Что реально произойдёт с письмом — числом, а не словом
            «важный»: администратор должен видеть цену решения. */}
        <Badge tone={list.tone === 'allow' ? 'ok' : 'fail'}>{scoreWithWord(list.score)}</Badge>{' '}
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

      {/* Поиск появляется, только когда искать есть в чём: на списке из
          трёх адресов поле поиска — лишний элемент. */}
      {list.entries.length > 5 && (
        <Toolbar>
          <input
            className={`mt-input ${styles.search}`}
            type="search"
            value={search}
            placeholder="Поиск по списку"
            aria-label={`Поиск в списке «${list.title}»`}
            onChange={(event) => setSearch(event.target.value)}
          />
          <ToolbarSpacer />
          <span className={styles.count}>
            {search.trim() === ''
              ? `${String(list.entries.length)} ${plural(list.entries.length, 'запись', 'записи', 'записей')}`
              : `найдено ${String(shown.length)} из ${String(list.entries.length)}`}
          </span>
        </Toolbar>
      )}

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>Запись</th>
              {editable && <th className={styles.actionHead}>Действие</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry}>
                <td className={styles.entryValue}>{entry}</td>
                {editable && (
                  <td className={tableStyles.nowrap}>
                    <button
                      type="button"
                      className={styles.entryRemove}
                      disabled={remove.isPending}
                      title={`Убрать ${entry}`}
                      onClick={() => remove.mutate(entry)}
                    >
                      Убрать
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {shown.length === 0 && (
              <EmptyRow colSpan={editable ? 2 : 1}>
                {list.entries.length > 0 ? (
                  `По запросу «${search.trim()}» в этом списке ничего нет.`
                ) : (
                  // Пустая таблица обязана объяснить, зачем список нужен:
                  // иначе единственное, что человек узнаёт, — что записей
                  // нет. Из-за этого разрешённые серверы (IP) путали с
                  // разрешёнными отправителями, хотя подделать можно ровно
                  // одно из двух.
                  <>
                    <span className={styles.emptyPurpose}>{list.purpose}</span>
                    <span className={styles.emptyExample}>
                      Пример записи: <code>{list.example}</code>
                    </span>
                  </>
                )}
              </EmptyRow>
            )}
          </tbody>
        </Table>
      </TableWrap>

      <p className={styles.file}>
        Символ {list.symbol}, файл infra/rspamd/maps.d/{list.file}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Списки: вкладка на список                                            */
/* ------------------------------------------------------------------ */

function ListsTab({ canEdit }: { canEdit: boolean }) {
  const lists = useQuery({ queryKey: ['spam-lists'], queryFn: () => api.spamLists() });
  const [current, setCurrent] = useState<string | null>(null);

  const items = lists.data?.items ?? [];
  // Первый список — запасной выбор: до первого ответа сервера выбирать
  // нечего, а после — незачем заставлять человека щёлкать вкладку.
  const active = items.find((item) => item.id === current) ?? items[0];

  return (
    <>
      <ErrorNotice error={lists.error} />
      {lists.data && !lists.data.available && (
        <Notice tone="error">{lists.data.unavailable}</Notice>
      )}
      {lists.data && <p className={styles.note}>{lists.data.note}</p>}

      {items.length > 0 && (
        <Tabs
          label="Списки антиспама"
          value={active?.id ?? items[0]?.id ?? ''}
          onChange={setCurrent}
          items={items.map((item) => ({
            id: item.id,
            title: item.title,
            count: item.entries.length,
          }))}
        />
      )}

      {active && <ListTable key={active.id} list={active} canEdit={canEdit} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Разбор письма и обучение                                             */
/* ------------------------------------------------------------------ */

/**
 * Разбор письма и обучение.
 *
 * Показывается только тому, у кого есть users.write: этого права требуют
 * ОБА действия вкладки — и «Проверить», и «Это спам/Это не спам»
 * (см. requireAdmin в routes/spam.ts). Раньше вкладка была видна всем, и
 * дежурный вставлял письмо целиком, нажимал «Проверить» и получал отказ
 * по правам — при том что подсказка над полем обещала «проверка ничего
 * не меняет». Обещание было верным по сути и пустым на деле.
 */
function MessageTools() {
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
      </Toolbar>

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
          {/* Пороги здесь — те, что применились ИМЕННО К ЭТОМУ письму: у
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
                        {scoreText(symbol.score)}
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
/* Последние проверенные письма                                         */
/* ------------------------------------------------------------------ */

function HistoryTab() {
  const history = useQuery({
    queryKey: ['spam-history'],
    queryFn: () => api.spamHistory({ limit: 30 }),
  });
  const data = history.data;

  return (
    <Panel title="Последние проверенные письма">
      <ErrorNotice error={history.error} />
      {data && <p className={styles.note}>{data.note}</p>}
      {data?.available && (
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
              {data.items.map((item) => (
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
                          .map((symbol) => `${symbol.name} ${scoreText(symbol.score)}`)
                          .join(', ')}
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <EmptyRow colSpan={6}>Писем в памяти фильтра пока нет.</EmptyRow>
              )}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Сводка                                                               */
/* ------------------------------------------------------------------ */

function SummaryTab() {
  const [hours, setHours] = useState(24);
  const overview = useQuery({
    queryKey: ['spam-overview', hours],
    queryFn: () => api.spamOverview(hours),
  });
  const data = overview.data;

  return (
    <>
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
                        {scoreText(symbol.weight)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Страница                                                             */
/* ------------------------------------------------------------------ */

export function SpamPage() {
  const { session } = useSession();
  const [tab, setTab] = useState<TabId>('summary');
  const canEditLists = can(session?.permissions, 'domains.write');
  /*
   * Вкладка разбора письма целиком требует users.write: его спрашивают
   * и проверка, и обучение. Вкладки без права просто нет — по той же
   * причине, что и у истории писем ниже: показать раздел, в котором
   * ничего нельзя нажать, значит пообещать и отказать.
   */
  const canCheck = can(session?.permissions, 'users.write');
  // Темы и адреса писем — то же, что журналы почты: не сводка о переписке,
  // а сама переписка. Вкладки без права просто нет — отключённая вкладка
  // сообщала бы дежурному, что от него что-то прячут.
  const canReadHistory = can(session?.permissions, 'mailbox.impersonate');

  const tabs: ReadonlyArray<{ id: TabId; title: string }> = [
    { id: 'summary', title: 'Сводка' },
    { id: 'thresholds', title: 'Пороги' },
    { id: 'lists', title: 'Списки' },
    ...(canCheck ? [{ id: 'check' as const, title: 'Разбор письма' }] : []),
    ...(canReadHistory ? [{ id: 'history' as const, title: 'Последние письма' }] : []),
  ];

  return (
    <>
      <PageTitle
        title="Антиспам"
        subtitle="Что отсеял фильтр, по каким правилам и как это изменить"
      />

      <Tabs label="Разделы антиспама" value={tab} onChange={setTab} items={tabs} />

      {tab === 'summary' && <SummaryTab />}
      {tab === 'thresholds' && <ThresholdsTab />}
      {tab === 'lists' && <ListsTab canEdit={canEditLists} />}
      {tab === 'check' && canCheck && <MessageTools />}
      {tab === 'history' && canReadHistory && <HistoryTab />}
    </>
  );
}
