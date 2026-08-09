/**
 * Подменю «Метки»: поставить и снять метку на одном письме или сразу
 * на нескольких выделенных.
 *
 * Отдельный кусок разметки, а не пункт в каждом меню, ровно потому, что
 * мест три: контекстное меню строки списка, меню «⋯» над открытым письмом
 * и панель над списком в режиме выделения. Три копии одного списка меток
 * разошлись бы на первой же правке.
 *
 * Меню НЕ закрывается после нажатия: человек, вешающий на письмо «оплатить»
 * и «спросить у юриста», не должен открывать меню дважды.
 */

import { useNavigate } from 'react-router-dom';
import { cx } from '../lib/cx';
import { LabelPill } from './LabelPill';
import { labelPresence, nextLabelAction, type MailLabel } from './labelsApi';
import { chunkIds } from './threadList';
import { useApplyLabels, useLabelsState } from './useLabels';
import styles from './LabelMenu.module.css';

/** Что нужно знать о письме, чтобы показать состояние метки. */
export interface LabelTarget {
  id: string;
  labels: readonly string[];
}

export interface LabelMenuProps {
  /**
   * СТРОКИ, по которым считается состояние галочки: одна или всё выделение.
   * Для строки-переписки это одна запись с объединением меток разговора.
   */
  messages: readonly LabelTarget[];
  /**
   * Письма, которые menu действительно правит.
   *
   * Отдельно от `messages`, потому что строка списка бывает целой
   * перепиской: галочка показывает состояние СТРОКИ, а поставить и снять
   * метку надо на всех письмах разговора — иначе метка легла бы на одно
   * письмо из шести, а строка показала бы, что помечен весь разговор.
   * Не задано — правятся сами показанные письма.
   */
  targetIds?: readonly string[] | undefined;
  /** Позвать после изменения — например, чтобы закрыть родительское меню. */
  onApplied?: (() => void) | undefined;
}

export const LABELS_SETTINGS_PATH = '/settings/labels';

export function LabelMenu({ messages, targetIds, onApplied }: LabelMenuProps) {
  const navigate = useNavigate();
  const { items } = useLabelsState();
  const apply = useApplyLabels();
  const ids = targetIds && targetIds.length > 0 ? [...targetIds] : messages.map((m) => m.id);

  const toggle = (label: MailLabel): void => {
    const action = nextLabelAction(labelPresence(messages, label.key));
    /*
     * Порциями: маршрут принимает не больше пятисот писем за раз, а
     * заголовок меню честно пишет «Метки для 600 писем» — столько
     * набирается на длинной папке одним нажатием «выделить загруженные».
     * Один запрос на всё отвергался целиком, и метка не ставилась НИ
     * ОДНОМУ письму ровно там, где это нужнее всего. Рядом, у переноса и
     * флагов, нарезка есть — три места просто пропустили.
     */
    for (const chunk of chunkIds(ids)) {
      apply.mutate(
        action === 'add' ? { ids: chunk, add: [label.key] } : { ids: chunk, remove: [label.key] },
      );
    }
    onApplied?.();
  };

  return (
    <div className={styles.menu}>
      {/*
        Заголовок называет число ПИСЕМ, которых коснётся нажатие, а не
        число выделенных строк. Разница видна как раз там, где она важна:
        одна строка-переписка — это «Метки для 3 писем», и человек узнаёт
        об этом ДО нажатия, а не по счётчику в извещении после.
      */}
      <div className={styles.title}>
        {ids.length > 1 ? `Метки для ${String(ids.length)} писем` : 'Метки'}
      </div>

      {items.length === 0 && (
        <div className={styles.empty}>
          Меток пока нет. Их заводят в настройках — там же выбирают цвет и название.
        </div>
      )}

      {items.map((label) => {
        const presence = labelPresence(messages, label.key);
        return (
          <button
            key={label.key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={presence === 'all' ? 'true' : presence === 'some' ? 'mixed' : 'false'}
            className={styles.item}
            onClick={() => toggle(label)}
          >
            {/*
              Галочка — «стоит у всех», черта — «стоит у части выделения».
              Разные ЗНАКИ, а не разные оттенки: состояние обязано читаться
              и без различения цветов, как и сама метка.
            */}
            <span
              className={cx(styles.mark, presence !== 'none' && styles.markOn)}
              aria-hidden="true"
            >
              {presence === 'all' ? '✓' : presence === 'some' ? '–' : ''}
            </span>
            <LabelPill label={label} />
          </button>
        );
      })}

      <div className={styles.footer}>
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          onClick={() => void navigate(LABELS_SETTINGS_PATH)}
        >
          Настроить метки…
        </button>
      </div>
    </div>
  );
}
