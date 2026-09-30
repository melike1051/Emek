import type { Metadata } from 'next';
import { RecoveryScreen } from './RecoveryScreen';

export const metadata: Metadata = { title: 'Kimlik kurtarma' };

export default function RecoveryPage() {
  return <RecoveryScreen />;
}
