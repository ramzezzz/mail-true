/**
 * Обновления: что за версия продукта стоит и на чём работают службы.
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
 * ПОЧЕМУ ЗДЕСЬ ПОКА ТОЛЬКО ЧТЕНИЕ
 * ------------------------------------------------------------------
 * Обновление почтового сервера — действие, после которого может не
 * подняться служба, а миграция может не примениться. Кнопка «Обновить»
 * без снимка состояния, отката и проверки «служба ДЕЙСТВИТЕЛЬНО
 * встала» опаснее её отсутствия: именно на «служба ответила, но не
 * поднялась» этот продукт уже попадался в перевыпуске секрета.
 *
 * Поэтому первым шагом — честная картина: на каком коммите работает
 * сервер, что уже скачано и не применено, какие слепки образов у служб.
 * Кнопки обновления и отката добавятся отдельно, с подтверждением и
 * предупреждением о перерыве в приёме почты.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { PageTitle } from '../app/AdminLayout';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { ErrorNotice, Notice, Panel } from '../components/ui';
import { formatDateTime } from '../lib/format';

/** Короткий вид слепка: «sha256:1f2e…» — целиком он не нужен никому. */
function shortDigest(digest: string): string {
  const value = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return value === '' ? '—' : value.slice(0, 12);
}

export function UpdatesPage() {
  const state = useQuery({ queryKey: ['server-version'], queryFn: () => api.serverVersion() });
  const version = state.data?.version ?? null;

  return (
    <>
      <PageTitle
        title="Обновления"
        subtitle="Какая версия продукта стоит и на каких образах работают службы"
      />

      <ErrorNotice error={state.error} />

      {state.data && !state.data.available && (
        <Notice tone="error">
          Версию с сервера прочитать нечем: {state.data.reason ?? 'причина неизвестна'}
        </Notice>
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
                В каталоге сервера есть изменения, сделанные руками. Обновление их затрёт или
                упрётся в конфликт — сначала перенесите их в репозиторий или отмените.
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
                Скачано и ещё не применено: {version.behind}. Обновление пока делается на сервере
                командой <span className="mt-mono">git pull</span> и пересборкой служб.
              </Notice>
            ) : (
              <p style={{ margin: '10px 0 0', color: 'var(--mt-color-text-secondary)' }}>
                Ничего не применённого нет. Это не значит «обновлений не существует»: страница
                показывает только уже скачанное и намеренно не ходит в сеть сама.
              </p>
            )}
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
    </>
  );
}
