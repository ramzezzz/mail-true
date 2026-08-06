/**
 * Один диалог вместо двух кнопок.
 *
 * Было: «Проверить DNS» отвечала плашкой «не настроено», «Что прописать»
 * показывала готовые значения — и ни одна не отвечала на вопрос, ради
 * которого их открывают: что именно не так и что с этим делать. Теперь по
 * каждой записи видно сразу пять вещей — зачем она, что должно быть
 * (с кнопкой «копировать»), что опубликовано на самом деле, вывод
 * (верно / не настроено / с ошибкой) и как исправить.
 */
import { useCallback, useState } from 'react';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import type { DnsCheck, DnsReport } from '../api/types';
import { Badge, ErrorNotice, Modal, Notice } from '../components/ui';
import {
  PROPAGATION_NOTE,
  VERDICT_LABEL,
  answerStamp,
  formatActual,
  groupChecks,
  needsAttention,
  needsPropagationNote,
  resolverNote,
  summarize,
  verdictTone,
} from '../lib/dns';
import { formatRelative } from '../lib/format';
import styles from './DnsDialog.module.css';

/**
 * Копирование в буфер.
 *
 * navigator.clipboard есть только на защищённом происхождении, а админку
 * при установке нередко открывают по http (пока не выпустился сертификат)
 * — там он просто отсутствует, и кнопка молча не работала бы. Поэтому
 * запасной путь через скрытое поле остаётся.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* попробуем запасной путь */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ value, name }: { value: string; name: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const onClick = useCallback(() => {
    void copyText(value).then((ok) => {
      setState(ok ? 'done' : 'failed');
      setTimeout(() => setState('idle'), 2000);
    });
  }, [value]);

  return (
    <>
      <Button mode="secondary" size="s" onClick={onClick} aria-label={`Скопировать значение: ${name}`}>
        Копировать
      </Button>
      {state === 'done' && (
        <span className={styles.copied} role="status">
          Скопировано
        </span>
      )}
      {state === 'failed' && (
        <span className={styles.noCopy} role="status">
          Не вышло — выделите и скопируйте вручную
        </span>
      )}
    </>
  );
}

function ValueBlock({
  label,
  value,
  empty,
  copy,
  stamp,
}: {
  label: string;
  value: string;
  empty?: boolean;
  copy?: { name: string } | null;
  /** Когда и у кого получен этот ответ. */
  stamp?: string;
}) {
  return (
    <div className={styles.value}>
      <div className={styles.valueHead}>
        <span className={styles.valueLabel}>{label}</span>
        <span className={styles.valueSpacer} />
        {copy && <CopyButton value={value} name={copy.name} />}
      </div>
      <code className={cx(styles.mono, empty === true && styles.monoEmpty)}>{value}</code>
      {stamp !== undefined && stamp !== '' && <div className={styles.stamp}>{stamp}</div>}
    </div>
  );
}

function CheckCard({
  check,
  checking,
  canCheck,
  onRecheck,
}: {
  check: DnsCheck;
  checking: boolean;
  canCheck: boolean;
  onRecheck: () => void;
}) {
  const [open, setOpen] = useState(needsAttention(check));
  const tone = verdictTone(check.verdict);
  const actual = formatActual(check);
  const stamp = answerStamp(check);

  return (
    <div className={cx(styles.card, check.status === 'fail' && styles.cardProblem)}>
      <div className={styles.headRow}>
        <button
          type="button"
          className={styles.head}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Badge tone={tone}>{checking ? 'проверяем…' : VERDICT_LABEL[check.verdict]}</Badge>
          <span className={styles.headTitle}>{check.title}</span>
          <span className={cx(styles.headName, 'mt-mono')}>
            {check.recordType} {check.recordName}
          </span>
          <span className={styles.chevron}>{open ? '▲' : '▼'}</span>
        </button>
        {canCheck && (
          <Button
            mode="tertiary"
            size="s"
            disabled={checking}
            onClick={onRecheck}
            aria-label={`Перепроверить запись ${check.recordType} ${check.recordName}`}
          >
            {checking ? 'Проверяем…' : 'Перепроверить'}
          </Button>
        )}
      </div>

      {open && (
        <div className={styles.body}>
          <p className={styles.purpose}>{check.purpose}</p>
          <p className={styles.impact}>{check.impact}</p>

          <ValueBlock
            label="Что должно быть прописано"
            value={check.expected}
            copy={check.copyable ? { name: `${check.recordType} ${check.recordName}` } : null}
          />
          {!check.copyable && (
            <p className={styles.noCopy}>
              Эту запись заводит владелец адреса (хостер), а не регистратор домена.
            </p>
          )}

          <ValueBlock
            label="Что прописано на самом деле"
            value={actual}
            empty={check.actual.length === 0}
            stamp={checking ? 'спрашиваем…' : stamp}
          />

          {check.diff && <p className={styles.diff}>Расхождение: {check.diff}</p>}

          {needsPropagationNote(check) && <p className={styles.ttl}>{PROPAGATION_NOTE}</p>}

          <p className={styles.hint}>
            <span className={styles.hintLabel}>
              {check.verdict === 'ok' ? 'Вывод: ' : 'Что сделать: '}
            </span>
            {check.hint}
          </p>
        </div>
      )}
    </div>
  );
}

