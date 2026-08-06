/**
 * Кнопка «Напомнить, если не ответят» с меню сроков.
 *
 * Устроена как SnoozeMenu и намеренно похожа на неё: это две половины
 * одного действия — «убрать с глаз до срока» и «вернуть к сроку, если
 * собеседник промолчит», — и человек должен узнавать их как родственные.
 *
 * ЧТО ЗДЕСЬ ДРУГОЕ, И ЭТО ГЛАВНОЕ. Заголовок меню говорит не «вернуть
 * письмо», а «напомнить, ЕСЛИ не ответят». Разница не в словах: письмо,
 * которое возвращается всегда, — это ещё один пункт в списке дел, и через
 * неделю человек перестаёт его замечать. Возможность стоит ровно того,
 * что оно возвращается ТОЛЬКО при молчании собеседника, и сказать об этом
 * надо там, где человек выбирает срок.
 *
 * Готовые сроки — те же самые, что у откладывания, и по той же причине:
 * час считает сервер, и второй расчёт ради подписи в меню разошёлся бы
 * с первым.
 */

import { useState } from 'react';
import { Button, Dropdown, MenuItem, MenuSeparator, useDropdownClose } from '../components';
import { IconAwaitReply } from './icons';
import styles from './SnoozeMenu.module.css';
import {
  PRESET_TITLES,
  defaultCustomWake,
  fromLocalInputValue,
  toLocalInputValue,
  type SnoozePreset,
} from './snoozeApi';

export interface AwaitReplyMenuProps {
  /** Выбран срок: готовый или произвольный (ISO). */
  onWait(choice: { preset: SnoozePreset; until?: string }): void;
  /**
   * Сервер не сможет проверить срок сам (не настроен служебный доступ
   * Dovecot). Поставить ожидание всё ещё можно — но об этом надо
   * предупредить ДО того, как человек на него понадеется.
   */
  scheduledCheck?: boolean;
  disabled?: boolean;
  align?: 'left' | 'right';
}

/** Поле произвольной даты. Отдельным компонентом — ему нужен close(). */
function CustomDue({ onPick }: { onPick(iso: string): void }) {
  const close = useDropdownClose();
  const [value, setValue] = useState(() => toLocalInputValue(defaultCustomWake()));

  const submit = (): void => {
    const at = fromLocalInputValue(value);
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
        aria-label="Дата и время напоминания"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          submit();
        }}
      />
      <Button mode="secondary" size="s" onClick={submit}>
        Напомнить
      </Button>
    </div>
  );
}

export function AwaitReplyMenu({
  onWait,
  scheduledCheck = true,
  disabled,
  align = 'left',
}: AwaitReplyMenuProps) {
  return (
    <Dropdown
      align={align}
      menuClassName={styles.menu}
      trigger={({ toggle }) => (
        <Button mode="tertiary" before={<IconAwaitReply />} onClick={toggle} disabled={disabled}>
          Ждать ответа
        </Button>
      )}
    >
      <div className={styles.title}>Напомнить, если не ответят</div>
      {(Object.keys(PRESET_TITLES) as Array<Exclude<SnoozePreset, 'custom'>>).map((preset) => (
        <MenuItem key={preset} before={<IconAwaitReply />} onClick={() => onWait({ preset })}>
          {PRESET_TITLES[preset]}
        </MenuItem>
      ))}
      <MenuSeparator />
      <CustomDue onPick={(until) => onWait({ preset: 'custom', until })} />
      {!scheduledCheck && (
        <p className={styles.warning}>
          Проверить ответ в срок сейчас некому: служебный доступ к почтовому серверу не настроен.
        </p>
      )}
    </Dropdown>
  );
}
