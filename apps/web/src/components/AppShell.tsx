'use client';

import { Avatar } from '@emek/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Session } from '@/lib/session';
import { useSession } from '@/providers/AppProviders';
import { Logo } from './Logo';
import styles from './AppShell.module.css';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.navIcon}>
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ICONS = {
  explore: icon('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z'),
  calendar: icon('M4 7h16v13H4zM4 11h16M8 3v4M16 3v4'),
  workshop: icon('M4 20V10l8-6 8 6v10zM9 20v-6h6v6'),
  profile: icon('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6'),
};

/** Menü, kullanıcının sahip olduğu profillerden türetilir (1 insan = 1 hesap, iki profil olabilir). */
export function navItemsFor(session: Session, pathname: string): NavItem[] {
  const inProvider = pathname.startsWith('/panel');
  if (inProvider || session.customer === null) {
    return [
      { href: '/panel', label: 'Atölyem', icon: ICONS.workshop },
      { href: '/panel/randevular', label: 'Randevular', icon: ICONS.calendar },
      { href: '/hesap', label: 'Profilim', icon: ICONS.profile },
    ];
  }
  return [
    { href: '/', label: 'Keşfet', icon: ICONS.explore },
    { href: '/randevular', label: 'Randevular', icon: ICONS.calendar },
    { href: '/hesap', label: 'Profilim', icon: ICONS.profile },
  ];
}

function isActive(href: string, pathname: string): boolean {
  if (href === '/' || href === '/panel') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const { session } = useSession();
  const pathname = usePathname();
  if (!session) return null;

  const items = navItemsFor(session, pathname);
  const name = session.customer?.displayName ?? session.provider?.displayName ?? '';
  const canSwitch = session.customer !== null && session.provider !== null;
  const inProvider = pathname.startsWith('/panel');

  return (
    <div className={styles.shell}>
      <a href="#icerik" className={styles.skip}>
        İçeriğe geç
      </a>
      <header className={styles.header}>
        <Link href={inProvider ? '/panel' : '/'} aria-label="Emek ana sayfa">
          <Logo />
        </Link>
        <p className={styles.title}>{title}</p>
        <div className={styles.headerActions}>
          {canSwitch ? (
            <Link href={inProvider ? '/' : '/panel'} className={styles.switch}>
              {inProvider ? 'Hizmet al' : 'Atölyem'}
            </Link>
          ) : null}
          <Link href="/hesap" aria-label="Hesabım">
            <Avatar name={name} size="sm" />
          </Link>
        </div>
      </header>
      <nav className={styles.nav} aria-label="Ana menü">
        {items.map((item) => {
          const active = isActive(item.href, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={styles.navItem}
              aria-current={active ? 'page' : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <main id="icerik" className={styles.main}>
        {children}
      </main>
    </div>
  );
}
