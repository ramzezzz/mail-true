/**
 * Мелкие элементы админки поверх компонентов из apps/web.
 * Своей дизайн-системы не заводим: Button, Checkbox, Spinner и прочее
 * берутся оттуда, здесь только композиция и служебные плашки.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@web/components';
import { cx } from '@web/lib/cx';
import { ApiError } from '../api/client';
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
/**
 * Человеческие имена полей запроса. Нужны для разбора отказа: сервер
 * называет поле так, как оно зовётся в теле запроса («displayName»),
 * а человек видел его на форме под другим именем.
 */
const FIELD_NAMES: Record<string, string> = {
  email: 'Адрес',
  password: 'Пароль',
  displayName: 'Отображаемое имя',
  quotaBytes: 'Размер ящика',
  login: 'Логин',
  source: 'Откуда',
  destination: 'Куда',
  domain: 'Домен',
  name: 'Название',
};

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  // Не Error и не строка — обычно это разобранное тело ответа. String()
  // показал бы человеку «[object Object]» вместо причины отказа.
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error);

  /*
   * Разбор по полям. Сервер присылал его всегда, а экран показывал одно
   * общее «Некорректные данные запроса»: на создании ящика пароль «123»
   * давал отказ без единого слова о причине, хотя в ответе лежало
   * «пароль короче 8 знаков» с указанием поля.
   */
  const details =
    error instanceof ApiError && error.details.length > 0 ? error.details : ([] as const);

  return (
    <Notice tone="error">
      {message}
      {details.length > 0 && (
        <ul className={styles.errorDetails}>
          {details.map((detail) => (
            <li key={`${detail.path}:${detail.message}`}>
              {detail.path === '' ? (
                detail.message
              ) : (
                <>
                  <b>{FIELD_NAMES[detail.path] ?? detail.path}</b>: {detail.message}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Notice>
  );
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

/**
 * Сколько диалог уезжает, мс. Ровно столько же длится обратный ход
 * в ui.module.css (--mt-anim-duration-m).
 */
export const MODAL_EXIT_MS = 200;

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled),' +
  ' textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Видимые элементы диалога, на которые можно встать с клавиатуры.
 *
 * Скрытое отсеиваем по вычисленным стилям, а не по offsetParent: тот
 * опирается на раскладку, которой в тестовой среде нет вовсе — там по нему
 * отсеялось бы всё содержимое диалога, и ловушка фокуса «схлопнулась» бы.
 */
function focusableIn(root: HTMLElement): HTMLElement[] {
  const view = root.ownerDocument.defaultView;
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    const style = view?.getComputedStyle(element);
    return style?.display !== 'none' && style?.visibility !== 'hidden';
  });
}

/** Переносит в копию то, чего нет в разметке: набранное в полях. */
function copyFieldValues(from: HTMLElement, to: HTMLElement): void {
  const originals = from.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  );
  const copies = to.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  originals.forEach((field, index) => {
    const copy = copies[index];
    if (!copy) return;
    copy.setAttribute('value', field.value);
    if (copy instanceof HTMLTextAreaElement) copy.textContent = field.value;
    if (field instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      copy.checked = field.checked;
    }
  });
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /*
   * Откуда пришли: туда же вернём фокус, когда диалог закроется.
   *
   * Снимаем на первом рендере, а не в эффекте: у полей в диалогах стоит
   * autoFocus, и React успевает увести фокус внутрь ещё до эффектов —
   * в эффекте «откуда пришли» оказалось бы само поле диалога, и после
   * закрытия фокус падал бы на body. Проверено живьём: возвращается
   * ровно на кнопку, которой диалог открыли.
   */
  const [opener] = useState<Element | null>(() => document.activeElement);
  /** Диалог прожил кадр. Защита от двойного вызова эффектов в StrictMode. */
  const shownRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      shownRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  /*
   * Фокус.
   *
   * Без этого Tab из открытого диалога уходил в шапку за ним: первым же
   * элементом оказывалась кнопка «Выйти», то есть клавиатурный
   * администратор был в одном Enter от выхода из панели. Заодно диалог
   * не объявлялся скринридеру — тот читает то, на чём стоит фокус.
   */
  useEffect(() => {
    const card = cardRef.current;
    // Внутри уже мог сработать autoFocus поля — не перебиваем
    if (card && !card.contains(document.activeElement)) {
      (focusableIn(card)[0] ?? card).focus();
    }
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const card = cardRef.current;
      if (!card) return;
      const stops = focusableIn(card);
      if (stops.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;
      const outside = !card.contains(active);
      if (event.shiftKey ? active === first || outside : active === last || outside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Страница под диалогом не прокручивается: иначе фон уезжает вместе с колесом
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /*
   * Уход диалога.
   *
   * Страницы закрывают диалог тем, что перестают его рисовать («Отмена»,
   * успешное сохранение), — React снимает узел сразу, и состояние
   * «закрываюсь» внутри диалога доиграть обратный ход уже не успеет.
   * Поэтому его доигрывает копия узла: она ничем не управляет
   * (pointer-events: none, inert), набранный текст в неё переносится,
   * и через MODAL_EXIT_MS она убирается сама.
   *
   * Уборка именно в useLayoutEffect: она выполняется до того, как React
   * снимет узел со страницы, поэтому подмены не видно — кадра без диалога
   * не возникает.
   */
  useLayoutEffect(
    () => () => {
      const node = backdropRef.current;
      if (!node || !shownRef.current) return;
      const backdropClosing = styles.backdropClosing;
      const modalClosing = styles.modalClosing;
      const modalClass = styles.modal;
      if (!backdropClosing || !modalClosing || !modalClass) return;

      const ghost = node.cloneNode(true) as HTMLElement;
      copyFieldValues(node, ghost);
      ghost.classList.add(backdropClosing);
      ghost.querySelector(`.${modalClass}`)?.classList.add(modalClosing);
      // Уезжающая копия не должна ловить ни Tab, ни чтение скринридером
      ghost.setAttribute('inert', '');
      ghost.setAttribute('aria-hidden', 'true');
      document.body.appendChild(ghost);
      setTimeout(() => ghost.remove(), MODAL_EXIT_MS);
    },
    [],
  );

  return (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={cx(styles.modal, wide && styles.modalWide)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className={styles.modalTitle}>
          {title}
        </h2>
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
  /*
   * Пейджер прячется, только когда листать НЕ НУЖНО, а не когда нечего
   * показать.
   *
   * Условие было одно — «записей меньше страницы», — и оно оставляло
   * человека запертым. Удалили последние записи со второй страницы (было
   * 55 ящиков, стало 50): `offset` так и остался 50, таблица пишет
   * «Ящиков пока нет», а кнопки «Назад» на экране уже нет — вернуться к
   * своим пятидесяти ящикам нечем, кроме перезагрузки страницы. То же на
   * алиасах и везде, где стоит этот пейджер.
   */
  if (total <= limit && offset === 0) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className={styles.pager}>
      {/* Подсказка объясняет, почему кнопка не нажимается: без неё
          недоступная кнопка выглядит просто сломанной. */}
      <Button
        mode="secondary"
        size="s"
        disabled={offset === 0}
        title={offset === 0 ? 'Это первая страница' : undefined}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        Назад
      </Button>
      {/*
        Страница уехала за конец списка — так бывает после удаления
        последних записей. Диапазон «51–50 из 50» человеку ничего не
        говорит, поэтому пишем прямо: смотреть тут нечего, вернитесь.
      */}
      <span>
        {offset >= total
          ? `Записей больше нет, всего: ${String(total)}`
          : `${from}–${to} из ${total}`}
      </span>
      <Button
        mode="secondary"
        size="s"
        disabled={to >= total}
        title={to >= total ? 'Это последняя страница' : undefined}
        onClick={() => onChange(offset + limit)}
      >
        Вперёд
      </Button>
    </div>
  );
}

export const uiStyles = styles;
