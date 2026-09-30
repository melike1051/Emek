'use client';

import { EmptyState } from '@emek/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useSession } from '@/providers/AppProviders';

/** Müşteri ekranları müşteri profili ister; yalnızca sağlayıcı olan kullanıcıya yol gösterilir. */
export function RequireCustomer({ children }: { children: ReactNode }) {
  const { session } = useSession();
  if (session?.customer) return <>{children}</>;
  return (
    <EmptyState
      title="Hizmet almak için müşteri profili gerekli"
      description="Aynı hesapla hem hizmet verebilir hem hizmet alabilirsiniz."
      action={<Link href="/rol-sec">Müşteri profili oluştur</Link>}
    />
  );
}
