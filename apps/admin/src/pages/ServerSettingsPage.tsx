/**
 * Настройки сервера: то, что до этого правили в infra/.env на машине.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ГЛАВНОЕ
 * ------------------------------------------------------------------
 * Не поля ввода. Полей на экране полторы сотни, и человек, который их
 * открыл, задаёт ровно три вопроса:
 *
 *   1. Что будет, если я это поменяю — прямо сейчас или после
 *      перезапуска? А может, поменять вообще нельзя?
 *   2. Почему у меня не то, что написано в файле?
 *   3. Что эта настройка вообще делает?
 *
 * Поэтому у каждой настройки рядом с полем стоят ТРИ вещи: состояние
 * плашкой, источник значения словами и описание обычным текстом — не под
 * знаком вопроса и не серым в углу.
 *
 * ------------------------------------------------------------------
 * ТРИ СОСТОЯНИЯ И ПОЧЕМУ ЧЕТВЁРТЫЙ ПРИЗНАК НЕ СМЕШАН С НИМИ
 * ------------------------------------------------------------------
 *   «действует сразу»       — сохранил и работает.
 *   «нужен перезапуск»      — обещание: подействует после перезапуска.
 *                             Это свойство настройки, оно верно всегда.
 *   «не меняется из веба»   — поле недоступно, и рядом ПРИЧИНА текстом.
 *                             Серый цвет причиной не является.
 *
 * И отдельно — «ждёт перезапуска». Это не свойство настройки, а факт о
 * сервере прямо сейчас: значение уже в базе, а живой процесс работает по
 * старому. У факта своя плашка наверху раздела со счётчиком и командой
 * перезапуска, свой отбор в списке и своя полоса у строки. Слить его с
 * «нужен перезапуск» значило бы потерять единственное, что требует
 * действия, среди пяти десятков настроек, которые ничего не требуют.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СОХРАНЕНИЕ ПАЧКОЙ
 * ------------------------------------------------------------------
 * Так их и правят: открыл раздел, поменял три поля, нажал «Сохранить».
 * Полоса сохранения держится внизу экрана, потому что список длинный:
 * кнопка наверху означала бы прокрутку страницы целиком обратно после
 * каждой правки — и уход со страницы, не сохранив.
 *
 * Возврат к умолчанию — отдельным действием у каждой изменённой
 * настройки, а не «сохранением пустого поля»: он удаляет строку из базы,
 * то есть настройка снова начинает следовать за infra/.env.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from 'react-router-dom';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import { api, ApiError } from '../api/client';
import type { RestartTarget, ServerSetting, SettingApply, SettingValue } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { Badge, Field, Notice, Panel, Tile, Tiles, Toolbar } from '../components/ui';
import { formatDateTime, plural, pluralize } from '../lib/format';
import { ApplyButtons, useRestartState } from '../components/ServiceRestart';
import { appliesSummary } from '../lib/restart';
import {
  FILTER_LABELS,
  filterSections,
  humanValue,
  isDirty,
  sourceExplain,
  sourceLabel,
  stateLabel,
  toWire,
  unitLabel,
  validate,
  valueText,
  type SettingFilter,
} from '../lib/serverSettings';
import styles from './ServerSettingsPage.module.css';

/** Команда перезапуска — та же, что в docs/infra.md. */
const FILTERS: readonly SettingFilter[] = [
  'all',
  'live',
  'restart',
  'recreate',
  'pending',
  'locked',
  'changed',
];

/**
 * Отказ по-человечески.
 *
 * Сервер отвечает уже готовым русским текстом — его и показываем. Свой
 * текст нужен ровно для случая, когда ответа не было вовсе: браузер
 * говорит «Failed to fetch», и это не сообщение, а код.
 */
function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) {
    return 'Сервер приложения не ответил. Скорее всего, идёт его перезапуск — повторите через несколько секунд.';
  }
  if (error instanceof Error) return error.message;
  return 'Неизвестная ошибка.';
}

