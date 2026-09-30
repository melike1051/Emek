import type { ReactNode } from 'react';
import { SessionGate } from '@/components/SessionGate';

export default function AppLayout({ children }: { children: ReactNode }) {
  return <SessionGate>{children}</SessionGate>;
}
