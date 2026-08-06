/**
 * Кнопка «Отложить» с меню сроков.
 *
 * Один компонент на все места, откуда письмо откладывают: панель действий
 * над выделенными письмами, панель открытого письма, контекстное меню
 * строки. Иначе набор сроков разъехался бы: в одном месте «через неделю»
 * есть, в другом нет.
 *
 * ГОТОВЫЕ СРОКИ БЕЗ ЧАСОВ. В меню стоят только названия — «Завтра утром»,
 * «В понедельник», «Через неделю», — а точный час человек узнаёт из
 * подтверждения после нажатия («Письмо вернётся завтра в 08:00»). Так
 * сделано намеренно: час считает сервер (по поясу браузера, но по своим
 * правилам), и посчитать его здесь ещё раз ради подписи в меню значило бы
 * завести второй расчёт того же самого. Два расчёта рано или поздно
 * разойдутся — и человек увидит в меню один час, а письмо приедет в другой.
 */

import { useState } from 'react';
import { Button, Dropdown, MenuItem, MenuSeparator, useDropdownClose } from '../components';
import { IconClock } from './icons';
import styles from './SnoozeMenu.module.css';
import {
  PRESET_TITLES,
  defaultCustomWake,
  fromLocalInputValue,
  toLocalInputValue,
  type SnoozePreset,
} from './snoozeApi';

export interface SnoozeMenuProps {
  /** Выбран срок: готовый или произвольный (ISO). */
  onSnooze(choice: { preset: SnoozePreset; until?: string }): void;
  /**
   * Возврат по расписанию не работает (не настроен служебный доступ
   * Dovecot). Отложить всё ещё можно — но об этом надо предупредить.
   */
  scheduledReturn?: boolean;
  /** Нечего откладывать: ни одного письма не выбрано. */
  disabled?: boolean;
  /** Вид кнопки: в панелях — третичная, в узких местах — только значок. */
  align?: 'left' | 'right';
}

/** Поле произвольной даты. Отдельным компонентом — ему нужен close(). */
function CustomWake({ onPick }: { onPick(iso: string): void }) {
  const close = useDropdownClose();
  const [value, setValue] = useState(() => toLocalInputValue(defaultCustomWake()));

  const submit = (): void => {
    const at = fromLocalInputValue(value);
    // Пустое или недобранное поле просто ничего не делает: сообщать
    // «введите дату» человеку, который её как раз вводит, незачем.
    if (!at) return;
    onPick(at.toISOString());
    close();
  };

  return (
    <div className={styles.custom}>
      <input
        className={styles.customInput}
        type="datetime-local"
        value={value}
        aria-label="Дата и время возврата"
        onChange={(e) => setValue(e.target.value)}
        /* Enter в поле — это «готово». Без этого дату можно было бы
           набрать и не суметь применить, не отпустив клавиатуру. */
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          submit();
        }}
      />
      <Button mode="secondary" size="s" onClick={submit}>
        Отложить
      </Button>
    </div>
  );
}

export function SnoozeMenu({
  onSnooze,
  scheduledReturn = true,
  disabled,
  align = 'left',
}: SnoozeMenuProps) {
  return (
    <Dropdown
      align={align}
      menuClassName={styles.menu}
      trigger={({ toggle }) => (
        <Button mode="tertiary" before={<IconClock />} onClick={toggle} disabled={disabled}>
          Отложить
        </Button>
      )}
    >
      <div className={styles.title}>Вернуть письмо во «Входящие»</div>
      {(Object.keys(PRESET_TITLES) as Array<Exclude<SnoozePreset, 'custom'>>).map((preset) => (
        <MenuItem key={preset} before={<IconClock />} onClick={() => onSnooze({ preset })}>
          {PRESET_TITLES[preset]}
        </MenuItem>
      ))}
      <MenuSeparator />
      <CustomWake onPick={(until) => onSnooze({ preset: 'custom', until })} />
      {!scheduledReturn && (
        <p className={styles.warning}>
          Возврат по расписанию сейчас не работает: письмо придётся вернуть вручную из
          папки «Отложенные».
        </p>
      )}
    </Dropdown>
  );
}
