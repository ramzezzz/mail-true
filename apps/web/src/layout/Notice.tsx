/**
 * Плашка отказа поверх интерфейса.
 *
 * Раньше ошибки мутаций пропадали бесследно: не отправилось письмо — кнопка
 * просто переставала мигать, не переместилось — список молча оставался
 * прежним. Теперь любой отказ виден и закрывается вручную либо сам.
 */

import { useEffect } from 'react';
import { useUiStore } from '../app/store';
import { IconButton } from '../components';
import { IconClose } from '../mail/icons';
import styles from './Notice.module.css';

/** Через сколько плашка исчезает сама. */
const HIDE_AFTER_MS = 8000;

export function Notice() {
  const notice = useUiStore((s) => s.notice);
  const clearNotice = useUiStore((s) => s.clearNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clearNotice, HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [notice, clearNotice]);

  if (!notice) return null;

  return (
    <div className={styles.notice} role="alert">
      <span className={styles.text}>{notice}</span>
      <IconButton label="Закрыть" size="s" onClick={clearNotice}>
        <IconClose size={14} />
      </IconButton>
    </div>
  );
}
