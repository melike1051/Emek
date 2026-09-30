import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import styles from './auth.module.css';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <Logo />
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
