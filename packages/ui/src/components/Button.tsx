import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** İstek sürerken butonu kilitler; çift gönderimi engeller. */
  loading?: boolean;
  fullWidth?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  icon,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth ? styles.fullWidth : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
}
