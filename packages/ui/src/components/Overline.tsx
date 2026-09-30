import type { ReactNode } from 'react';
import styles from './Overline.module.css';

/** Kategori çerçevesi: büyük harf, geniş aralık (ör. "TOPLULUK & ZANAAT"). */
export function Overline({ children }: { children: ReactNode }) {
  return <p className={styles.overline}>{children}</p>;
}
