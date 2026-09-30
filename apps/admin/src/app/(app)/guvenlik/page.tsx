import type { Metadata } from 'next';
import { SafetyScreen } from './SafetyScreen';

export const metadata: Metadata = { title: 'Güvenlik' };

export default function SafetyPage() {
  return <SafetyScreen />;
}
