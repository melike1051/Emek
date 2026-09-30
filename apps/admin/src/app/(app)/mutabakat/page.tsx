import type { Metadata } from 'next';
import { ReconciliationScreen } from './ReconciliationScreen';

export const metadata: Metadata = { title: 'Mutabakat' };

export default function ReconciliationPage() {
  return <ReconciliationScreen />;
}
