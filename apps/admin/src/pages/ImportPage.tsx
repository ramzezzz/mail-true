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
import { TEMPLATE_FILENAME, templateCsv, templateCsvWithBom } from '@shared/import-template';
import { formatBytes, pluralize } from '../lib/format';
import { DEFAULT_QUOTA_UNIT, quotaToBytes, splitQuota, type QuotaUnit } from '../lib/quota';
import { QuotaInput } from '../components/QuotaInput';

const SAMPLE = templateCsv();

/** Сколько строк предпросмотра рисуем: больше человек всё равно не прочтёт. */
const TABLE_LIMIT = 200;

/** Нулевой байт: строится в коде, чтобы в исходнике его не было. */
const NUL = String.fromCharCode(0);

/** Отдаёт шаблон файлом, не уводя со страницы. */
function downloadTemplate(): void {
  const blob = new Blob([templateCsvWithBom()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = TEMPLATE_FILENAME;
  link.click();
  // Ссылку на файл в памяти надо освободить, иначе она живёт до перезагрузки
  URL.revokeObjectURL(url);
}

export function ImportPage() {
  const [csv, setCsv] = useState('');
  const [allowNewDomains, setAllowNewDomains] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  /**
   * Квота для строк без своего столбца `quota`. Пока поля не трогали —
   * null, и сервер берёт значение из ADMIN_DEFAULT_QUOTA_BYTES. Само это
   * значение показывается рядом: раньше человеку было неоткуда узнать,
   * откуда у ящиков без квоты берётся размер.
   */
  const [quotaTouched, setQuotaTouched] = useState(false);
  const [quotaAmount, setQuotaAmount] = useState('1');
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>(DEFAULT_QUOTA_UNIT);
  /**
   * Номер задания импорта. Сам импорт идёт на сервере, а результат
   * (включая сгенерированные пароли) лежит в базе — закрытая вкладка
   * или оборвавшаяся связь больше не уносят пароли с собой.
   */
  const [jobId, setJobId] = useState<number | null>(null);

  // Быстрая локальная сводка: сколько строк, какие столбцы распознаны.
  // Нужна до похода на сервер, чтобы сразу увидеть кривой файл.
  const local = csv.trim() === '' ? null : summarizeCsv(csv);

  /*
   * Нулевой байт видно сразу, не дожидаясь сервера. Раньше панель бодро
   * докладывала «распознано 1 строка данных» — то есть «файл в порядке», —
   * а потом приходил 500-й: база такого символа не принимает.
   */
  const nulIndex = csv.indexOf(NUL);
  const nulProblem =
    nulIndex === -1
      ? null
      : `В файле есть нулевой байт (0x00) — строка ${csv.slice(0, nulIndex).split('\n').length}. ` +
        'Похоже, выбран двоичный файл (например, .xlsx) или файл в кодировке UTF-16. ' +
        'Пересохраните таблицу как «CSV UTF-8» и повторите.';

  /** Значение с сервера — чтобы показать его до первого предпросмотра. */
  const defaults = useQuery({
    queryKey: ['import-defaults'],
    queryFn: () => api.importDefaults(),
  });
  const serverDefaultQuota = defaults.data?.defaultQuotaBytes ?? null;

  const chosenQuota = quotaToBytes(quotaAmount, quotaUnit);
  /** Что на самом деле уйдёт на сервер: undefined — «оставить как настроено». */
  const defaultQuotaBytes = quotaTouched && chosenQuota !== null ? chosenQuota : undefined;
  /** Что в итоге применится — это и показываем человеку. */
  const effectiveQuota = defaultQuotaBytes ?? serverDefaultQuota;

  const doPreview = useMutation({
    mutationFn: () => api.importPreview(csv, allowNewDomains, defaultQuotaBytes),
    onSuccess: (data) => {
      setPreview(data);
      setJobId(null);
    },
  });

  const doImport = useMutation({
    mutationFn: () => api.importRun(csv, allowNewDomains, defaultQuotaBytes),
    onSuccess: (data) => setJobId(data.jobId),
  });

  /**
   * Пока поле не трогали — показываем то, что настроено на сервере,
   * а не выдуманное «1 ГБ»: иначе подпись обещала бы одно, а применилось
   * бы другое.
   */
  const shownQuota =
    !quotaTouched && serverDefaultQuota !== null
      ? (() => {
          const split = splitQuota(serverDefaultQuota);
          return { amount: String(split.amount), unit: split.unit };
        })()
      : { amount: quotaAmount, unit: quotaUnit };

  /** Правка числа или единицы означает, что квоту задают вручную. */
  const onQuotaAmount = (value: string): void => {
    setQuotaTouched(true);
    setQuotaAmount(value);
    setPreview(null);
  };
  const onQuotaUnit = (value: QuotaUnit): void => {
    setQuotaTouched(true);
    setQuotaUnit(value);
    setPreview(null);
  };

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
          <Button mode="secondary" size="s" onClick={downloadTemplate}>
            Скачать шаблон
          </Button>
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

        {nulProblem && <Notice tone="error">{nulProblem}</Notice>}

        {local && nulProblem === null && (
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

        <Field
          label="Квота по умолчанию"
          hint={
            chosenQuota === null && quotaTouched
              ? 'Введите число, а единицу выберите рядом. 0 — без ограничения.'
              : effectiveQuota === null
                ? 'Действует для строк, где столбец «quota» пуст или его нет.'
                : `Действует для строк, где столбец «quota» пуст или его нет. ` +
                  `Сейчас подставится ${formatBytes(effectiveQuota)}` +
                  (quotaTouched ? '.' : ' — значение сервера по умолчанию.')
          }
        >
          <QuotaInput
            amount={shownQuota.amount}
            unit={shownQuota.unit}
            onAmount={onQuotaAmount}
            onUnit={onQuotaUnit}
          />
        </Field>

        <Toolbar>
          <Checkbox
            label="Создавать домены, которых ещё нет"
            checked={allowNewDomains}
            onChange={(e) => setAllowNewDomains(e.target.checked)}
          />
          <ToolbarSpacer />
          <Button
            disabled={csv.trim() === '' || nulProblem !== null || doPreview.isPending}
            onClick={() => doPreview.mutate()}
          >
            {doPreview.isPending ? 'Проверяем…' : 'Проверить файл'}
          </Button>
        </Toolbar>
        <ErrorNotice error={doPreview.error} />
      </Panel>

      {preview && jobId === null && (() => {
        /*
         * Таблицу на пять тысяч строк браузер рисует несколько секунд, и всё
         * это время страница не отвечает. Строки с ошибками важнее всего —
         * их показываем все, годные добираем до предела.
         */
        const failed = preview.rows.filter((r) => r.errors.length > 0);
        const rest = preview.rows.filter((r) => r.errors.length === 0);
        const shownRows = [
          ...failed,
          ...rest.slice(0, Math.max(0, TABLE_LIMIT - failed.length)),
        ].sort((a, b) => a.line - b.line);
        const hiddenRows = preview.rows.length - shownRows.length;
        return (
        <div style={{ marginTop: 12 }}>
          <Panel title="Что будет создано">
            {preview.truncated && (
              <Notice tone="error">
                <strong>
                  В файле {pluralize(preview.totalDataRows, 'строка', 'строки', 'строк')}, а за
                  один раз создаётся не больше {preview.maxRows}. Остальные{' '}
                  {pluralize(preview.totalDataRows - preview.maxRows, 'строка', 'строки', 'строк')}{' '}
                  сейчас НЕ будут созданы.
                </strong>
                <br />
                Разбейте файл на части и импортируйте их по очереди — иначе часть людей
                останется без почты, и заметить это будет нечем.
              </Notice>
            )}
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
                . Домены в файле: {preview.domains.join(', ') || '—'}. Строкам без своей
                квоты досталось {formatBytes(preview.defaultQuotaBytes)}.
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
                  {shownRows.map((row) => (
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
                  {hiddenRows > 0 && (
                    <EmptyRow colSpan={6}>
                      …и ещё {pluralize(hiddenRows, 'строка', 'строки', 'строк')}. Таблица
                      показывает первые {TABLE_LIMIT}: рисовать тысячи строк долго, а прочесть
                      их всё равно нельзя. Строки с ошибками показаны все.
                    </EmptyRow>
                  )}
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
        );
      })()}

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
