/**
 * Поля ввода раздела настроек: подпись сверху, поле высотой 36px
 * (--mt-size-field-height), радиус 8px, ошибка под полем красным.
 *
 * Отдельные компоненты вместо голых input нужны затем же, зачем Button:
 * ни одна страница не должна знать конкретных цветов и высот.
 */

import { forwardRef, useId, type ReactNode } from 'react';
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import styles from './Field.module.css';

interface FieldShellProps {
  label?: string | undefined;
  hint?: ReactNode;
  error?: string | null | undefined;
  htmlFor?: string;
  className?: string | undefined;
  children: ReactNode;
}

/** Обёртка «подпись — поле — пояснение/ошибка». */
export function FieldShell({ label, hint, error, htmlFor, className, children }: FieldShellProps) {
  return (
    <div className={cx(styles.shell, className)}>
      {label && (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : (
        hint && <span className={styles.hint}>{hint}</span>
      )}
    </div>
  );
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string | undefined;
  hint?: ReactNode | undefined;
  error?: string | null | undefined;
  /** Класс внешней обёртки (ширина колонки и т. п.). */
  wrapperClassName?: string | undefined;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, wrapperClassName, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      htmlFor={fieldId}
      className={wrapperClassName}
    >
      <input
        ref={ref}
        id={fieldId}
        className={cx(styles.control, error && styles.invalid, className)}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
    </FieldShell>
  );
});

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string | undefined;
  hint?: ReactNode | undefined;
  error?: string | null | undefined;
  wrapperClassName?: string | undefined;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, error, wrapperClassName, className, id, children, ...rest },
  ref,
) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      htmlFor={fieldId}
      className={wrapperClassName}
    >
      <select
        ref={ref}
        id={fieldId}
        className={cx(styles.control, styles.select, error && styles.invalid, className)}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
});

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string | undefined;
  hint?: ReactNode | undefined;
  error?: string | null | undefined;
  wrapperClassName?: string | undefined;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField(
    { label, hint, error, wrapperClassName, className, id, rows = 4, ...rest },
    ref,
  ) {
    const generated = useId();
    const fieldId = id ?? generated;
    return (
      <FieldShell
        label={label}
        hint={hint}
        error={error}
        htmlFor={fieldId}
        className={wrapperClassName}
      >
        <textarea
          ref={ref}
          id={fieldId}
          rows={rows}
          className={cx(styles.control, styles.textarea, error && styles.invalid, className)}
          {...rest}
        />
      </FieldShell>
    );
  },
);
