import type { Metadata } from 'next';
import { SessionGate } from '@/components/SessionGate';
import { RoleSelect } from './RoleSelect';

export const metadata: Metadata = { title: 'Rol seçimi' };

export default function RoleSelectPage() {
  return (
    <SessionGate>
      <RoleSelect />
    </SessionGate>
  );
}
