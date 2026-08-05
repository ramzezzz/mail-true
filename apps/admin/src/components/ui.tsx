/**
 * Мелкие элементы админки поверх компонентов из apps/web.
 * Своей дизайн-системы не заводим: Button, Checkbox, Spinner и прочее
 * берутся оттуда, здесь только композиция и служебные плашки.
 */
import { useEffect, type ReactNode } from 'react';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import type { DnsStatus } from '../api/types';
import styles from './ui.module.css';

/* ------------------------------------------------------------------ */
/* Плашка состояния                                                     */
/* ------------------------------------------------------------------ */

export type BadgeTone = 'ok' | 'warn' | 'fail' | 'muted';

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={cx(styles.badge, styles[`badge_${tone}`])}>{children}</span>;
}

const DNS_TONE: Record<DnsStatus, BadgeTone> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  unknown: 'muted',
};

const DNS_LABEL: Record<DnsStatus, string> = {
  ok: 'в порядке',
  warn: 'есть замечания',
  fail: 'не настроено',
  unknown: 'не проверялось',
};

export function DnsBadge({ status }: { status: DnsStatus }) {
  return <Badge tone={DNS_TONE[status]}>{DNS_LABEL[status]}</Badge>;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'ok' : 'fail'}>{active ? 'активен' : 'заблокирован'}</Badge>;
}

/* ------------------------------------------------------------------ */
/* Панели и сообщения                                                   */
/* ------------------------------------------------------------------ */

export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={styles.panel}>
      {title && <h2 className={styles.panelTitle}>{title}</h2>}
      {children}
    </section>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className={styles.toolbar}>{children}</div>;
}

export function ToolbarSpacer() {
  return <span className={styles.toolbarSpacer} />;
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'success';
  children: ReactNode;
}) {
  return <div className={cx(styles.notice, styles[`notice_${tone}`])}>{children}</div>;
}

/** Ошибка запроса человеческим языком. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <Notice tone="error">{message}</Notice>;
}

/* ------------------------------------------------------------------ */
/* Модальное окно                                                       */
/* ------------------------------------------------------------------ */

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={cx(styles.modal, wide && styles.modalWide)} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className={styles.modalTitle}>{title}</h2>
        {children}
        {footer !== undefined ? (
          <div className={styles.modalActions}>{footer}</div>
        ) : (
          <div className={styles.modalActions}>
            <Button mode="secondary" onClick={onClose}>
              Закрыть
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className="mt-label">{label}</label>
      {children}
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Плитки сводки и пагинация                                            */
/* ------------------------------------------------------------------ */

export function Tiles({ children }: { children: ReactNode }) {
  return <div className={styles.tiles}>{children}</div>;
}

export function Tile({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className={styles.tile}>
      <div className={styles.tileValue}>{value}</div>
      <div className={styles.tileLabel}>{label}</div>
    </div>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className={styles.pager}>
      <Button
        mode="secondary"
        size="s"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        Назад
      </Button>
      <span>
        {from}–{to} из {total}
      </span>
      <Button
        mode="secondary"
        size="s"
        disabled={to >= total}
        onClick={() => onChange(offset + limit)}
      >
        Вперёд
      </Button>
    </div>
  );
}

export const uiStyles = styles;
