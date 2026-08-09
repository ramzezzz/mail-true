/**
 * Обновления: что за версия продукта стоит, на чём работают службы и как
 * обновиться, не заходя на сервер по ssh.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТА СТРАНИЦА
 * ------------------------------------------------------------------
 * Обновления в продукте не было как явления. Отдельного скрипта нет:
 * обновиться можно только руками по ssh — `git pull` и пересборка.
 * Базовые образы (postgres, redis, nginx, clamav) прибиты тегами, и
 * свежие исправления безопасности приезжают лишь при явном `pull`,
 * которого не делает никто. Версии продукта в панели тоже не было
 * видно.
 *
 * То есть сервер, поставленный полгода назад, крутит полугодовалый
 * nginx — и владелец об этом не узнает никак, пока не случится беда.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ДВЕ РАЗНЫЕ КНОПКИ, А НЕ ОДНА «ОБНОВИТЬ»
 * ------------------------------------------------------------------
 * Это два разных по риску действия. Свой код — переход на новые
 * коммиты с пересборкой служб: меняется поведение продукта, может
 * приехать миграция базы. Базовые образы — только свежие сборки чужих
 * служб под теми же тегами: продукт тот же, но приезжают исправления
 * безопасности, ради которых пересобирать весь продукт незачем.
 *
 * Одна кнопка «обновить всё» означала бы, что человек, которому нужен
 * свежий nginx, заодно получает новую версию продукта — не спросив.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ХОД РАБОТЫ ЧИТАЕТСЯ ОПРОСОМ
 * ------------------------------------------------------------------
 * Обновление поднимает стек заново — вместе с сервером приложения,
 * который отвечает на эти самые запросы, и посредником, который его
 * запустил. Поэтому работу ведёт отдельный контейнер, а панель просто
 * спрашивает его состояние. Пропали ответы на минуту — это не сбой, это
 * ровно тот момент, когда служба поднимается заново.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { PageTitle } from '../app/AdminLayout';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { Button } from '@web/components';
import { ErrorNotice, Modal, Notice, Panel } from '../components/ui';
import { formatDateTime } from '../lib/format';

/** Короткий вид слепка: «sha256:1f2e…» — целиком он не нужен никому. */
function shortDigest(digest: string): string {
  const value = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return value === '' ? '—' : value.slice(0, 12);
}

type Mode = 'code' | 'images';

