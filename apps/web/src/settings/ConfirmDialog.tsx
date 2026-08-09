/**
 * Окно «точно?» перед необратимым действием в настройках.
 *
 * Жило внутри страницы папок, где им подтверждают удаление и очистку.
 * Вынесено сюда, когда такое же подтверждение понадобилось правилам
 * фильтрации: правило — это несколько экранов настроенных условий и
 * действий, а удалялось оно одним щелчком по корзине, без вопроса и без
 * возможности вернуть. Восстановления правил у нас нет.
 *
 * Кнопка подтверждения стоит первой, отмена — второй: так же, как в
 * остальных окнах настроек, и на клавиатуре Tab ведёт от опасного к
 * безопасному, а не наоборот.
 */

import { Button, Modal } from '../components';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  title: string;
  text: string;
  confirmText: string;
  /** Идёт запрос: кнопки заблокированы, надпись меняется на «Выполняем…». */
  busy: boolean;
  /**
   * Отказ сервера. Раньше его вовсе не показывали: запрос падал, окно
   * закрывалось, строка возвращалась на место при следующем обновлении —
   * и выглядело это как «оно само вернулось».
   */
  error?: string | null | undefined;
  onClose(): void;
  onConfirm(): void;
}

export function ConfirmDialog({
  title,
  text,
  confirmText,
  busy,
  error,
  onClose,
  onConfirm,
}: ConfirmDialogProps): JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onClose}
      className={styles.dialog}
      footer={
        <>
          <Button disabled={busy} onClick={onConfirm}>
            {busy ? 'Выполняем…' : confirmText}
          </Button>
          <Button mode="secondary" disabled={busy} onClick={onClose}>
            Отменить
          </Button>
        </>
      }
    >
      <p className={styles.confirmText}>{text}</p>
      {error !== null && error !== undefined && error !== '' && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
