/**
 * Чипы над выдачей: во что превратился запрос.
 *
 * Показывать это обязательно, и вот почему. Разборщик молча меняет смысл
 * строки: `от:волкова` перестаёт быть словами и становится условием по
 * отправителю, `Договор № 452/26: правки` — наоборот, остаётся словами.
 * Оба решения правильные, но человеку они не видны. Без чипов запрос,
 * понятый не так, неотличим от запроса, по которому ничего не нашлось, —
 * и человек правит не то, что надо.
 *
 * Чип снимается нажатием. Это не украшение: если разборщик всё-таки понял
 * кусок не так, у человека должен быть способ убрать условие, не разбираясь
 * в грамматике и не переписывая строку целиком.
 */

import type { SearchChip } from '@mail-true/shared';
import { IconClose } from '../mail/icons';
import styles from './SearchChips.module.css';

export interface SearchChipsProps {
  chips: readonly SearchChip[];
  /** Убрать условие из запроса. */
  onDrop: (chip: SearchChip) => void;
}

export function SearchChips({ chips, onDrop }: SearchChipsProps) {
  /*
   * Один-единственный чип «Слова» — это обычный поиск по словам, каким он
   * был всегда. Объяснять человеку нечего, и полоса чипов заняла бы место
   * ради пересказа того, что и так написано в поисковой строке.
   */
  if (chips.length === 0) return null;
  if (chips.length === 1 && chips[0]?.field === 'text') return null;

  return (
    <div className={styles.row} aria-label="Запрос понят так">
      <span className={styles.caption}>Запрос понят так:</span>
      {chips.map((chip) => (
        <span key={`${String(chip.field)}:${chip.value}`} className={styles.chip}>
          <span className={styles.chipTitle}>{chip.title}</span>
          <span className={styles.chipValue}>{chip.value}</span>
          <button
            type="button"
            className={styles.chipDrop}
            aria-label={`Убрать условие «${chip.title}: ${chip.value}»`}
            title="Убрать условие"
            onClick={() => onDrop(chip)}
          >
            <IconClose size={14} />
          </button>
        </span>
      ))}
    </div>
  );
}