export interface DnsDialogProps {
  domainName: string;
  report: DnsReport | null;
  /** Идёт общая проверка всей зоны. */
  checking: boolean;
  /** Идёт точечная перепроверка вот этих записей. */
  checkingIds: readonly string[];
  error: unknown;
  canCheck: boolean;
  onRecheck: () => void;
  onRecheckOne: (checkId: string) => void;
  onClose: () => void;
}

export function DnsDialog({
  domainName,
  report,
  checking,
  checkingIds,
  error,
  canCheck,
  onRecheck,
  onRecheckOne,
  onClose,
}: DnsDialogProps) {
  const summary = report ? summarize(report) : null;
  const resolver = report ? resolverNote(report.resolver) : null;
  const groups = report ? groupChecks(report.checks) : [];

  return (
    <Modal
      wide
      title={`DNS домена ${domainName}`}
      onClose={onClose}
      footer={
        <>
          {canCheck && (
            <span className={styles.footerLeft}>
              <Button mode="secondary" size="s" disabled={checking} onClick={onRecheck}>
                {checking ? 'Проверяем…' : 'Проверить заново'}
              </Button>
            </span>
          )}
          <Button mode="secondary" onClick={onClose}>
            Закрыть
          </Button>
        </>
      }
    >
      <ErrorNotice error={error} />

      {!report && (
        <Notice tone="info">
          {checking
            ? 'Спрашиваем внешние резольверы — это занимает несколько секунд.'
            : canCheck
              ? 'Проверка ещё не запускалась. Нажмите «Проверить заново».'
              : /*
                 * Роли «только чтение» кнопка «Проверить заново» не
                 * показывается, и совет её нажать отправлял человека искать
                 * то, чего на экране нет. Пустой экран без объяснения не
                 * лучше: говорим прямо, чего не хватает и к кому идти.
                 */
                'Проверка ещё не запускалась, а запускать её может только тот, ' +
                'кому доверено управление доменами. Попросите администратора ' +
                'с такими правами открыть этот домен — отчёт появится здесь.'}
        </Notice>
      )}

      {report && summary && resolver && (
        <>
          <div className={styles.summary}>
            <Badge tone={summary.tone}>{summary.headline}</Badge>
            <span className={styles.meta}>
              проверено {formatRelative(report.checkedAt)} · записей {summary.total} · в порядке{' '}
              {summary.ok}
            </span>
          </div>
          <p className={styles.resolverNote}>{resolver.text}</p>
          <p className={styles.resolverNote}>
            {PROPAGATION_NOTE} Время ответа показано у каждой записи отдельно — её можно
            перепроверить одну, не дожидаясь остальных.
          </p>

          {groups.map((group) => (
            <section key={group.group}>
              <h3 className={styles.groupTitle}>
                {group.title}
                {group.problems > 0 && ` — требуют внимания: ${String(group.problems)}`}
              </h3>
              <p className={styles.groupNote}>{group.note}</p>
              {group.checks.map((check) => (
                <CheckCard
                  key={check.id}
                  check={check}
                  canCheck={canCheck}
                  checking={checking || checkingIds.includes(check.id)}
                  onRecheck={() => onRecheckOne(check.id)}
                />
              ))}
            </section>
          ))}
        </>
      )}
    </Modal>
  );
}
