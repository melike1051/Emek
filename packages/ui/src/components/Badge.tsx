import type { ReactNode } from 'react';
import styles from './Badge.module.css';

/** `trust`: doğrulama/güven (sage) · `highlight`: vurgu (terracotta) · `neutral` · `danger`. */
export type BadgeTone = 'trust' | 'highlight' | 'neutral' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', icon, children }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      {icon}
      {children}
    </span>
  );
}
