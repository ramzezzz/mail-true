/**
 * Групповая установка подписей по шаблону.
 *
 * Порядок работы задан требованием и нарушить его нельзя: выбрать ящики
 * (отметить в списке или взять домен целиком) → написать шаблон →
 * ПОСМОТРЕТЬ ПРЕДПРОСМОТР НА ЖИВОМ ЧЕЛОВЕКЕ → применить. Кнопка
 * «Применить» до предпросмотра не работает вовсе, а если предпросмотр
 * насчитал уничтоженные чужие подписи — требует отдельной отмашки.
 *
 * Число уничтожаемых подписей показывается всегда и первым: молча
 * затирать чужую подпись нельзя, и «применится к 137 ящикам» этого
 * числа не заменяет.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { Button, Checkbox } from '@web/components';
import { api } from '../api/client';
import type {
  SignatureBulkMode,
  SignatureBulkPreview,
  SignatureBulkRequest,
  SignatureBulkResult,
} from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { EmptyRow, Table, TableWrap, tableStyles } from '../components/Table';
import { ErrorNotice, Field, Notice, Panel, Toolbar, ToolbarSpacer } from '../components/ui';
import {
  bulkNeedsConfirmation,
  bulkResultText,
  bulkSummaryText,
  MODE_LABELS,
  OUTCOME_LABELS,
} from '../lib/signatureBulk';
import styles from './UserSettingsPage.module.css';

const MODES: SignatureBulkMode[] = ['append', 'replace', 'skip-existing'];

const DEFAULT_TEMPLATE = '--\n{{имя}}\n{{должность}}, {{отдел}}\n{{адрес}} | {{телефон}}';

export function SignatureBulkPage() {
  const { can } = useSession();
  const location = useLocation();
  /** Отмеченные в списке ящики приезжают сюда из раздела «Пользователи». */
  const preselected = (location.state as { ids?: number[] } | null)?.ids ?? [];

  const [scope, setScope] = useState<'selected' | 'domain'>(
    preselected.length > 0 ? 'selected' : 'domain',
  );
  const [domainId, setDomainId] = useState<number | undefined>(undefined);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [name, setName] = useState('Корпоративная подпись');
  const [mode, setMode] = useState<SignatureBulkMode>('append');
  const [makeDefault, setMakeDefault] = useState(true);
  const [skipIncomplete, setSkipIncomplete] = useState(true);
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [previewEmail, setPreviewEmail] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<SignatureBulkPreview | null>(null);
  /** Тело запроса, по которому считали предпросмотр (см. `stale` ниже). */
  const [previewedBody, setPreviewedBody] = useState<string | null>(null);
  const [result, setResult] = useState<SignatureBulkResult | null>(null);

  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.domains() });
  const variables = useQuery({
    queryKey: ['signature-variables'],
    queryFn: () => api.signatureVariables(),
  });

  const body: SignatureBulkRequest = useMemo(
    () => ({
      ...(scope === 'selected' ? { ids: preselected } : {}),
      ...(scope === 'domain' && domainId !== undefined ? { domainId } : {}),
      template,
      name,
      mode,
      makeDefault,
      skipIncomplete,
      extras,
      ...(previewEmail.trim() !== '' ? { previewEmail: previewEmail.trim() } : {}),
    }),
    [
      scope,
      preselected,
      domainId,
      template,
      name,
      mode,
      makeDefault,
      skipIncomplete,
      extras,
      previewEmail,
    ],
  );

  const runPreview = useMutation({
    mutationFn: () => api.signatureBulkPreview(body),
    onSuccess: (data) => {
      setPreview(data);
      setPreviewedBody(JSON.stringify(body));
      setResult(null);
      // Любое новое вычисление сбрасывает отмашку: подтверждали другое.
      setConfirmed(false);
    },
  });

  const apply = useMutation({
    mutationFn: () => api.signatureBulkApply(body),
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      setPreviewedBody(null);
      setConfirmed(false);
    },
  });

  if (!can('usersettings.bulk')) {
    return (
      <>
        <PageTitle title="Подписи по шаблону" />
        <Notice tone="error">
          Групповая установка подписей доступна только роли «Полный доступ»: она правит подписи
          сразу во многих чужих ящиках и не откатывается.
        </Notice>
      </>
    );
  }

  /*
   * Предпросмотр устаревает от любой правки условий.
   *
   * Без этой проверки получалось так: посчитали предпросмотр в режиме
   * «добавить», убедились, что ничего не затирается, переключили режим
   * на «заменить» и нажали «Применить» — уничтожив подписи, о которых
   * предупреждения не было. Сравниваем ровно то тело запроса, которое
   * уйдёт на сервер.
   */
  const stale = preview !== null && previewedBody !== JSON.stringify(body);

  const needsConfirmation = preview !== null && bulkNeedsConfirmation(preview);
  const canApply =
    preview !== null &&
    !stale &&
    preview.problem === null &&
    preview.willAdd + preview.willReplace > 0 &&
    (!needsConfirmation || confirmed);

  const manualVariables = (variables.data?.items ?? []).filter((v) => v.manual);

  return (
    <>
      <PageTitle
        title="Подписи по шаблону"
        subtitle="Одна подпись сразу нескольким ящикам: с предпросмотром и без молчаливого затирания"
      />

      <ErrorNotice error={runPreview.error ?? apply.error} />

      {result && (
        <Notice tone="success">
          {bulkResultText(result.applied, result.total, result.failed.length)} Каждый изменённый
          ящик отдельной строкой попал в журнал аудита.
          {result.failed.length > 0 && (
            <ul>
              {result.failed.map((f) => (
                <li key={f.email}>
                  {f.email}: {f.error}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      {/* ---------------- 1. Кому ---------------- */}
      <Panel title="1. Кому ставим подпись">
        <div className={styles.grid}>
          <label className={styles.row}>
            <input
              type="radio"
              name="scope"
              checked={scope === 'selected'}
              disabled={preselected.length === 0}
              onChange={() => setScope('selected')}
            />
            <span>
              Отмеченные в списке ящики ({preselected.length}).{' '}
              {preselected.length === 0 && (
                <Link to="/users">Отметьте нужные в разделе «Пользователи»</Link>
              )}
            </span>
          </label>
          <label className={styles.row}>
            <input
              type="radio"
              name="scope"
              checked={scope === 'domain'}
              onChange={() => setScope('domain')}
            />
            <span>Все ящики домена</span>
            <select
              className="mt-select"
              style={{ width: 220 }}
              value={domainId ?? ''}
              disabled={scope !== 'domain'}
              onChange={(e) =>
                setDomainId(e.target.value === '' ? undefined : Number(e.target.value))
              }
            >
              <option value="">— выберите домен —</option>
              {(domains.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.userCount})
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      {/* ---------------- 2. Шаблон ---------------- */}
      <Panel title="2. Шаблон подписи">
        <div className={styles.grid}>
          <Field label="Название подписи" hint="Так она будет называться в настройках у людей">
            <input className="mt-input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field
            label="Текст шаблона"
            hint={
              <>
                Подстановки:{' '}
                {(variables.data?.items ?? []).map((v) => (
                  <code key={v.name} className="mt-mono" style={{ marginRight: 8 }} title={v.hint}>
                    {`{{${v.name}}}`}
                  </code>
                ))}
              </>
            }
          >
            <textarea
              className={`mt-input ${styles.textarea}`}
              style={{ minHeight: 140 }}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
          </Field>

          {manualVariables.length > 0 && (
            <Field
              label="Общие значения"
              hint="Этих сведений в карточках ящиков нет — они одни на всю рассылку"
            >
              <div className={styles.row}>
                {manualVariables.map((v) => (
                  <input
                    key={v.name}
                    className="mt-input"
                    style={{ width: 180 }}
                    placeholder={v.name}
                    value={extras[v.name] ?? ''}
                    onChange={(e) => setExtras({ ...extras, [v.name]: e.target.value })}
                  />
                ))}
              </div>
            </Field>
          )}
        </div>
      </Panel>

      {/* ---------------- 3. Что делать с существующими ---------------- */}
      <Panel title="3. Что делать с уже существующими подписями">
        <div className={styles.grid}>
          {MODES.map((value) => (
            <label key={value} className={styles.row}>
              <input
                type="radio"
                name="mode"
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  setConfirmed(false);
                }}
              />
              <span>{MODE_LABELS[value]}</span>
            </label>
          ))}
          <label className={styles.row}>
            <Checkbox checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            <span>Сделать новую подпись основной</span>
          </label>
          <label className={styles.row}>
            <Checkbox
              checked={skipIncomplete}
              onChange={(e) => setSkipIncomplete(e.target.checked)}
            />
            <span>
              Пропускать ящики, у которых не хватает данных для подстановки (иначе подпись выйдет с
              пустой строкой вместо имени)
            </span>
          </label>
        </div>
      </Panel>

      {/* ---------------- 4. Предпросмотр ---------------- */}
      <Panel title="4. Предпросмотр">
        <Toolbar>
          <input
            className="mt-input"
            style={{ width: 260 }}
            placeholder="Показать на адресе (необязательно)"
            value={previewEmail}
            onChange={(e) => setPreviewEmail(e.target.value)}
          />
          <ToolbarSpacer />
          <Button size="s" disabled={runPreview.isPending} onClick={() => runPreview.mutate()}>
            {runPreview.isPending ? 'Считаем…' : 'Посчитать и показать'}
          </Button>
        </Toolbar>

        {preview?.problem && <Notice tone="error">{preview.problem}</Notice>}

        {preview && (
          <>
            <div className={styles.counts}>
              <div
                className={`${styles.count} ${preview.signaturesReplaced > 0 ? styles.countDanger : ''}`}
              >
                <span className={styles.countValue}>{preview.signaturesReplaced}</span>
                <span className={styles.countLabel}>чужих подписей будет затёрто</span>
              </div>
              <div className={styles.count}>
                <span className={styles.countValue}>{preview.willAdd + preview.willReplace}</span>
                <span className={styles.countLabel}>ящиков получат подпись</span>
              </div>
              <div className={styles.count}>
                <span className={styles.countValue}>
                  {preview.willSkipExisting + preview.willSkipIncomplete}
                </span>
                <span className={styles.countLabel}>будут пропущены</span>
              </div>
              <div className={styles.count}>
                <span className={styles.countValue}>{preview.total}</span>
                <span className={styles.countLabel}>всего в выборке</span>
              </div>
            </div>

            <Notice tone={preview.signaturesReplaced > 0 ? 'error' : 'info'}>
              {bulkSummaryText(preview)}
            </Notice>

            {preview.sample && (
              <Field
                label={`Так это будет выглядеть у ${preview.sample.email}`}
                hint={
                  preview.sample.missing.length > 0
                    ? `Не заполнено: ${preview.sample.missing.join(', ')}`
                    : undefined
                }
              >
                <div className={styles.preview}>{preview.sample.text}</div>
              </Field>
            )}

            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Ящик</th>
                    <th>Имя</th>
                    <th className={tableStyles.numeric}>Подписей сейчас</th>
                    <th>Что будет</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="mt-mono">{row.email}</td>
                      <td>{row.displayName ?? '—'}</td>
                      <td className={tableStyles.numeric}>{row.existing}</td>
                      <td>
                        {OUTCOME_LABELS[row.outcome]}
                        {row.missing.length > 0 && ` (${row.missing.join(', ')})`}
                      </td>
                    </tr>
                  ))}
                  {preview.rows.length === 0 && <EmptyRow colSpan={4}>Выборка пуста</EmptyRow>}
                </tbody>
              </Table>
            </TableWrap>
            {preview.rowsTruncated > 0 && (
              <p className={styles.muted}>…и ещё {preview.rowsTruncated} ящиков</p>
            )}
          </>
        )}
      </Panel>

      {/* ---------------- 5. Применение ---------------- */}
      <Panel title="5. Применение">
        {preview === null ? (
          <Notice tone="info">
            Сначала посчитайте предпросмотр: применять шаблон вслепую нельзя.
          </Notice>
        ) : (
          <div className={styles.grid}>
            {stale && (
              <Notice tone="error">
                Условия изменились после предпросмотра. Посчитайте его заново — иначе применится не
                то, что вам показали.
              </Notice>
            )}
            {needsConfirmation && (
              <label className={styles.row}>
                <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>
                  Да, я понимаю, что {preview.signaturesReplaced} существующих подписей будут
                  уничтожены без возможности восстановления
                </span>
              </label>
            )}
            <Toolbar>
              <ToolbarSpacer />
              <Button
                disabled={!canApply || apply.isPending}
                title={
                  needsConfirmation && !confirmed
                    ? 'Подтвердите затирание существующих подписей'
                    : undefined
                }
                onClick={() => apply.mutate()}
              >
                {apply.isPending ? 'Применяем…' : 'Применить'}
              </Button>
            </Toolbar>
          </div>
        )}
      </Panel>
    </>
  );
}
