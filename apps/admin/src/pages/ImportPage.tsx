/**
 * Массовый импорт ящиков из CSV.
 *
 * Обязательно двухшагово: сначала предварительный показ того, что будет
 * создано (и что отброшено и почему), и только потом создание.
 * Сервер разбирает файл ещё раз при импорте — предпросмотр ничего не
 * создаёт и ничего не «резервирует».
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, Checkbox } from '@web/components';
import { api } from '../api/client';
import type { ImportPreview } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { Badge, ErrorNotice, Field, Notice, Panel, Toolbar, ToolbarSpacer } from '../components/ui';
import { summarizeCsv } from '../lib/csvPreview';
import { formatBytes, pluralize } from '../lib/format';

const SAMPLE = `email,name,password,quota
ivan@mail.local,Иван Петров,parol12345,1G
anna@mail.local,Анна Смирнова,,500M`;

export function ImportPage() {
  const [csv, setCsv] = useState('');
  const [allowNewDomains, setAllowNewDomains] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  /**
   * Номер задания импорта. Сам импорт идёт на сервере, а результат
   * (включая сгенерированные пароли) лежит в базе — закрытая вкладка
   * или оборвавшаяся связь больше не уносят пароли с собой.
   */
  const [jobId, setJobId] = useState<number | null>(null);

  // Быстрая локальная сводка: сколько строк, какие столбцы распознаны.
  // Нужна до похода на сервер, чтобы сразу увидеть кривой файл.
  const local = csv.trim() === '' ? null : summarizeCsv(csv);

  const doPreview = useMutation({
    mutationFn: () => api.importPreview(csv, allowNewDomains),
    onSuccess: (data) => {
      setPreview(data);
      setJobId(null);
    },
  });

  const doImport = useMutation({
    mutationFn: () => api.importRun(csv, allowNewDomains),
    onSuccess: (data) => setJobId(data.jobId),
  });

  // Пока задание идёт — спрашиваем состояние раз в секунду.
  const job = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api.importJob(jobId ?? 0),
    enabled: jobId !== null,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1000 : false),
  });
  const result = job.data ?? null;

  async function onFile(file: File): Promise<void> {
    const text = await file.text();
    setCsv(text);
    setPreview(null);
    setJobId(null);
  }

  return (
    <>
      <PageTitle
        title="Импорт ящиков из CSV"
        subtitle="Сначала посмотрите, что будет создано, — потом создавайте"
      />

      <Panel title="Файл">
        <Toolbar>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
            }}
          />
          <ToolbarSpacer />
          <Button mode="secondary" size="s" onClick={() => setCsv(SAMPLE)}>
            Подставить пример
          </Button>
          <Link to="/users">
            <Button mode="secondary" size="s">
              К списку ящиков
            </Button>
          </Link>
        </Toolbar>

        <Field
          label="Содержимое файла"
          hint={
            'Столбцы: email, name, password, quota. Порядок и регистр неважны, ' +
            'русские названия («адрес», «имя», «пароль», «квота») тоже понимаются. ' +
            'Разделитель — запятая, точка с запятой или табуляция. ' +
            'Пустой пароль — будет сгенерирован.'
          }
        >
          <textarea
            className="mt-textarea"
            spellCheck={false}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(null);
              setJobId(null);
            }}
          />
        </Field>

        {local && (
          <Notice tone="info">
            Распознано {pluralize(local.dataRows, 'строка', 'строки', 'строк')} данных
            {local.hasHeader ? ' (с заголовком)' : ''}.
            {local.notes.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {local.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}

        <Toolbar>
          <Checkbox
            label="Создавать домены, которых ещё нет"
            checked={allowNewDomains}
            onChange={(e) => setAllowNewDomains(e.target.checked)}
          />
          <ToolbarSpacer />
          <Button
            disabled={csv.trim() === '' || doPreview.isPending}
            onClick={() => doPreview.mutate()}
          >
            {doPreview.isPending ? 'Проверяем…' : 'Проверить файл'}
          </Button>
        </Toolbar>
        <ErrorNotice error={doPreview.error} />
      </Panel>

      {preview && jobId === null && (
        <div style={{ marginTop: 12 }}>
          <Panel title="Что будет создано">
            {preview.newDomainsDenied && (
              <Notice tone="error">
                Создавать домены вашей роли нельзя — этот флажок будет пропущен, и строки
                с незаведёнными доменами создать не удастся. Попросите добавить домены
                администратора с полным доступом.
              </Notice>
            )}
            {preview.validCount === 0 ? (
              <Notice tone="error">
                Создавать нечего: годных строк нет. Исправьте файл и проверьте ещё раз.
              </Notice>
            ) : (
              <Notice tone={preview.invalidCount > 0 ? 'info' : 'success'}>
                Будет создано {pluralize(preview.validCount, 'ящик', 'ящика', 'ящиков')}
                {preview.invalidCount > 0 &&
                  `, отброшено ${pluralize(preview.invalidCount, 'строка', 'строки', 'строк')}`}
                . Домены в файле: {preview.domains.join(', ') || '—'}.
              </Notice>
            )}

            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th className={tableStyles.numeric}>Строка</th>
                    <th>Адрес</th>
                    <th>Имя</th>
                    <th className={tableStyles.numeric}>Квота</th>
                    <th>Пароль</th>
                    <th>Итог</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.line}>
                      <td className={tableStyles.numeric}>{row.line}</td>
                      <td className="mt-mono">{row.email || '—'}</td>
                      <td>{row.displayName ?? '—'}</td>
                      <td className={tableStyles.numeric}>
                        {row.quotaBytes === null ? '—' : formatBytes(row.quotaBytes)}
                      </td>
                      <td>{row.hasPassword ? 'из файла' : 'будет сгенерирован'}</td>
                      <td>
                        {row.errors.length > 0 ? (
                          <span>
                            <Badge tone="fail">не будет создан</Badge>{' '}
                            {row.errors.join('; ')}
                          </span>
                        ) : row.warnings.length > 0 ? (
                          <span>
                            <Badge tone="warn">будет создан</Badge> {row.warnings.join('; ')}
                          </span>
                        ) : (
                          <Badge tone="ok">будет создан</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                  {preview.rows.length === 0 && <EmptyRow colSpan={6}>Файл пуст</EmptyRow>}
                </tbody>
              </Table>
            </TableWrap>

            <Toolbar>
              <ToolbarSpacer />
              <Button
                disabled={preview.validCount === 0 || doImport.isPending}
                onClick={() => doImport.mutate()}
              >
                {doImport.isPending
                  ? 'Создаём…'
                  : `Создать ${pluralize(preview.validCount, 'ящик', 'ящика', 'ящиков')}`}
              </Button>
            </Toolbar>
            <ErrorNotice error={doImport.error} />
          </Panel>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <Panel title={`Результат импорта (задание №${result.id})`}>
            {result.state === 'running' ? (
              <Notice tone="info">
                Создаём: {result.processed} из {result.total}. Страницу можно закрыть —
                импорт идёт на сервере, а результат сохраняется по мере работы.
                Вернуться к нему можно по адресу{' '}
                <span className="mt-mono">/api/admin/users/import/jobs/{result.id}</span>.
              </Notice>
            ) : (
              <Notice tone={result.state === 'failed' ? 'error' : result.failedCount === 0 ? 'success' : 'info'}>
                Создано {pluralize(result.createdCount, 'ящик', 'ящика', 'ящиков')}
                {result.failedCount > 0 && `, не создано ${result.failedCount}`}.
                {result.state === 'failed' && ` Импорт прерван: ${result.error ?? 'неизвестная ошибка'}.`}
                {result.passwordsStored
                  ? ' Пароли сохранены на сервере и доступны до ' +
                    new Date(result.expiresAt).toLocaleDateString('ru-RU') +
                    ' — обрыв связи их больше не теряет.'
                  : ' Пароли на сервере не сохранены (не задан секрет шифрования) — сохраните их сейчас.'}
              </Notice>
            )}

            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Адрес</th>
                    <th>Пароль</th>
                  </tr>
                </thead>
                <tbody>
                  {result.created.map((row) => (
                    <tr key={row.email}>
                      <td className="mt-mono">{row.email}</td>
                      <td className="mt-mono">{row.generatedPassword ?? 'задан в файле'}</td>
                    </tr>
                  ))}
                  {result.created.length === 0 && <EmptyRow colSpan={2}>Ничего не создано</EmptyRow>}
                </tbody>
              </Table>
            </TableWrap>

            {result.failed.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <TableWrap>
                  <Table>
                    <thead>
                      <tr>
                        <th className={tableStyles.numeric}>Строка</th>
                        <th>Адрес</th>
                        <th>Почему не создан</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.failed.map((row) => (
                        <tr key={`${row.line}-${row.email}`}>
                          <td className={tableStyles.numeric}>{row.line}</td>
                          <td className="mt-mono">{row.email || '—'}</td>
                          <td>{row.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              </div>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
