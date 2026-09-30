import type { ReactNode } from 'react';
import { Button } from './Button';
import styles from './States.module.css';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.state}>
      <h3 className={styles.title}>{title}</h3>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** Backend'in güvenli `message` alanı — ham exception metni asla. */
  message: string;
  /** Destek talebinde istenecek iz kimliği. */
  requestId?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = 'Bir sorun oluştu',
  message,
  requestId,
  onRetry,
}: ErrorStateProps) {
  return (
    <div className={`${styles.state} ${styles.error}`} role="alert">
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.description}>{message}</p>
      {requestId ? <p className={styles.reference}>Referans: {requestId}</p> : null}
      {onRetry ? (
        <Button variant="ghost" onClick={onRetry}>
          Tekrar dene
        </Button>
      ) : null}
    </div>
  );
}

export interface SkeletonProps {
  lines?: number;
  label?: string;
}

export function Skeleton({ lines = 3, label = 'Yükleniyor' }: SkeletonProps) {
  return (
    <div className={styles.skeleton} role="status" aria-live="polite">
      <span className="emek-visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className={styles.line} aria-hidden="true" />
      ))}
    </div>
  );
}
