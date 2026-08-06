/**
 * Метка письма — цветная пилюля С НАЗВАНИЕМ.
 *
 * Название рядом с цветом обязательно и не является украшением: цвет
 * различают не все, и метка, показанная одним кружком, для части людей
 * не несёт вообще ничего. Поэтому отдельного вида «только точка» здесь
 * нет и не будет.
 */

import { cx } from '../lib/cx';
import { LABEL_COLOR_TITLES, type MailLabel } from './labelsApi';
import styles from './LabelPill.module.css';

export interface LabelPillProps {
  label: MailLabel;
  /** Крупный вид — в открытом письме и в настройках. */
  large?: boolean;
  /** Снять метку прямо с пилюли. Без обработчика крестика нет. */
  onRemove?: (() => void) | undefined;
}

export function LabelPill({ label, large, onRemove }: LabelPillProps) {
  return (
    <span
      className={cx(styles.pill, styles[label.color], large && styles.large)}
      /* Подсказка называет и метку, и цвет: человеку, который цвет не
         видит, «Оплатить, красная» объясняет, о чём вообще речь в чужом
         рассказе про «красные письма». */
      title={`${label.name}, ${LABEL_COLOR_TITLES[label.color].toLowerCase()}`}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.name}>{label.name}</span>
      {onRemove && (
        <button
          type="button"
          className={styles.remove}
          aria-label={`Снять метку «${label.name}»`}
          onClick={(e) => {
            // Пилюля живёт внутри ссылки на письмо: без этого нажатие
            // на крестик заодно открывало бы письмо.
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

export interface LabelPillsProps {
  /** Ключевые слова письма — как они пришли в сводке. */
  keywords: readonly string[];
  /** Справочник ящика: без него у ключа нет ни имени, ни цвета. */
  dictionary: readonly MailLabel[];
  large?: boolean;
  onRemove?: ((key: string) => void) | undefined;
  /** Класс ряда — им строка списка ужимает пилюли под свою высоту. */
  className?: string | undefined;
}

/**
 * Все метки письма подряд.
 *
 * Порядок — справочника, а не письма: IMAP отдаёт ключевые слова в
 * произвольном порядке, и без этого одна и та же пара меток на двух
 * письмах выстраивалась бы по-разному.
 */
export function LabelPills({ keywords, dictionary, large, onRemove, className }: LabelPillsProps) {
  const lower = new Set(keywords.map((k) => k.toLowerCase()));
  const shown = dictionary.filter((label) => lower.has(label.key.toLowerCase()));
  if (shown.length === 0) return null;
  return (
    <span className={cx(styles.row, className)}>
      {shown.map((label) => (
        <LabelPill
          key={label.key}
          label={label}
          large={large ?? false}
          onRemove={onRemove ? () => onRemove(label.key) : undefined}
        />
      ))}
    </span>
  );
}
