import type { HTMLAttributes } from 'react';
import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** `muted`: Warm Ecru yüzey; `plain`: beyaz yüzey. */
  tone?: 'plain' | 'muted';
  as?: 'section' | 'article' | 'div';
}

export function Card({ tone = 'plain', as: Tag = 'section', className, ...rest }: CardProps) {
  const classes = [styles.card, styles[tone], className].filter(Boolean).join(' ');
  return <Tag {...rest} className={classes} />;
}
