/**
 * Действия в строке таблицы админки — один компонент на все таблицы
 * (ящики, алиасы, домены).
 *
 * Что было: шесть текстовых кнопок в строке списка ящиков переставали
 * помещаться. На окне 1440 таблице не хватало 47 точек, на 1280 — 207,
 * и «Войти в ящик» с «Удалить» оказывались за правым краем, внутри
 * прокрутки, о которой человек не догадывается.
 *
 * Что стало: значок, раскрывающийся вправо в подпись при наведении и
 * при фокусе с клавиатуры. Место под раскрытие зарезервировано в самой
 * полосе (см. RowActions.module.css), поэтому раскрытие никогда не
 * расширяет колонку и ничего не выталкивает за край.
 *
 * Доступность — не после, а вместо красоты:
 *  - у каждой кнопки есть `aria-label`. Подпись, появляющаяся при
 *    наведении, доступным именем НЕ является: без мыши её не видно,
 *    а экранный диктор без aria-label прочитал бы безымянную кнопку.
 *    Сама подпись помечена `aria-hidden`, чтобы имя не читалось дважды;
 *  - `:focus-visible` раскрывает кнопку так же, как наведение;
 *  - на касании (`hover: none`) раскрытия нет вовсе — подписи показаны
 *    сразу, потому что пальцем смысл значка не выяснить;
 *  - `prefers-reduced-motion` убирает ход, но не подпись.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './RowActions.module.css';

export interface RowAction {
  /** Ключ для React и для проверок. */
  id: string;
  /** Значок. Рисуется, но для доступности его не существует. */
  icon: ReactNode;
  /**
   * Подпись. Она же доступное имя кнопки (aria-label), она же текст,
   * раскрывающийся при наведении. Один источник — чтобы то, что человек
   * видит, и то, что читает диктор, не разошлись.
   */
  label: string;
  onClick?: (() => void) | undefined;
  /** Действие — переход по адресу; тогда это ссылка, а не кнопка. */
  to?: string | undefined;
  /**
   * Опасное действие (удаление, блокировка). Отделяется от частых
   * промежутком: промах мыши не должен стоить ящика.
   */
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  /**
   * Уточнение для подсказки браузера. Доступным именем не является —
   * им остаётся label.
   */
  title?: string | undefined;
}

/**
 * Кому принадлежит строка — попадает в доступное имя.
 * «Удалить» в списке из одиннадцати строк без адреса ящика ничего не
 * значит: диктор прочитает одиннадцать одинаковых кнопок подряд.
 */
export interface RowActionsProps {
  actions: readonly RowAction[];
  /** Адрес ящика, имя домена, алиас — то, над чем действие совершается. */
  subject: string;
}

export function RowActions({ actions, subject }: RowActionsProps) {
  const visible = actions.filter((a) => a !== null && a !== undefined);
  /*
   * Опасные уходят в конец: рядом с частыми действиями им не место,
   * а порядок «сначала обычное, потом опасное» одинаков во всех таблицах.
   */
  const usual = visible.filter((a) => !a.danger);
  const dangerous = visible.filter((a) => a.danger);
  const ordered = [...usual, ...dangerous];

  return (
    <div
      className={styles.actions}
      // Ширину полосы считает CSS, но число кнопок знает только разметка:
      // оно зависит от прав смотрящего.
      style={{ ['--mt-row-action-count' as string]: String(ordered.length) }}
    >
      {ordered.map((action, index) => (
        <RowActionItem
          key={action.id}
          action={action}
          subject={subject}
          /* Промежуток ровно перед первым опасным действием. */
          separated={action.danger === true && index > 0 && ordered[index - 1]?.danger !== true}
        />
      ))}
    </div>
  );
}

function RowActionItem({
  action,
  subject,
  separated,
}: {
  action: RowAction;
  subject: string;
  separated: boolean;
}) {
  const name = `${action.label}: ${subject}`;
  const className = `${styles.action}${action.danger ? ` ${styles.action_danger}` : ''}`;
  const inner = (
    <>
      <span className={styles.icon}>{action.icon}</span>
      {/* Раскрывающаяся подпись. Для диктора её нет: имя даёт aria-label. */}
      <span className={styles.label} aria-hidden="true">
        {action.label}
      </span>
    </>
  );

  return (
    <>
      {separated && <span className={styles.separator} aria-hidden="true" />}
      {action.to !== undefined ? (
        <Link
          to={action.to}
          className={className}
          aria-label={name}
          title={action.title ?? action.label}
        >
          {inner}
        </Link>
      ) : (
        <button
          type="button"
          className={className}
          aria-label={name}
          title={action.title ?? action.label}
          disabled={action.disabled ?? false}
          onClick={action.onClick}
        >
          {inner}
        </button>
      )}
    </>
  );
}