export function UpdatesPage() {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<Mode | null>(null);

  const state = useQuery({ queryKey: ['server-version'], queryFn: () => api.serverVersion() });
  const version = state.data?.version ?? null;

  /*
   * Ход обновления опрашивается каждые три секунды, пока работа идёт.
   * `retry: false` намеренно: во время обновления сервер приложения
   * поднимается заново, и запрос честно не проходит — повторять его
   * пачкой незачем, следующий опрос всё равно через три секунды.
   */
  const progress = useQuery({
    queryKey: ['update-status'],
    queryFn: () => api.updateStatus(),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 3000 : false),
    retry: false,
  });
  const running = progress.data?.state === 'running';

  /*
   * Обновление закончилось — версия на экране устарела: там всё ещё
   * прежний коммит и прежние слепки образов. Перечитываем её один раз по
   * переходу «идёт → закончилось», а не по каждому опросу: иначе страница
   * дёргала бы сервер каждые три секунды после любого обновления.
   */
  const wasRunning = useRef(false);
  useEffect(() => {
    const now = progress.data?.state ?? 'idle';
    if (wasRunning.current && now !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['server-version'] });
    }
    wasRunning.current = now === 'running';
  }, [progress.data?.state, queryClient]);

  const check = useMutation({
    mutationFn: () => api.checkUpdates(),
    onSuccess: (data) => queryClient.setQueryData(['server-version'], data),
  });

  const start = useMutation({
    mutationFn: (mode: Mode) => api.startUpdate(mode),
    onSuccess: async () => {
      setConfirm(null);
      await progress.refetch();
    },
  });

  return (
    <>
      <PageTitle
        title="Обновления"
        subtitle="Какая версия продукта стоит, на каких образах работают службы и как обновиться"
      />

      <ErrorNotice error={state.error} />

      {state.data && !state.data.available && (
        <Notice tone="error">
          Версию с сервера прочитать нечем: {state.data.reason ?? 'причина неизвестна'}
        </Notice>
      )}

      {progress.data && progress.data.state !== 'idle' && (
        <Panel title="Ход обновления">
          {running ? (
            <Notice tone="info">
              {progress.data.mode === 'images'
                ? 'Тянутся свежие базовые образы, потом службы поднимутся заново.'
                : 'Идёт обновление кода: код переезжает на свежий, службы пересобираются.'}{' '}
              Панель на минуту-другую может перестать отвечать — это и есть тот момент, когда она
              поднимается заново. Страницу можно закрыть: работа идёт на сервере и от неё не
              зависит.
            </Notice>
          ) : progress.data.state === 'done' ? (
            <Notice tone="success">
              Обновление закончено{' '}
              {progress.data.finishedAt ? formatDateTime(progress.data.finishedAt) : ''}.
            </Notice>
          ) : (
            <Notice tone="error">
              Обновление не доведено до конца (код возврата {progress.data.exitCode}). Ниже — вывод
              целиком: в нём и написано, на чём оно встало. Службы при этом остались на прежней
              версии, кроме тех, что успели подняться.
            </Notice>
          )}

          {progress.data.log !== '' && (
            <pre
              style={{
                margin: '10px 0 0',
                padding: '10px 12px',
                maxHeight: 320,
                overflow: 'auto',
                background: 'var(--mt-admin-surface-alt, var(--mt-admin-surface))',
                border: '1px solid var(--mt-admin-border)',
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {progress.data.log}
            </pre>
          )}
        </Panel>
      )}

      {version && (
        <>
          <Panel title="Версия продукта">
            {/*
              Правки руками — первое, что должен увидеть человек: именно
              они превращают обновление в конфликт или в потерю правок.
            */}
            {version.dirty && (
              <Notice tone="error">
                В каталоге сервера есть изменения, сделанные руками. Обновление кода их затрёт или
                упрётся в конфликт, поэтому оно запрещено — сначала перенесите их в репозиторий или
                отмените. Свежие базовые образы это не затрагивает: они рабочее дерево не трогают.
              </Notice>
            )}

            <TableWrap>
              <Table>
                <tbody>
                  <tr>
                    <td style={{ width: 220 }}>Сейчас работает</td>
                    <td className="mt-mono">{version.short || '—'}</td>
                  </tr>
                  <tr>
                    <td>Что это за версия</td>
                    <td>{version.subject || '—'}</td>
                  </tr>
                  <tr>
                    <td>Собрана</td>
                    <td>{version.committedAt ? formatDateTime(version.committedAt) : '—'}</td>
                  </tr>
                  <tr>
                    <td>Ветка</td>
                    <td className="mt-mono">{version.branch || '—'}</td>
                  </tr>
                </tbody>
              </Table>
            </TableWrap>

            {version.behind > 0 ? (
              <Notice tone="info">
                Скачано и ещё не применено: {version.behind}. Список — ниже.
              </Notice>
            ) : (
              <p style={{ margin: '10px 0 0', color: 'var(--mt-color-text-secondary)' }}>
                Не применённого нет. Это не значит «обновлений не существует»: страница сама в сеть
                не ходит — спросить репозиторий нужно кнопкой.
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <Button mode="secondary" disabled={check.isPending} onClick={() => check.mutate()}>
                {check.isPending ? 'Спрашиваем…' : 'Проверить обновления'}
              </Button>
              <Button
                disabled={running || version.dirty || version.behind === 0}
                onClick={() => setConfirm('code')}
              >
                Обновить продукт
              </Button>
              <Button mode="secondary" disabled={running} onClick={() => setConfirm('images')}>
                Обновить базовые образы
              </Button>
            </div>
            <ErrorNotice error={check.error} />
          </Panel>

          {version.pending.length > 0 && (
            <Panel title="Что приедет при обновлении">
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>Версия</th>
                      <th style={{ width: 180 }}>Когда</th>
                      <th>Что изменилось</th>
                    </tr>
                  </thead>
                  <tbody>
                    {version.pending.map((row) => (
                      <tr key={row.hash}>
                        <td className="mt-mono">{row.hash}</td>
                        <td>{row.at ? formatDateTime(row.at) : '—'}</td>
                        <td>{row.subject}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            </Panel>
          )}

          <Panel title="Образы служб">
            <p style={{ margin: '0 0 10px', color: 'var(--mt-color-text-secondary)' }}>
              Тег вроде <span className="mt-mono">nginx:1.27-alpine</span> ничего не говорит о
              свежести: под ним за полгода лежит уже другой слепок. Разница видна только по слепку —
              по нему и сверяют, обновлялась ли служба.
            </p>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>Служба</th>
                    <th>Образ</th>
                    <th style={{ width: 140 }}>Слепок</th>
                    <th className={tableStyles.nowrap}>Собран</th>
                  </tr>
                </thead>
                <tbody>
                  {version.images.map((row) => (
                    <tr key={row.service}>
                      <td className="mt-mono">{row.service}</td>
                      <td className="mt-mono">{row.image || '—'}</td>
                      <td className="mt-mono">{shortDigest(row.digest)}</td>
                      <td className={tableStyles.nowrap}>
                        {row.created ? formatDateTime(row.created) : '—'}
                      </td>
                    </tr>
                  ))}
                  {version.images.length === 0 && (
                    <EmptyRow colSpan={4}>Служб не видно — посредник не ответил</EmptyRow>
                  )}
                </tbody>
              </Table>
            </TableWrap>
          </Panel>
        </>
      )}

      {confirm !== null && (
        <Modal
          title={confirm === 'code' ? 'Обновить продукт' : 'Обновить базовые образы'}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button mode="secondary" onClick={() => setConfirm(null)}>
                Отмена
              </Button>
              <Button disabled={start.isPending} onClick={() => start.mutate(confirm)}>
                {start.isPending ? 'Запускаем…' : 'Обновить'}
              </Button>
            </>
          }
        >
          <ErrorNotice error={start.error} />
          {confirm === 'code' ? (
            <>
              <Notice tone="error">
                Почта на несколько минут прервётся. Службы пересоберутся и поднимутся заново: приём
                писем встанет, почтовые программы сотрудников отвалятся и переподключатся, панель на
                это время может не отвечать.
              </Notice>
              <p>
                Перейдём на свежий код ветки{' '}
                <span className="mt-mono">{version?.branch || 'текущей'}</span>
                {version && version.behind > 0 ? ` — это ${String(version.behind)} коммит(ов)` : ''}
                . Обновление не откатывается кнопкой: вернуть прежнюю версию можно только на
                сервере. Делать его лучше тогда, когда почтой не пользуются.
              </p>
            </>
          ) : (
            <>
              <Notice tone="error">
                Почта прервётся на время подъёма служб — те, у кого образ обновился, будут созданы
                заново.
              </Notice>
              <p>
                Скачаются свежие сборки чужих служб (postgres, redis, nginx, clamav и прочие) под
                теми же тегами. Версия продукта при этом не меняется — приезжают только исправления
                самих служб, в том числе исправления безопасности.
              </p>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
