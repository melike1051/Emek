'use client';

import { Badge } from '@emek/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useSession, useStaff } from '@/providers/AppProviders';
import { Logo } from './Logo';
import styles from './AppShell.module.css';

export const NAV_ITEMS = [
  { href: '/', label: 'Genel bakış' },
  { href: '/saglayicilar', label: 'Sağlayıcılar' },
  { href: '/kimlik-kurtarma', label: 'Kimlik kurtarma' },
  { href: '/randevular', label: 'Randevular' },
  { href: '/odemeler', label: 'Ödemeler' },
  { href: '/itirazlar', label: 'İtirazlar' },
  { href: '/guvenlik', label: 'Güvenlik' },
  { href: '/operasyon', label: 'Operasyon' },
  { href: '/mutabakat', label: 'Mutabakat' },
] as const;

export function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { signOut } = useSession();
  const { canWrite } = useStaff();
  const pathname = usePathname();

  return (
    <div className={styles.shell}>
      <a href="#icerik" className={styles.skip}>
        İçeriğe geç
      </a>
      <header className={styles.header}>
        <Link href="/" aria-label="Operasyon ana sayfa" className={styles.brand}>
          <Logo />
          <span className={styles.product}>Operasyon</span>
        </Link>
        <div className={styles.headerActions}>
          {canWrite ? (
            <Badge tone="trust">ADMIN</Badge>
          ) : (
            <Badge tone="neutral">SUPPORT · salt okunur</Badge>
          )}
          <button type="button" className={styles.signOut} onClick={() => void signOut()}>
            Çıkış
          </button>
        </div>
      </header>
      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Operasyon menüsü">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={styles.navItem}
              aria-current={isActive(item.href, pathname) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <main id="icerik" className={styles.main}>
          <h1 className={styles.title}>{title}</h1>
          {children}
        </main>
      </div>
    </div>
  );
}
