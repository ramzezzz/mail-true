/**
 * Общие кирпичи страниц настроек: заголовки, блоки, строки-переключатели,
 * таблица и полоска сохранения. Вынесены отдельно, чтобы у всех разделов
 * были одинаковые отступы и типографика — в привычных почтовых интерфейсах они одинаковые до
 * пикселя, и разъехаться им нельзя.
 */

import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import styles from './ui.module.css';

/** Заголовок раздела: h1 32/36 вес 500. */
export function SettingsTitle({ children }: { children: ReactNode }) {
  return <h1 className={styles.title}>{children}</h1>;
}

/** Подзаголовок блока: h2 28/32 вес 500. */
export function SettingsSubtitle({ children }: { children: ReactNode }) {
  return <h2 className={styles.subtitle}>{children}</h2>;
}

/** Пояснение под заголовком — серым. */
export function SettingsLead({ children }: { children: ReactNode }) {
  return <p className={styles.lead}>{children}</p>;
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      {title && <h2 className={styles.sectionTitle}>{title}</h2>}
      {description && <p className={styles.sectionDescription}>{description}</p>}
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

/** Ряд элементов в строку с переносом — кнопки, поля рядом друг с другом. */
export function SettingsRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return <div className={cx(styles.row, className)}>{children}</div>;
}

/** Полоска с кнопкой «Сохранить» и отметкой об успехе. */
export function SettingsActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

export function SettingsHint({ children }: { children: ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}

/** Сообщение об ошибке действия. */
export function SettingsError({ children }: { children: ReactNode }) {
  return (
    <p className={styles.error} role="alert">
      {children}
    </p>
  );
}

/** Состояние «здесь пока пусто». */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

/** Скелетон блока настроек, пока грузятся значения. */
export function SettingsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Загрузка настроек">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.skeleton} aria-hidden="true" />
      ))}
    </div>
  );
}

export { styles as settingsStyles };