export function ServerSettingsPage() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const writable = can('serversettings.write');

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<SettingFilter>('all');
  /** Набранное, но не сохранённое. Ключ настройки → значение поля. */
  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [flash, setFlash] = useState<string | null>(null);
  // Один запрос на весь раздел: строкам список служб отдаётся готовым.
  const { data: restart } = useRestartState();

  const list = useQuery({
    queryKey: ['server-settings'],
    queryFn: () => api.serverSettings(),
  });

  const settings = useMemo(
    () => list.data?.sections.flatMap((section) => section.settings) ?? [],
    [list.data],
  );
  const byKey = useMemo(() => new Map(settings.map((item) => [item.key, item])), [settings]);

  /** Что человек действительно поменял: набранное, отличное от текущего. */
  const changed = useMemo(() => {
    const result: ServerSetting[] = [];
    for (const [key, value] of Object.entries(draft)) {
      const setting = byKey.get(key);
      if (setting && isDirty(setting, value)) result.push(setting);
    }
    return result;
  }, [draft, byKey]);

  const invalidCount = changed.filter(
    (setting) => validate(setting, draft[setting.key] ?? '') !== null,
  ).length;

  /**
   * Службы, которые надо тронуть сразу после успешного сохранения.
   * null — сохраняем и ничего не трогаем.
   */
  const [restartAfterSave, setRestartAfterSave] = useState<SettingApply[] | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (values: Record<string, SettingValue | null>) => api.saveServerSettings(values),
    onSuccess: (result) => {
      queryClient.setQueryData(['server-settings'], {
        sections: result.sections,
        counts: result.counts,
      });
      setDraft({});

      /*
       * Перезапуск идёт ЗДЕСЬ, после успешного сохранения, а не рядом с
       * ним: перезапустить службу и не сохранить значение — худший из
       * возможных исходов. Служба переподнимется со старым значением, а
       * человек будет уверен, что применил новое.
       */
      const targets = restartAfterSave;
      setRestartAfterSave(null);
      if (targets && targets.length > 0) {
        setFlash(
          `Сохранено настроек: ${String(result.changed)}. Перезапускаю: ` +
            targets.map((t) => t.target).join(', ') +
            '…',
        );
        void runRestarts(targets);
        return;
      }

      setFlash(
        result.changed === 0
          ? 'Менять было нечего: значения и так такие.'
          : `Сохранено настроек: ${String(result.changed)}.` +
              (result.counts.pendingRestart > 0
                ? ' Часть из них подействует после перезапуска — см. плашку наверху.'
                : ''),
      );
    },
  });

  /**
   * Перезапуск затронутых служб — по одной, а не пачкой.
   *
   * Последовательно намеренно: на почтовом сервере службы связаны
   * (Postfix спрашивает пароли у Dovecot), и одновременный перезапуск
   * двух даёт отказ аутентификации у того, кто в этот момент отправляет
   * письмо. Разница в пару секунд — цена, которую никто не заметит.
   */
  const runRestarts = async (targets: SettingApply[]): Promise<void> => {
    const done: string[] = [];
    for (const apply of targets) {
      try {
        await api.requestRestart(apply.target, apply.action);
        done.push(apply.target);
      } catch (err) {
        setFlash(null);
        setRestartError(
          `Служба ${apply.target}: ${err instanceof Error ? err.message : 'перезапуск не удался'}` +
            (done.length > 0 ? `. До неё перезапущены: ${done.join(', ')}` : ''),
        );
        break;
      }
    }
    if (done.length > 0) {
      setFlash(`Настройки сохранены, перезапущены службы: ${done.join(', ')}.`);
    }
    // Список перечитываем: у перезапущенных служб пропадает «ждёт перезапуска».
    void queryClient.invalidateQueries({ queryKey: ['server-settings'] });
  };

  const reset = useMutation({
    mutationFn: (key: string) => api.resetServerSetting(key),
    onSuccess: (setting) => {
      // Список перечитываем целиком: возврат к умолчанию меняет и счётчики
      // наверху («задано в панели», «ждут перезапуска»), а не только строку.
      void queryClient.invalidateQueries({ queryKey: ['server-settings'] });
      setDraft((prev) => {
        const next = { ...prev };
        delete next[setting.key];
        return next;
      });
      setFlash(
        `Настройка ${setting.key} вернулась к умолчанию: ${valueText(setting.value)}. ` +
          'Теперь она снова следует за файлом окружения сервера.',
      );
    },
  });

  const busy = save.isPending || reset.isPending;
  const counts = list.data?.counts;
  const filtered = useMemo(
    () => filterSections(list.data?.sections ?? [], search, filter),
    [list.data, search, filter],
  );

  const setValue = (key: string, value: SettingValue): void => {
    setFlash(null);
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Службы, которых коснутся сохраняемые правки.
   *
   * Считаются по самим настройкам, а не выбираются человеком: он не
   * обязан помнить, что HELO читает Postfix, а срок сессии — api. Каждая
   * служба попадает сюда один раз, даже если изменённых настроек у неё
   * десяток, и с самым сильным из требуемых действий: пересоздание
   * контейнера включает в себя перезапуск, обратное неверно.
   */
  const affected = useMemo((): SettingApply[] => {
    const byTarget = new Map<string, SettingApply>();
    for (const setting of changed) {
      for (const apply of setting.applies) {
        const known = byTarget.get(apply.target);
        if (!known || (known.action === 'restart' && apply.action === 'recreate')) {
          byTarget.set(apply.target, apply);
        }
      }
    }
    return [...byTarget.values()];
  }, [changed]);

  /*
   * НЕСОХРАНЁННЫЕ ПРАВКИ НЕ ПРОПАДАЮТ МОЛЧА.
   *
   * Раздел большой, правок за раз делают десяток, а уйти с него можно
   * одним щелчком по любому пункту меню — и набранное исчезало без
   * единого слова. Здесь два разных ухода, и оба надо перехватить:
   *
   *   * переход внутри панели — его ловит маршрутизатор (useBlocker) и
   *     позволяет спросить;
   *   * закрытие вкладки и обновление страницы — их ловит только
   *     beforeunload, и текст вопроса пишет браузер, а не мы.
   */
  const hasUnsaved = changed.length > 0;

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasUnsaved && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const stay = !window.confirm(
      `Не сохранено настроек: ${String(changed.length)}. Уйти со страницы и потерять правки?`,
    );
    if (stay) blocker.reset();
    else blocker.proceed();
  }, [blocker, changed.length]);

  useEffect(() => {
    if (!hasUnsaved) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Значение не показывается со времён старых браузеров, но само его
      // наличие включает окно с вопросом.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [hasUnsaved]);

  const submit = (thenRestart = false): void => {
    const values: Record<string, SettingValue | null> = {};
    for (const setting of changed) {
      const value = draft[setting.key];
      if (value === undefined || validate(setting, value) !== null) continue;
      values[setting.key] = toWire(setting, value);
    }
    if (Object.keys(values).length === 0) return;
    setFlash(null);
    // Что перезапускать, решаем ДО сохранения: после него changed опустеет.
    setRestartAfterSave(thenRestart ? affected : null);
    save.mutate(values);
  };

  return (
    <>
      <PageTitle
        title="Настройки сервера"
        subtitle="То, что до этого правили в infra/.env на машине сервера"
      />

      {flash && <Notice tone="success">{flash}</Notice>}
      {(list.error ?? save.error ?? reset.error) && (
        <Notice tone="error">{errorText(list.error ?? save.error ?? reset.error)}</Notice>
      )}
      {/* Перезапуск отдельной строкой: значения при этом СОХРАНЕНЫ, и
          человек должен видеть, что не применилось, а не что не легло. */}
      {restartError !== null && (
        <Notice tone="error">Настройки сохранены, но перезапуск не удался. {restartError}</Notice>
      )}

      {/* ФАКТ, а не обещание: сохранено, но живой процесс работает по-старому */}
      {counts && counts.pendingRestart > 0 && (
        <div className={styles.restart}>
          <div className={styles.restartText}>
            <span className={styles.restartTitle}>
              Перезапуск нужен прямо сейчас:{' '}
              {pluralize(counts.pendingRestart, 'настройка', 'настройки', 'настроек')}{' '}
              {plural(counts.pendingRestart, 'ждёт', 'ждут', 'ждут')} его
            </span>
            Значения уже сохранены, но службы работают по прежним: такие настройки читаются один раз
            при старте. Кнопка нужного действия стоит у самой настройки — там же написано, какую
            службу она затронет и что на это время перестанет работать.
          </div>
          <Button
            mode="secondary"
            size="s"
            onClick={() => {
              setFilter('pending');
              setSearch('');
            }}
          >
            Показать их
          </Button>
        </div>
      )}

      {counts && (
        <Tiles>
          <Tile value={counts.total} label="настроек всего" />
          <Tile value={counts.live} label="действуют сразу" />
          <Tile value={counts.restart} label="нужен перезапуск" />
          <Tile value={counts.recreate} label="нужно пересоздать контейнер" />
          <Tile value={counts.locked} label="не меняются из веба" />
          <Tile value={counts.overridden} label="задано в панели" />
        </Tiles>
      )}

      <Panel title="Как читать этот раздел">
        <div className={styles.legend}>
          <div className={styles.legendItem}>
            <Badge tone="ok">действует сразу</Badge>
            <br />
            Значение читается при каждом обращении. Нажали «Сохранить» — работает со следующего
            запроса, перезапускать нечего.
          </div>
          <div className={styles.legendItem}>
            <Badge tone="warn">нужен перезапуск</Badge>
            <br />
            Сервер читает такое значение один раз при старте. Сохранить можно когда угодно, но до
            перезапуска контейнера <b>api</b> действует прежнее.
          </div>
          <div className={styles.legendItem}>
            <Badge tone="warn">нужно пересоздать контейнер</Badge>
            <br />
            Такое значение контейнер получает при создании, поэтому обычного перезапуска мало.
            Пересоздание идёт из того же образа: данные и почта на месте, служба недоступна те же
            несколько секунд.
          </div>
          <div className={styles.legendItem}>
            <Badge tone="muted">не меняется из веба</Badge>
            <br />
            Показано для справки. У каждой такой настройки написана <b>причина</b> — обычно смена
            означает пересоздание контейнеров или чтение значения другим контейнером.
          </div>
          <div className={styles.legendItem}>
            <b>Откуда значение.</b> «Задано в панели» перебивает файл окружения: пока так, настройка
            за <b>infra/.env</b> не следует. Кнопка «Вернуть к умолчанию» убирает запись из базы, и
            настройка снова начинает слушать файл.
          </div>
        </div>
      </Panel>

      <Panel>
        <Toolbar>
          <Field label="Поиск по названию и описанию">
            <input
              className={cx('mt-input', styles.search)}
              value={search}
              placeholder="логотип, сессия, SENDER_LOGO"
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          <Field label="Состояние">
            <select
              className={cx('mt-select', styles.filter)}
              value={filter}
              onChange={(event) => setFilter(event.target.value as SettingFilter)}
            >
              {FILTERS.map((value) => (
                <option key={value} value={value}>
                  {FILTER_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
        </Toolbar>
        {list.isPending ? (
          <p className={styles.found}>Загрузка…</p>
        ) : (
          <p className={styles.found}>
            Показано {filtered.shown} из {counts?.total ?? 0}
            {counts && counts.overridden > 0 && (
              <>
                {' · '}задано в панели: {counts.overridden}
              </>
            )}
          </p>
        )}
      </Panel>

      {!writable && list.data && (
        <Notice tone="info">
          У вас право только смотреть настройки. Менять их может администратор с полным доступом
          (право «serversettings.write»).
        </Notice>
      )}

      {list.data && filtered.sections.length === 0 && (
        <Panel>
          <p className={styles.note}>
            Ничего не найдено. Поиск идёт и по описанию тоже — попробуйте слово из него, например
            «сессия» или «логотип».
          </p>
        </Panel>
      )}

      {filtered.sections.map((section) => (
        <Panel key={section.id} title={section.title}>
          {section.note && <p className={styles.note}>{section.note}</p>}
          <ul className={styles.list}>
            {section.settings.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                draft={draft[setting.key]}
                writable={writable}
                busy={busy}
                onChange={(value) => setValue(setting.key, value)}
                onReset={() => {
                  setFlash(null);
                  reset.mutate(setting.key);
                }}
                restartTargets={restart?.targets ?? []}
                onApplied={() => {
                  void queryClient.invalidateQueries({ queryKey: ['server-settings'] });
                }}
              />
            ))}
          </ul>
        </Panel>
      ))}

      {changed.length > 0 && (
        <div className={styles.saveBar}>
          <div className={styles.saveText}>
            <b>Не сохранено: {pluralize(changed.length, 'настройка', 'настройки', 'настроек')}</b>
            {invalidCount > 0 ? (
              <>
                {' '}
                — из них {invalidCount} с ошибкой в значении. Такие не отправятся: исправьте или
                отмените.
              </>
            ) : (
              <> — {changed.map((setting) => setting.key).join(', ')}</>
            )}
          </div>
          <Button
            size="s"
            disabled={busy || invalidCount === changed.length}
            onClick={() => submit(false)}
          >
            {save.isPending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          {/*
            Вторая кнопка появляется, только если среди правок есть такие,
            которым перезапуск нужен. Когда всё «действует сразу», она
            была бы предложением сделать бессмысленную работу — с обрывом
            чужих сессий в придачу.
          */}
          {affected.length > 0 && writable && (
            <Button
              size="s"
              disabled={busy || invalidCount === changed.length}
              title={`Тронет: ${affected.map((a) => a.target).join(', ')}`}
              onClick={() => submit(true)}
            >
              {save.isPending ? 'Сохраняем…' : 'Сохранить и перезапустить'}
            </Button>
          )}
          <Button mode="secondary" size="s" disabled={busy} onClick={() => setDraft({})}>
            Отменить правки
          </Button>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Одна настройка                                                      */
/* ------------------------------------------------------------------ */

interface SettingRowProps {
  setting: ServerSetting;
  draft: SettingValue | undefined;
  writable: boolean;
  busy: boolean;
  onChange: (value: SettingValue) => void;
  onReset: () => void;
  /** Службы, которыми включаются настройки: приходят со страницы одним запросом. */
  restartTargets: readonly RestartTarget[];
  /** Перезапуск прошёл: часть настроек перестала ждать, список надо перечитать. */
  onApplied?: (() => void) | undefined;
}

export function SettingRow({
  setting,
  draft,
  writable,
  busy,
  onChange,
  onReset,
  restartTargets,
  onApplied,
}: SettingRowProps) {
  const state = stateLabel(setting);
  /*
   * Список служб приходит СВЕРХУ, а не запрашивается здесь. Строка рисуется
   * полтораста раз, и полтораста подписок на один и тот же запрос — это
   * не только лишняя работа: строка перестаёт быть отрисовкой готовых
   * данных и начинает требовать вокруг себя целое окружение (проверки
   * ломались именно на этом).
   *
   * Право на перезапуск здесь то же, что право менять настройки. Отдельного
   * не заведено намеренно: тот, кто сохранил значение, требующее
   * перезапуска, и не может его применить, остался бы с настройкой,
   * которая «сохранена, но не работает», — и без объяснения, к кому идти.
   */
  const applyText = appliesSummary(setting, restartTargets);
  const current: SettingValue = draft ?? setting.value ?? (setting.kind === 'bool' ? false : '');
  const dirty = draft !== undefined && isDirty(setting, draft);
  const invalid = dirty ? validate(setting, current) : null;
  const editable = setting.editable && !setting.secret && writable;
  const human = humanValue(setting.unit, setting.kind === 'int' ? Number(current) : current);

  return (
    <li
      className={cx(
        styles.row,
        dirty && styles.rowDirty,
        !dirty && setting.pendingRestart && styles.rowPending,
      )}
    >
      <div>
        <div className={styles.head}>
          <span className={styles.key}>{setting.key}</span>
          <Badge tone={state.tone}>{state.text}</Badge>
          {/* Факт, а не обещание: рядом с обещанием, но своей плашкой */}
          {setting.pendingRestart && <Badge tone="fail">ждёт перезапуска</Badge>}
          {setting.source === 'db' && <Badge tone="muted">задано в панели</Badge>}
        </div>

        <p className={styles.description}>{setting.description}</p>

        {setting.reason && (
          <p className={styles.reason}>
            <b>Почему не меняется из веба:</b> {setting.reason}
          </p>
        )}

        {setting.pendingRestart && (
          <p className={styles.reason}>
            <b>Сохранено, но ещё не действует.</b> {applyText}
          </p>
        )}

        {/*
          Кнопки перезапуска у КАЖДОЙ настройки здесь больше нет.
          Их было по одной на строку, а строк на экране десятки — и
          человек, поправив пять полей одной службы, жал одну и ту же
          кнопку пять раз, гадая, нужно ли. Теперь перезапуск идёт от
          «Сохранить и перезапустить» внизу: он трогает ровно те службы,
          которых коснулись правки, и по одному разу каждую.

          Осталась она только у настроек, СОХРАНЁННЫХ ранее и ждущих
          перезапуска: их правки уже не в этой сессии, «Сохранить» для
          них нечего, а применить надо.
        */}
        {setting.pendingRestart && setting.applies.length > 0 && (
          <div className={styles.applies}>
            <ApplyButtons applies={setting.applies} allowed={writable} onApplied={onApplied} />
          </div>
        )}

        <p className={styles.meta}>
          {sourceLabel(setting)}
          {setting.source === 'db' && setting.updatedBy && (
            <>
              {' '}
              — {setting.updatedBy}, {formatDateTime(setting.updatedAt)}
            </>
          )}
          {!setting.secret && (
            <>
              <span className={styles.metaSep}>·</span>
              умолчание: {valueText(setting.default)}
            </>
          )}
          {sourceExplain(setting) !== null && (
            <>
              <br />
              {sourceExplain(setting)}
            </>
          )}
        </p>
      </div>

      <div className={styles.control}>
        {setting.secret ? (
          /* Секрет наружу не выходит ни в каком виде: ни значением, ни
             звёздочками, ни длиной. Поля ввода тоже нет — менять его
             отсюда нельзя, и пустое поле выглядело бы как «сотрите». */
          <span className={styles.secret}>
            <Badge tone={setting.configured ? 'ok' : 'muted'}>
              {setting.configured ? 'секрет задан' : 'секрет не задан'}
            </Badge>
          </span>
        ) : setting.editable ? (
          <>
            {setting.kind === 'bool' && (
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={current === true}
                  disabled={!editable || busy}
                  onChange={(event) => onChange(event.target.checked)}
                />
                {current === true ? 'включено' : 'выключено'}
              </label>
            )}

            {setting.kind === 'enum' && (
              <select
                className="mt-select"
                value={String(current)}
                disabled={!editable || busy}
                onChange={(event) => onChange(event.target.value)}
              >
                {(setting.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            )}

            {(setting.kind === 'int' || setting.kind === 'string') && (
              <div className={styles.inputRow}>
                <input
                  className="mt-input mt-mono"
                  value={String(current)}
                  inputMode={setting.kind === 'int' ? 'numeric' : undefined}
                  disabled={!editable || busy}
                  aria-label={setting.key}
                  onChange={(event) => onChange(event.target.value)}
                />
                {setting.unit && <span className={styles.unit}>{unitLabel(setting.unit)}</span>}
              </div>
            )}

            {invalid && <span className={styles.invalid}>{invalid}</span>}

            {/* Пределы названы у поля: показать «от 60 до 2592000» честнее,
                чем дать нажать «Сохранить» и вернуть отказ. */}
            {setting.kind === 'int' && (setting.min !== null || setting.max !== null) && (
              <span className={styles.hint}>
                {setting.min !== null && setting.max !== null
                  ? `от ${String(setting.min)} до ${String(setting.max)}`
                  : setting.min !== null
                    ? `не меньше ${String(setting.min)}`
                    : `не больше ${String(setting.max)}`}
                {human && ` · сейчас это ${human}`}
              </span>
            )}
            {setting.kind !== 'int' && human && (
              <span className={styles.hint}>сейчас это {human}</span>
            )}
          </>
        ) : (
          <span className={styles.readonly}>{valueText(setting.value)}</span>
        )}

        <div className={styles.actions}>
          {/* Отдельное действие, а не «сохранить пустое»: оно удаляет
              запись из базы, и настройка снова следует за infra/.env. */}
          {editable && setting.source === 'db' && (
            <Button
              mode="secondary"
              size="s"
              disabled={busy}
              title={`Убрать заданное в панели значение — вернётся ${valueText(setting.default)}`}
              onClick={onReset}
            >
              Вернуть к умолчанию
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
