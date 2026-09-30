import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import styles from './TextField.module.css';

interface FieldChrome {
  label: string;
  hint?: string;
  /** Doluysa alan geçersiz işaretlenir ve mesaj ekran okuyucuya bağlanır. */
  error?: string;
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [error ? `${id}-error` : undefined, hint ? `${id}-hint` : undefined].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function Chrome({
  id,
  label,
  hint,
  error,
  children,
}: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type TextFieldProps = FieldChrome & InputHTMLAttributes<HTMLInputElement>;

export function TextField({ label, hint, error, id, className, ...rest }: TextFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <Chrome id={fieldId} label={label} hint={hint} error={error}>
      <input
        {...rest}
        id={fieldId}
        className={[styles.input, className].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, hint, error)}
      />
    </Chrome>
  );
}

export type TextAreaProps = FieldChrome & TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea({ label, hint, error, id, className, ...rest }: TextAreaProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <Chrome id={fieldId} label={label} hint={hint} error={error}>
      <textarea
        {...rest}
        id={fieldId}
        className={[styles.input, styles.textarea, className].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, hint, error)}
      />
    </Chrome>
  );
}
