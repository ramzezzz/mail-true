/**
 * Резервные копии НАСТРОЕК: создать и восстановить.
 *
 * Требование заказчика дословно: «Возможность создавать\восстанавливать
 * Резервные копии настроек».
 *
 * Настройки — не письма. Письма, очередь и саму базу снимает
 * install/backup.sh и возвращает install/restore.sh; дублировать их здесь
 * нечем и незачем. Здесь то, что администратор набивал руками: домены и
 * ключи подписи, ящики, алиасы, администраторы, правила и подписи
 * пользователей, помощник ИИ, оформление входа. Об этом сказано прямо на
 * странице, иначе «резервная копия» в панели прочитается как копия почты,
 * и человек однажды обнаружит, что писем в ней нет.
 *
 * Восстановление в два шага и иначе быть не может: сначала показывается
 * план — что появится, что перезапишется, чего операция не коснётся, —
 * и только потом применение. Копия трогает пароли ящиков и учётные записи
 * администраторов, включая учётку того, кто её восстанавливает.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type { BackupPreviewResponse, BackupRestoreResponse } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { ErrorNotice, Notice, Panel } from '../components/ui';
import { formatDateTime } from '../lib/format';

const MUTED = { color: 'var(--mt-admin-muted)' } as const;

export function BackupPage() {
  const { can } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [preview, setPreview] = useState<BackupPreviewResponse | null>(null);
  const [result, setResult] = useState<BackupRestoreResponse | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);

  const info = useQuery({
    queryKey: ['backup', 'sections'],
    queryFn: () => api.backupSections(),
    enabled: can('backup.export'),
  });

  const exportBackup = useMutation({
    mutationFn: () => api.backupExport(),
    onSuccess: ({ blob, filename }) => {
      // Скачивание делает браузер: сохранять файл на сервере нельзя —
      // копия с хэшами паролей не должна лежать рядом с продуктом.
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setFlash(`Копия сохранена: ${filename}`);
    },
  });

  const previewBackup = useMutation({
    mutationFn: (file: File) => api.backupPreview(file),
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      setSkipped(new Set());
    },
  });

  const restore = useMutation({
    mutationFn: ({ file, sections }: { file: File; sections: string[] }) =>
      api.backupRestore(file, sections),
    onSuccess: (data) => {
      setResult(data);
      setFlash('Настройки восстановлены.');
    },
  });

  const chooseFile = (file: File | null): void => {
    setChosen(file);
    setPreview(null);
    setResult(null);
    setFlash(null);
    if (file) previewBackup.mutate(file);
  };

  const selected = (preview?.plan.sections ?? [])
    .filter((s) => !skipped.has(s.id))
    .map((s) => s.id);

  return (
    <>
      <PageTitle
        title="Резервные копии настроек"
        subtitle="Домены, ящики, алиасы, администраторы, правила пользователей и оформление входа"
      />

      {flash && <Notice tone="success">{flash}</Notice>}
      <ErrorNotice error={exportBackup.error ?? previewBackup.error ?? restore.error} />

      <Notice tone="info">
        Это копия <b>настроек</b>, а не писем. Письма, очередь и саму базу снимает скрипт{' '}
        <code>install/backup.sh</code> на сервере, восстанавливает — <code>install/restore.sh</code>.
        Настроечная копия весит килобайты и переносится на другую установку.
      </Notice>

      <Panel title="Создать копию">
        {info.data && (
          <>
            <p style={MUTED}>В копию входят:</p>
            <ul style={{ ...MUTED, margin: '0 0 0.8rem 1.1rem' }}>
              {info.data.sections.map((section) => (
                <li key={section.id}>{section.title}</li>
              ))}
            </ul>
            <Notice tone="info">{info.data.secretsNote}</Notice>
            <p style={{ ...MUTED, fontSize: '0.85rem' }}>
              Версия формата копии: {info.data.formatVersion}. Номер лежит внутри файла и
              проверяется при восстановлении: копия, снятая другой версией продукта, не будет
              применена частично и молча.
            </p>
          </>
        )}
        {can('backup.export') ? (
          <Button size="s" disabled={exportBackup.isPending} onClick={() => exportBackup.mutate()}>
            {exportBackup.isPending ? 'Собираем…' : 'Скачать копию настроек'}
          </Button>
        ) : (
          <Notice tone="info">
            Скачивать копию может только администратор с полным доступом: внутри хэши паролей.
          </Notice>
        )}
      </Panel>

      <Panel title="Восстановить из копии">
        {!can('backup.restore') ? (
          <Notice tone="info">
            Восстанавливать настройки может только администратор с полным доступом.
          </Notice>
        ) : (
          <>
            <p style={MUTED}>
              Сначала выберите файл — панель покажет, что именно изменится. Ничего не
              применяется, пока вы не нажмёте «Восстановить».
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = '';
                chooseFile(file);
              }}
            />
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
              <Button mode="secondary" size="s" onClick={() => fileRef.current?.click()}>
                Выбрать файл копии
              </Button>
              {chosen && <span style={MUTED}>{chosen.name}</span>}
              {previewBackup.isPending && <span style={MUTED}>Разбираем…</span>}
            </div>
          </>
        )}

        {preview && chosen && (
          <div style={{ marginTop: '1.1rem' }}>
            <p style={MUTED}>
              Копия от {formatDateTime(preview.plan.createdAt)}, сервер{' '}
              {preview.plan.source.hostname || 'не указан'}, формат {preview.plan.version}.
            </p>

            {preview.plan.warnings.map((warning) => (
              <Notice key={warning} tone="info">
                {warning}
              </Notice>
            ))}

            {preview.plan.sections.map((section) => {
              const off = skipped.has(section.id);
              const nothing = section.create.length === 0 && section.overwrite.length === 0;
              return (
                <div
                  key={section.id}
                  style={{
                    margin: '0.7rem 0',
                    padding: '0.8rem 1rem',
                    border: '1px solid var(--mt-admin-border, rgba(127,127,127,0.25))',
                    borderRadius: 10,
                    opacity: off ? 0.55 : 1,
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={() =>
                        setSkipped((prev) => {
                          const next = new Set(prev);
                          if (next.has(section.id)) next.delete(section.id);
                          else next.add(section.id);
                          return next;
                        })
                      }
                    />
                    <b>{section.title}</b>
                  </label>

                  {nothing ? (
                    <div style={{ ...MUTED, fontSize: '0.85rem' }}>
                      В копии этого раздела нет — меняться нечему.
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.85rem', marginTop: '0.4rem' }}>
                      {section.create.length > 0 && (
                        <div>
                          Появится ({section.create.length}):{' '}
                          <span style={MUTED}>{list(section.create)}</span>
                        </div>
                      )}
                      {/* Главное на странице: что именно будет ПЕРЕЗАПИСАНО.
                          Числом здесь не отделаться — человек должен увидеть
                          имена и узнать среди них свои. */}
                      {section.overwrite.length > 0 && (
                        <div>
                          <b>Будет перезаписано ({section.overwrite.length}):</b>{' '}
                          <span style={MUTED}>{list(section.overwrite)}</span>
                        </div>
                      )}
                      {section.untouched > 0 && (
                        <div style={MUTED}>
                          Не тронуто: {section.untouched} — этого в копии нет, останется как есть.
                        </div>
                      )}
                    </div>
                  )}

                  {section.warnings.map((warning) => (
                    <Notice key={warning} tone="info">
                      {warning}
                    </Notice>
                  ))}
                </div>
              );
            })}

            <Button
              size="s"
              disabled={restore.isPending || selected.length === 0}
              onClick={() => {
                setFlash(null);
                restore.mutate({ file: chosen, sections: selected });
              }}
            >
              {restore.isPending ? 'Восстанавливаем…' : 'Восстановить выбранное'}
            </Button>
          </div>
        )}

        {result && (
          <div style={{ marginTop: '1rem' }}>
            <Notice tone="success">
              Применено:{' '}
              {Object.entries(result.applied)
                .map(([id, counts]) => `${id} — создано ${counts.created}, обновлено ${counts.updated}`)
                .join('; ') || 'изменений не потребовалось'}
            </Notice>
            {result.note && <Notice tone="info">{result.note}</Notice>}
            {result.brandingError && (
              <Notice tone="error">
                Всё перечисленное выше восстановлено, а оформление входа — нет:{' '}
                {result.brandingError}. Логотип и подписи остались прежними; повторять
                восстановление целиком ради них не нужно, задайте их в разделе «Оформление
                входа».
              </Notice>
            )}
            {result.sieve.errors.length > 0 && (
              <Notice tone="error">
                Правила восстановлены в базе, но файл правил не переписан у:{' '}
                {result.sieve.errors.join('; ')}. Пока это так, письма будут раскладываться
                по-старому.
              </Notice>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}

/** Длинный перечень режем: полсотни адресов подряд читать невозможно. */
function list(items: readonly string[]): string {
  const shown = items.slice(0, 12);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} и ещё ${rest}` : shown.join(', ');
}
