import type { Metadata } from 'next';
import { OpsScreen } from './OpsScreen';

export const metadata: Metadata = { title: 'Operasyon' };

export default function OpsPage() {
  return <OpsScreen />;
}
